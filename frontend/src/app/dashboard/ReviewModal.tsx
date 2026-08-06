'use client';

/** 검토 모달 — 노트는 검토→심의→발행(게이트 재검사), 상담은 담당 PB 승인/반려.
 *
 *  상태 전이는 전부 백엔드가 원천이다(감사로그·게이트 재검사 포함). 화면은 결과를 받아
 *  다시 그릴 뿐, 여기서 상태를 임의로 바꾸지 않는다 — 시안은 목업이라 로컬에서 바꿨지만
 *  실화면에서 그렇게 하면 DB와 화면이 갈라진다.
 */

import { useState } from 'react';
import { apiPost, errorMessage, fmtKRW, hhmm, notePdfUrl } from './api';
import F1Chat, { type ChatKeep, type ChatPrefill } from './F1Chat';
import PrepMemo from './PrepMemo';
import {
  ACK_REASONS,
  ackBadgeLabel,
  ackReasonLabel,
  ACTOR,
  actorLabel,
  DISCARD_REASONS,
  MY_PB,
  PB_MARK_LABEL,
  PILL,
  PORTFOLIO_CHIPS,
  REJECT_REASONS,
  RISK,
  WATERMARK,
  type Brief,
  type Customer,
  type NoteAck,
  type NoteDetail,
  type NoteMark,
  type NoteSentence,
  type NoteSource,
  type NoteWaiver,
  type PbMark,
  type QueueChat,
  type Role,
} from './types';
import {
  buildFootnotes,
  FootnoteList,
  FootnoteRefs,
  sourceKey,
  useFootnoteJump,
} from './sources';

type Result = { ok?: string; blocked?: string };

/** 옛 노트는 sources 없이 source만 있다 — 둘 다 읽는다. */
function sourcesOf(s: NoteSentence): NoteSource[] {
  return s.sources ?? (s.source ? [s.source] : []);
}

/** 검토 순서는 노트의 서술 순서가 아니다 — 손댈 것이 위, 읽기만 할 것이 아래다.
 *  0 UNSOURCED: 근거 없는 사실 주장이라 가장 먼저 확인한다.
 *  1 해석·전망: 각주가 없는 것이 규칙상 맞지만, 발행 전 사람 판단은 필요하다.
 *  2 공시·시세 인용 · 3 뉴스 인용: 읽기만 할 근거 문장은 아래로 모은다.
 *  4 PB 제거: **맨 아래**다(2026-08-03). 준법 확인 셀렉트가 잠겨 있어 이 화면에서 할 일이
 *    없는 문장인데, 미인용이라 그냥 두면 0등급으로 맨 위에 서서 손댈 것을 가린다.
 *    본문에서 지우지는 않는다 — 무엇을 빼기로 했는지도 감사 대상이다.
 *  정렬은 stable이라 같은 등급 안에서는 원문 순서가 유지되고, 확인(ack)은 **원본 인덱스**로
 *  저장되므로 이 정렬에 영향받지 않는다(HANDOFF §1-2). */
function reviewTier(s: NoteSentence, mark?: NoteMark): number {
  if (mark?.mark === 'remove') return 4;
  const srcs = sourcesOf(s);
  if (!srcs.length) return s.kind === 'interpretation' ? 1 : 0;
  return srcs.some((x) => x.type === 'news') ? 3 : 2;
}

/** 문장 목록. `rows`의 i는 **원본 sentences 배열의 인덱스**다 — 확인 기록(ack)이 그
 *  인덱스로 저장되므로, 소제목·고지문구를 걸러낸 뒤의 순번을 쓰면 다른 문장을 가리킨다. */
/** 금지 표현 예외 한 줄 — 사유 입력 + 적용/되돌리기.
 *
 *  입력값은 이 컴포넌트가 들고 있다(부모에 올리면 문장 하나 칠 때마다 목록 전체가 다시
 *  그려진다). 예외가 걸린 뒤에는 입력 대신 **사유를 그대로 보여준다** — 무엇을 근거로
 *  통과시켰는지가 화면에서 사라지면 감사로그를 열어야 알 수 있다. */
function WaiveRow({
  phrase,
  waiver,
  onWaive,
}: {
  phrase: string;
  waiver?: NoteWaiver;
  onWaive: (reason: string | null) => void;
}) {
  const [reason, setReason] = useState('');
  if (waiver) {
    return (
      <div className="waive done">
        <span className="waive-why">{waiver.reason}</span>
        <button className="btn-quiet" onClick={() => onWaive(null)}>
          예외 되돌리기
        </button>
      </div>
    );
  }
  return (
    <div className="waive">
      <input
        className="waive-in"
        // 고객 이야기가 아니라 규정 판단이지만, 이 앱의 입력창은 전부 자동완성을 끈다
        // (브라우저 저장소에 업무 문장이 쌓이지 않게 — F1 입력창과 같은 규칙).
        autoComplete="off"
        placeholder={`'${phrase}'를 통과시키는 사유 (감사로그에 남습니다)`}
        value={reason}
        maxLength={200}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && reason.trim()) onWaive(reason.trim());
        }}
      />
      <button
        className="btn"
        disabled={!reason.trim()}
        onClick={() => onWaive(reason.trim())}
      >
        예외 적용
      </button>
    </div>
  );
}

function SentenceRows({
  rows,
  acks,
  canAck,
  onAck,
  marks,
  canMark,
  onMark,
  blocking,
  waivers,
  onWaive,
}: {
  rows: { s: NoteSentence; i: number }[];
  acks: NoteAck[];
  /** 준법 + 심의 단계에서만 확인할 수 있다 */
  canAck: boolean;
  onAck: (index: number, reason: string | null) => void;
  marks: NoteMark[];
  /** PB + 검토 단계에서만 판정할 수 있다 — 확인(ack)과 단계가 겹치지 않는다 */
  canMark: boolean;
  onMark: (index: number, mark: PbMark | null) => void;
  /** 금지 표현을 담은 문장 — 백엔드가 찾아 준다(`blocking_phrases`). */
  blocking: { index: number; phrase: string }[];
  waivers: NoteWaiver[];
  /** 사유는 **자유 입력**이다. null이면 예외를 되돌린다. */
  onWaive: (index: number, reason: string | null) => void;
}) {
  const ackOf = new Map(acks.map((a) => [a.index, a]));
  const markOf = new Map(marks.map((m) => [m.index, m]));
  const phraseOf = new Map(blocking.map((b) => [b.index, b.phrase]));
  const waiverOf = new Map(waivers.map((w) => [w.index, w]));
  /* 출처는 **번호 각주**로 나간다(2026-07-28). 예전에는 문장 옆에 날짜 배지를 붙였는데,
     `.stext`가 55%로 눌려 배지 2개짜리 문장이 4줄로 흘렀다(배지 없는 문장은 2줄).
     번호만 남기면 문장이 폭을 다 쓰고, 같은 출처를 여러 번 인용해도 번호가 하나라
     중복 배지도 사라진다. 원문 링크·날짜·기사 제목은 아래 목록이 전부 보여준다. */
  const fn = buildFootnotes(rows);
  const { flash, jump } = useFootnoteJump();
  return (
    <div className="srows">
      {rows.map(({ s, i }) => {
        const srcs = sourcesOf(s);
        const ack = ackOf.get(i);
        const mark = markOf.get(i);
        return (
          <div className="srow" key={i}>
            {/* 표시는 전부 **문장 흐름 안에** 둔다. `.sbadges`를 형제 칸으로 두면
                `.stext`가 폭을 다 쓰는 순간 배지가 통째로 아랫줄로 밀려, 해석 문장마다
                빈 줄이 하나씩 생긴다(실측: 모달 높이 988→1336px). 인라인이면 문장
                끝에 붙어 흐르고 줄이 모자랄 때만 자연스럽게 넘어간다. */}
            <span className="stext">
              {s.text}
              <FootnoteRefs
                ns={srcs.map((x) => fn.numberOf.get(sourceKey(x))!)}
                onJump={jump}
              />
              {!srcs.length &&
                (ack ? (
                  // 사람이 확인한 문장 — 누가·언제·무슨 사유였는지가 배지에 남는다.
                  <span
                    /* `제거`는 **`PB 제거`와 같은 적색 배지**로 단다(`.un`) — 문장을 뺀다는
                       같은 판단이라 색까지 같아야 둘이 한 종류로 읽히고, 확인(통과)과는
                       색으로 갈린다. 나머지 사유는 그대로 `.ack`(확인함 · 사유). */
                    className={`sbadge inline ${ack.reason === '제거' ? 'un' : 'ack'}`}
                    title={`${actorLabel(ack.actor)} · ${hhmm(ack.ts)} 확인`}
                  >
                    {ackBadgeLabel(ack.reason)}
                  </span>
                ) : s.kind === 'interpretation' ? (
                  // 각주가 없는 게 규칙대로인 문장. UNSOURCED로 칠하면 검토자가 위반으로
                  // 오해한다 — 다만 판단은 사람이 하도록 큐에는 그대로 올라간다.
                  <span
                    className="sbadge itp inline"
                    title="해석·전망 문장은 출처 각주 대상이 아닙니다"
                  >
                    해석
                  </span>
                ) : (
                  <span className="sbadge un inline">UNSOURCED</span>
                ))}
              {/* PB 판정은 위 배지를 **대신하지 않고 뒤에 붙는다** — UNSOURCED·해석은
                  "왜 이 문장을 보고 있나"이고 이건 "보고 나서 어떻게 하기로 했나"라,
                  하나가 다른 하나를 지우면 판단의 근거가 화면에서 사라진다.
                  (확인 배지가 대체하는 것과 다른 이유: 저건 게이트를 여는 조작이라
                  미인용이라는 상태 자체가 풀린다.) */}
              {/* 출처 있는 문장을 준법이 뺀 경우 — 미인용 배지 자리가 없으므로 여기서
                  따로 단다. 미인용 문장은 위 블록이 이미 `준법 제거`를 그린다. */}
              {srcs.length > 0 && ack?.reason === '제거' && (
                <span
                  className="sbadge un inline"
                  title={`${actorLabel(ack.actor)} · ${hhmm(ack.ts)} 제거`}
                >
                  준법 제거
                </span>
              )}
              {!srcs.length && mark && (
                <span
                  className={`sbadge inline ${mark.mark === 'remove' ? 'un' : 'pbok'}`}
                  title={`${actorLabel(mark.actor)} · ${hhmm(mark.ts)} 판정`}
                >
                  {PB_MARK_LABEL[mark.mark]}
                </span>
              )}
              {/* 금지 표현 — **왜 이 문장이 막고 있는지**를 문장 흐름 안에서 말한다.
                  예외가 걸리면 같은 자리에서 배지가 바뀐다(사유는 title에 그대로). */}
              {phraseOf.has(i) &&
                (waiverOf.has(i) ? (
                  <span
                    className="sbadge ack inline"
                    title={`${actorLabel(waiverOf.get(i)!.actor)} · ${hhmm(
                      waiverOf.get(i)!.ts,
                    )} 예외 · ${waiverOf.get(i)!.reason}`}
                  >
                    예외 승인 · {phraseOf.get(i)}
                  </span>
                ) : (
                  <span
                    className="sbadge un inline"
                    title="투자권유·광고성 표현으로 발행이 막힙니다"
                  >
                    투자권유 표현 · {phraseOf.get(i)}
                  </span>
                ))}
            </span>
            {/* 확인 UI는 미인용 문장에만 붙는다. 출처가 있는 문장은 애초에 게이트를
                막고 있지 않으므로 풀 것도 없다. 이것만 조작이라 문장 밖에 남긴다. */}
            {/* **`PB 승인` 문장에만 열린다(2026-08-03).** 준법이 여는 게이트는 "이대로
                내보내도 되나"의 답인데, PB가 빼기로 했거나(제거) 아직 안 본 문장에는 그
                질문이 성립하지 않는다.
                `PB 제거`에는 셀렉트를 **아예 그리지 않는다** — 빼기로 이미 결론이 난
                문장이라 고를 것이 없고, 잠긴 셀렉트를 남겨 두면 맨 아래 줄에 조작처럼
                보이는 것이 하나 서 있게 된다(`.acksel:disabled`로 눌러 죽여 봤지만
                여전히 눌러 보게 된다). 판정이 없는 문장은 잠근 채로 남긴다 — 그건
                "여기서 못 한다"가 아니라 "PB가 아직 안 봤다"라 자리가 비면 안 된다.
                ⚠️ 어느 쪽이든 **발행 차단에는 그대로 남는다** — 푸는 길은 PB가 검토
                   단계에서 판정을 `승인`으로 바꾸는 것뿐이다(위 ackbar가 개수를 말한다). */}
            {canAck && !srcs.length && mark?.mark !== 'remove' && (
              <span className="sbadges">
                <select
                  className="acksel"
                  aria-label="확인 사유"
                  disabled={mark?.mark !== 'approve'}
                  title={
                    mark?.mark === 'approve'
                      ? undefined
                      : 'PB 판정이 없는 문장입니다 — PB 승인 문장만 확인할 수 있습니다'
                  }
                  value={ack?.reason ?? ''}
                  onChange={(e) => onAck(i, e.target.value || null)}
                >
                  <option value="">확인 안 함</option>
                  {ACK_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {ackReasonLabel(r)}
                    </option>
                  ))}
                </select>
              </span>
            )}
            {/* 출처 있는 문장에 준법이 쓰는 조작은 **`제거` 하나뿐**이다. 확인(사유)은
                미인용 문장을 여는 조작이라 여기서는 뜻이 없고, 남는 판단은 "이 문장을
                최종본에 둘 것인가"뿐이라 셀렉트가 아니라 토글 버튼으로 둔다(PB 판정
                버튼과 같은 모양·같은 규칙 — 다시 누르면 풀린다).
                필요한 이유: 지연시세 고지처럼 **문장을 고쳐야 풀리는 위반**이 출처 있는
                문장에서 나면, 뺄 길이 없는 한 준법에게 남는 선택지가 반려뿐이었다. */}
            {canAck && srcs.length > 0 && (
              <span className="sbadges">
                <button
                  className="markbtn remove"
                  aria-pressed={ack?.reason === '제거'}
                  title={
                    ack?.reason === '제거'
                      ? '다시 누르면 되돌립니다'
                      : '이 문장을 최종본에서 뺍니다'
                  }
                  onClick={() => onAck(i, ack?.reason === '제거' ? null : '제거')}
                >
                  제거
                </button>
              </span>
            )}
            {/* 금지 표현 예외 — **이 앱에서 유일하게 사유를 손으로 적는 자리**다.
                다른 사유(반려·보류·확인)는 전부 고정값인데 여기만 다른 이유: 통과시키는
                근거가 건마다 다르다("제3자 목표주가의 사실 보도"는 다음 건에 안 맞는다).
                ⚠️ 되돌릴 수 있는 조작이라 무장 단계를 두지 않는다(`.acksel`과 같은 규칙).
                ⚠️ 규칙을 여는 조작이므로 **심의 단계의 준법에게만** 그린다(canAck과 같은 조건).
                ⚠️ 이건 금지 표현 규칙 하나만 연다 — 미인용·지연시세는 그대로 남는다. */}
            {canAck && phraseOf.has(i) && (
              <WaiveRow
                phrase={phraseOf.get(i)!}
                waiver={waiverOf.get(i)}
                onWaive={(reason) => onWaive(i, reason)}
              />
            )}
            {/* PB 판정 — 셀렉트가 아니라 버튼 둘이다. 고를 것이 둘뿐이라 목록을 열어
                고르는 것보다 한 번 누르는 게 짧고, 지금 무엇으로 판정돼 있는지가
                접힌 목록 안이 아니라 눌린 버튼으로 그대로 보인다.
                **누른 것을 다시 누르면 판정이 풀린다** — 확인 셀렉트의 `확인 안 함`에
                해당하는 출구이고, 없으면 잘못 누른 판정을 되돌릴 방법이 없다.
                (확인과 달리 두 번 누르는 무장 단계를 두지 않는 이유도 같다: 되돌릴 수 있는
                조작은 즉시 실행이 맞다 — `.acksel`과 같은 규칙.) */}
            {canMark && !srcs.length && (
              <span className="sbadges">
                {(['remove', 'approve'] as const).map((m) => (
                  <button
                    key={m}
                    className={`markbtn ${m}`}
                    aria-pressed={mark?.mark === m}
                    title={
                      mark?.mark === m
                        ? '다시 누르면 판정이 풀립니다'
                        : PB_MARK_LABEL[m]
                    }
                    onClick={() => onMark(i, mark?.mark === m ? null : m)}
                  >
                    {m === 'remove' ? '제거' : '승인'}
                  </button>
                ))}
              </span>
            )}
          </div>
        );
      })}
      <FootnoteList items={fn.items} flash={flash} />
    </div>
  );
}

/* ── 노트 모달 ────────────────────────────────────────────── */
type Action = {
  label: string;
  ok: boolean;
  deny?: string;
  danger?: boolean;
  /** 사유를 골라야 실행되는 동작(반려·보류). 있으면 **두 번 누르는 동작**이 된다. */
  reasons?: readonly string[];
  run: (reason: string) => Promise<Result>;
};

function ActionsRow({
  acts,
  onDone,
}: {
  acts: Action[];
  onDone: (r: Result) => void;
}) {
  const [busy, setBusy] = useState(false);
  /* 사유가 필요한 동작은 **두 번 누른다**: 처음 누르면 사유 셀렉트가 열리고(armed),
     사유를 고른 뒤 다시 눌러야 실행된다.
     - 셀렉트를 처음부터 깔아 두지 않는 이유: 아직 하지 않기로 한 조작이 화면에 먼저 서서
       기본 동작(확인·발행)과 무게가 같아 보인다. 거절은 있어야 하지만 권하는 길은 아니다.
     - 사유를 고르는 순간 바로 실행하지 않는 이유: 보류·반려는 화면에서 되돌릴 수 없다.
       (문장 확인 `.acksel`은 즉시 실행이 맞다 — 그건 언제든 되돌릴 수 있다.)
     armed는 한 번에 하나뿐이라 사유 값도 하나면 된다. */
  const [armed, setArmed] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const disarm = () => {
    setArmed(null);
    setReason('');
  };
  if (!acts.length) return null;
  /* **못 하는 조작은 아예 그리지 않는다.** 예전엔 비활성 버튼을 남겨 두고 옆에 사유를
     적었는데, 심의중 노트를 PB가 열면 `발행`·`반려`가 회색으로 서 있어 "누를 수 있는데
     지금은 안 되는 것"처럼 보였다 — 그 둘은 이 사람의 조작이 아니라 준법의 조작이다.
     남는 건 사유 한 줄이고, 그게 "여기서 당신이 할 일은 없다"를 정확히 말한다.
     ⚠️ 사유는 **거절된 것 중 첫 번째**에서 가져온다 — 한 상태의 동작들은 권한 조건이
        같아서(전부 PB이거나 전부 준법) 사유도 하나면 된다. */
  const allowed = acts.filter((a) => a.ok);
  const denyMsg = acts.find((a) => !a.ok && a.deny)?.deny;
  if (!allowed.length) {
    return denyMsg ? (
      <div className="m-actions">
        {/* `.hint`가 아니라 전용 클래스다 — 이 줄은 조작 줄을 통째로 대신하는 문장이라
            같은 자리의 버튼만 한 무게가 있어야 한다(`.hint`는 12px 곁말이다). */}
        <span className="m-deny">{denyMsg}</span>
      </div>
    ) : null;
  }
  /* 무장하면 **그 동작만 남기고 나머지는 감춘다.** 셋(사유·실행·취소)이 한 덩어리로
     왼쪽부터 논리 순서로 서고, 셀렉트가 어느 버튼의 것인지 헷갈릴 여지가 없어진다.
     예전엔 `[발행] [사유 선택] [반려] [취소]`로 나와서 반려의 셀렉트가 발행에 붙어 보였다.
     이미 반려를 하기로 한 상태이므로 다른 갈래를 같이 열어 둘 이유도 없다. */
  const shown = armed ? allowed.filter((a) => a.label === armed) : allowed;
  return (
    <div className="m-actions">
      {shown.map((a, i) => {
        const isArmed = armed === a.label;
        return (
          <span key={i} style={{ display: 'contents' }}>
            {isArmed && a.reasons && (
              <select
                className="acksel"
                aria-label={`${a.label} 사유`}
                // 누르자마자 초점이 여기로 온다 — 키보드만 쓰는 사람에게 "다음은 이것"을
                // 알리는 신호이자, 마우스 사용자에게도 클릭 한 번을 아껴 준다.
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              >
                <option value="">사유 선택</option>
                {a.reasons.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            )}
            <button
              className={`btn ${a.danger ? 'danger' : 'primary'}`}
              // 무장 상태에서 사유가 비면 잠근다 — 사유는 감사 대상이라 빈 값으로 못 지나간다.
              // (권한 없는 동작은 여기 오지 않는다 — 위에서 걸러 낸다.)
              disabled={busy || (isArmed && !reason)}
              onClick={async () => {
                if (a.reasons && !isArmed) {
                  setArmed(a.label);
                  setReason('');
                  return;
                }
                setBusy(true);
                onDone(await a.run(reason));
                setBusy(false);
                disarm();
              }}
            >
              {/* 무장 뒤에도 라벨은 그대로다. 눌렀다는 신호는 라벨이 아니라 **줄이 통째로
                  바뀌는 것**이 낸다 — 다른 동작이 사라지고 사유 셀렉트·취소가 들어선다. */}
              {a.label}
            </button>
            {isArmed && (
              <button className="btn" onClick={disarm}>
                취소
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

export function NoteModal({
  note,
  role,
  onClose,
  onChanged,
  toast,
}: {
  note: NoteDetail;
  role: Role;
  onClose: () => void;
  onChanged: () => Promise<NoteDetail | null>;
  toast: (m: string) => void;
}) {
  // 발행되면 이 노트는 **큐**에서 빠진다(처리할 일이 아니게 되므로). 부모의 노트 목록은
  // /api/notes라 발행분도 남지만, 결과 메시지를 계속 보여주려면 모달이 자기 사본을 들고
  // 있어야 한다. 다른 노트를 열면 부모가 key로 리마운트하므로 prop→state 동기화는 불필요.
  const [current, setCurrent] = useState(note);
  const [res, setRes] = useState<Result>({});

  const actor = ACTOR[role];
  const [label, cls] = PILL[current.status] ?? [current.status, ''];

  const act = async (action: string, reason?: string): Promise<Result> => {
    const r = await apiPost(`/api/notes/${current.id}/${action}`, {
      actor,
      ...(reason ? { reason } : {}),
    });
    if (!r.ok) return { blocked: errorMessage(r.body) };
    if (action === 'publish') {
      toast('발행했습니다. 감사로그에 남았습니다');
      return { ok: '게이트를 통과해 발행되었습니다.' };
    }
    /* 반려·폐기는 `ok`(초록 ✓ 상자)로 알리지 않는다 — 동작은 성공했지만 결과는 "통과"가
       아니라서 체크 표시가 뜻을 뒤집는다. 토스트로 알리고, 바뀐 상태는 머리말 알약이 말한다. */
    if (action === 'reject') {
      toast(`검토중으로 반려했습니다 (${reason})`);
    }
    if (action === 'discard') {
      toast(`보류했습니다. 처리 대기에서 빠집니다 (${reason})`);
    }
    return {};
  };

  /* 노트를 만든 사람이 PB이므로 사실 확인도 PB가 한다 — 예전엔 두 단계가 '관리자'
     권한이었는데, 1인용 대시보드에는 관리자가 없다. 마지막 단계(발행)만 준법에게 남긴다:
     **만드는 사람과 통과시키는 사람이 갈리는 지점이 여기 하나**이고, 그게 이 제품의 핵심이다.
     그래서 PB 화면에서 심의중 노트는 상태만 보이고 버튼이 없다(아래 deny 문구가 이유를 말한다). */
  /* 초안(`draft`) 갈래는 없앴다(2026-08-03) — 노트는 **검토중으로 만들어진다**(backend
     db.py SCHEMA 주석). 여기 있던 `사실 확인` 버튼은 상태를 한 칸 옮기는 것 말고 하는 일이
     없어서, 문장을 훑기도 전에 클릭을 한 번 요구하고 있었다. 사람이 판단하는 지점은
     그대로다: 문장 판정(승인·제거) → `확인`(심의로) 또는 `보류`(종결). */
  /* 각 단계마다 **앞으로 가는 길과 거절하는 길이 같이 있다.** 거절이 없으면 이 화면은
     "사람이 확인한다"가 아니라 "사람이 눌러 준다"가 된다 — 게이트 차단(publish_blocked)은
     기계의 거절이라 사람의 판단을 대신하지 못한다.
     두 거절은 뜻이 다르다: **폐기**(검토중, PB)는 고쳐 쓸 게 아니라는 종결이고,
     **반려**(심의중, 준법)는 고쳐서 다시 올리라는 되돌림이다. */
  const actions: Action[] =
    current.status === 'review'
      ? [
          {
            label: '확인',
            ok: role === 'pb',
            deny: '심의 요청은 PB가 합니다.',
            run: () => act('deliberate'),
          },
          {
            label: '보류',
            ok: role === 'pb',
            danger: true,
            reasons: DISCARD_REASONS,
            run: (reason) => act('discard', reason),
          },
        ]
      : current.status === 'deliberation'
        ? [
            {
              label: '발행',
              ok: role === 'comp',
              deny: '준법 심의 중입니다.',
              run: () => act('publish'),
            },
            {
              label: '반려',
              ok: role === 'comp',
              danger: true,
              reasons: REJECT_REASONS,
              run: (reason) => act('reject', reason),
            },
          ]
        : [];

  /* 단계별 담당자 줄("확인 PB · 심의 요청 PB · 발행 —")은 뺐다(2026-07-28).
     역할이 `PB`/`준법` 둘뿐이라 어느 노트에서나 같은 값이 나왔고, "어디까지 갔나"는
     제목 옆 상태 알약이 이미 말한다. **누가 언제 했는지는 감사로그가 정본**이고
     준법·감시 탭의 노트별 조회에서 전건을 본다(모달에 원장을 복제하지 않는다).
     ⚠️ 사람 이름이 여럿 생기면 이 줄이 다시 정보가 된다 — 그때 되살릴 것. */

  // 소제목과 고지문구·구분선은 검토 대상 문장이 아니다(백엔드 게이트와 같은 기준).
  // 원본 인덱스를 들고 다닌다 — 확인 기록이 그 인덱스로 저장되기 때문이다.
  // 정렬은 reviewTier: 미인용(확인 필요) → 공시·시세 → 뉴스. 노트를 산문으로 읽는 화면이
  // 아니라 **문장별로 출처를 확인하는 화면**이라 서술 순서보다 처리 순서를 따른다.
  // PB 판정은 정렬(제거는 맨 아래)과 확인 셀렉트의 잠금에 둘 다 쓰인다 — 한 번만 만든다.
  const markOf = new Map((current.marks ?? []).map((m) => [m.index, m]));
  const body = current.sentences
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !s.is_heading && s.kind !== 'boilerplate')
    .sort(
      (a, b) =>
        reviewTier(a.s, markOf.get(a.i)) - reviewTier(b.s, markOf.get(b.i)),
    );

  /* 각주를 붙일 수 없는 문장(해석·고지·데이터 설명)이 실제로 있어서, 게이트가 그걸 전부
     잠그면 사람이 열 방법이 없다 — 그래서 준법이 사유를 적어 확인하면 미인용 집계에서
     빠진다. 확인은 **심의 단계에서만**(검토 단계에서 미리 풀면 검토가 형식이 된다) 그리고
     발행과 같은 권한(준법)에게만 연다. */
  const canAck = role === 'comp' && current.status === 'deliberation';
  const acked = new Set(current.acks.map((a) => a.index));
  /* 발행을 막는 문장 = 출처가 없고, 확인되지도 않았고, **PB가 빼기로 하지도 않은** 것.
     `PB 제거`를 빼는 것이 백엔드 게이트와 같은 규칙이다(main.`_gate_exempt`) — 여기서
     다르게 세면 화면은 "1개 남았다"는데 발행은 되거나 그 반대가 된다. */
  const unacked = body.filter(
    ({ s, i }) =>
      !(s.sources?.length || s.source) &&
      !acked.has(i) &&
      markOf.get(i)?.mark !== 'remove',
  );
  const blocking = unacked.length;
  /* 그중 **이 화면에서 풀 수 없는 것** = PB 판정이 없는 문장. 확인 셀렉트가 `PB 승인`
     문장에만 열리므로 준법이 손댈 수 없는데 게이트는 그대로 센다 — 몇 개가 그런지
     말하지 않으면 "왜 발행이 안 되는지"를 셀렉트를 눌러 보고 알아내야 한다.
     (`PB 제거`는 위에서 이미 빠졌다 — 세지도 않고 막지도 않는다.) */
  const lockedBlocking = unacked.filter(({ i }) => !markOf.get(i)).length;
  /* 미인용 말고도 막는 게 있다 — **금지 표현**. 예전에는 미인용만 세고 "이제 발행할 수
     있습니다"라고 적어서, 다 확인하고도 발행이 409로 막히는 화면이 있었다(노트 #33 실측).
     ⚠️ 여기서 새로 판정하지 않는다: 백엔드가 준 `blocking_phrases`에서 예외가 걸린 것만
        뺀다(금지 표현 목록을 프론트로 복사하면 컴플라이언스 어휘가 두 곳으로 갈린다). */
  const waivedSet = new Set((current.waivers ?? []).map((w) => w.index));
  const phraseBlocking = (current.blocking_phrases ?? []).filter(
    (b) => !waivedSet.has(b.index),
  ).length;

  /** 금지 표현 예외. ack과 같은 모양이다 — 응답의 위반 목록으로 화면을 다시 그린다. */
  const waive = async (index: number, reason: string | null) => {
    const r = await apiPost(`/api/notes/${current.id}/waive`, {
      actor,
      index,
      reason,
    });
    if (!r.ok) {
      setRes({ blocked: errorMessage(r.body) });
      return;
    }
    const fresh = await onChanged();
    if (fresh) setCurrent(fresh);
  };

  const ack = async (index: number, reason: string | null) => {
    const r = await apiPost(`/api/notes/${current.id}/ack`, {
      actor,
      index,
      reason,
    });
    if (!r.ok) {
      setRes({ blocked: errorMessage(r.body) });
      return;
    }
    const fresh = await onChanged();
    if (fresh) setCurrent(fresh);
  };

  /* PB 판정 — 노트가 아직 PB 손에 있는 동안(검토중) 각주 없는 문장을 훑는다.
     확인(ack)과 단계가 겹치지 않으므로 한 문장에 두 조작이 같이 서는 일은 없다.
     ⚠️ 이 판정은 **게이트를 열지 않는다**(backend PB_MARKS 주석) — 미인용 문장을
        발행 가능하게 만드는 건 준법의 확인뿐이다. 여기서 바뀌는 건 표시와 감사로그다.
     ⚠️ 다만 준법의 확인 셀렉트는 `PB 승인` 문장에만 열리므로(위 SentenceRows 주석),
        **여기서 판정하지 않고 올린 문장은 준법이 풀 수 없다.** 여기가 그 단계다. */
  const canMark = role === 'pb' && current.status === 'review';

  const mark = async (index: number, m: PbMark | null) => {
    const r = await apiPost(`/api/notes/${current.id}/mark`, {
      actor,
      index,
      mark: m,
    });
    if (!r.ok) {
      setRes({ blocked: errorMessage(r.body) });
      return;
    }
    const fresh = await onChanged();
    if (fresh) setCurrent(fresh);
  };

  return (
    <>
      <div className="m-head">
        <h3>
          {current.corp_name}({current.stock_code}) 실적·공시 노트
        </h3>
        {/* 노트 번호는 제목과 상태 사이에 회색으로 낀다 — 감사로그·큐와 대조할 때만 쓰는
            식별자라 제 줄을 차지할 무게가 아니다. aria-label로 "#13"이 번호임을 밝힌다
            (기호만 읽으면 스크린리더가 "우물 정 13"으로 흘린다). */}
        <span className="m-id" aria-label={`노트 번호 ${current.id}`}>
          #{current.id}
        </span>
        <span className={`pill ${cls}`}>{label}</span>
        <button className="m-close" aria-label="닫기" onClick={onClose}>
          ×
        </button>
      </div>
      {/* 여기부터가 스크롤 영역이다 — 위 제목줄만 고정이라 긴 노트에서도 닫기 버튼이
          사라지지 않는다. */}
      <div className="m-body">
        {res.blocked && <div className="vbox">⛔ {res.blocked}</div>}
        {res.ok && <div className="okbox">✓ {res.ok}</div>}
        {/* 심의 단계에서 "무엇이 남아서 막고 있는가"를 문장 목록 위에 먼저 말한다 —
            발행 버튼을 눌러 409를 받고 나서야 아는 건 검토 화면이 할 일이 아니다. */}
        {current.status === 'deliberation' && (
          <div className={blocking ? 'ackbar' : 'ackbar done'}>
            {blocking
              ? `출처 없는 문장 ${blocking}개가 발행을 막고 있습니다. 각주를 붙일 수 없는 문장이면 사유를 골라 확인하세요.` +
                (lockedBlocking
                  ? ` 그중 ${lockedBlocking}개는 PB 판정이 없어 잠겨 있습니다 — PB가 검토 단계에서 판정해야 풀립니다.`
                  : '')
              : phraseBlocking
                ? `투자권유·광고성 표현 ${phraseBlocking}개가 남아 있습니다. 인용이라면 사유를 적어 예외로 통과시키고, 아니면 그 문장을 빼세요.`
                : '미인용 문장을 모두 확인했습니다. 이제 발행할 수 있습니다.'}
            {current.acks.length > 0 &&
              ` (확인 ${current.acks.length}개, 감사로그에 기록됨)`}
          </div>
        )}
        <SentenceRows
          rows={body}
          acks={current.acks}
          canAck={canAck}
          onAck={ack}
          blocking={current.blocking_phrases ?? []}
          waivers={current.waivers ?? []}
          onWaive={waive}
          marks={current.marks ?? []}
          canMark={canMark}
          onMark={mark}
        />
        {/* 필수 고지 — 출처 목록 **아래**, 조작 줄 위. 페이지 전체 고지(.disclaimer)가
            맨 아래 한 줄인 것과 같은 배치다: 문서를 다 읽은 자리에서 "이건 미검증 초안"을
            마지막으로 말한다. ⚠️ 조작 줄보다 아래로 내리지 말 것 — 눌러야 할 것이 고지에
            묻힌다. 스크롤 밖 고정 자리에도 두지 않는다(머리말이 세 줄이 되고, 바로 아래
            ackbar와 같은 무게의 덩어리가 둘 생긴다). */}
        <div className="wm">{WATERMARK}</div>
        <ActionsRow
          acts={actions}
          onDone={async (r) => {
            setRes(r);
            const fresh = await onChanged();
            if (fresh) setCurrent(fresh);
          }}
        />
        {/* 발행분에서만 서는 조작 — 이 상태의 노트에는 상태 전이가 없어서 조작 줄이
            비어 있었다. **PB·준법 둘 다에게 낸다**: 통과시키는 사람은 준법이지만 상담에
            들고 가는 사람은 PB이고, 발행분은 PB가 상담에 써도 되는 유일한 등급이다.
            ⚠️ 버튼이 아니라 링크다(api.notePdfUrl 주석) — 새 탭으로 열어 두면 모달과
            검토 맥락을 잃지 않는다(출처 링크와 같은 규칙). */}
        {current.status === 'published' && (
          <div className="m-actions">
            <a
              className="btn primary"
              href={notePdfUrl(current.id, actor)}
              target="_blank"
              rel="noopener noreferrer"
            >
              PDF 내려받기
            </a>
            <span className="hint">
              최종본입니다. 뺀 문장은 본문에서 빠지고 판정 이력으로 남습니다.
            </span>
          </div>
        )}
        {/* 감사로그는 여기 두지 않는다 — 준법 · 감시 탭의 감사로그 카드에서 노트별로
            골라 본다(2026-07-28). 이 모달에 두면 화면 절반이 로그였고, 같은 원장이
            두 곳에 나뉘어 있었다. 이 자리에 남는 이력 요약은 모달 머리말 한 줄이다
            ("노트 #13 · 확인 PB · 심의 요청 PB · 발행 —"). */}
      </div>
    </>
  );
}

/* ── 고객 문의 대응 준비 모달 ──────────────────────────────── */
/** AI는 고객에게 나갈 답변을 대신 쓰지 않는다(대상 사용자 = PB, 2026-07-22 확정).
 *  여기서 보여주는 것은 **PB가 회신을 쓰기 전에 확인할 사실**뿐이다.
 *
 *  계좌 요약은 시드(가상 고객)의 실제 값이고, 상담 고지 문구는 규정에서 온 고정 문구다.
 *  종목 관련 사실은 지어내지 않는다 — 브리프·노트가 이미 가진 것(PrepMemo)을 그대로 옮기고,
 *  없으면 없다고 적은 뒤 인라인 F1으로 **PB가 직접 조회**한다. */
function prepFacts(c: Customer) {
  return [
    {
      // 나이가 맨 앞이다 — 성향·비중을 읽을 때 기준이 되는 값이고, 머리말 계좌 줄을
      // 걷어내면서 이 줄이 고객 프로필을 말하는 유일한 자리가 됐다.
      text: `${c.age}세 · ${RISK[c.risk]} · 국내주식 비중 ${c.alloc['국내주식'] ?? 0}% · 잔고 ₩${fmtKRW(c.balance)}`,
    },
    ...(c.flag
      ? [
          {
            text: `위험 플래그: ${c.flagReasons.map((r) => r.text).join(' · ')}.`,
          },
        ]
      : []),
  ];
}

/** 이 문의가 가리키는 **보유 종목**. 문의 주제·질문 원문에 이름이 그대로 들어 있으면 그것이다.
 *
 *  매칭 기준을 "보유 종목명"으로 두는 게 핵심이다: 계좌 이야기(리밸런싱·연금·ISA)는 자연히
 *  안 걸리고, 안 들고 있는 종목 이야기면 이 화면이 내놓을 계좌 사실 자체가 없다.
 *  겹치면 **긴 이름이 이긴다** — `기아`처럼 짧은 이름이 다른 종목명 안에 우연히 들어가는 경우
 *  실제로 문의가 가리키는 쪽은 늘 더 긴 이름이다. */
function askedHolding(item: QueueChat, c: Customer) {
  const hay = `${item.topic} ${item.question ?? ''}`;
  return (
    [...c.holdings]
      .filter((h) => hay.includes(h.name))
      .sort((a, b) => b.name.length - a.name.length)[0] ?? null
  );
}

export function ChatModal({
  item,
  customer,
  role,
  brief,
  notes,
  customerNames,
  onClose,
  onChanged,
  onOpenNotePdf,
  onOpenPortfolio,
  toast,
  chatKeep,
}: {
  item: QueueChat;
  customer: Customer;
  role: Role;
  /** 오늘 브리프·노트 색인 — 고객 카드의 상담 준비 메모와 **같은 재료**다.
   *  여기서 에이전트를 새로 돌리지 않는다(크레딧 0). */
  brief: Brief | null;
  /** 종목별 **발행분 1건**(page.tsx `pickNotes`). */
  notes: Record<string, NoteDetail>;
  /** 보내기 전 경고용 담당 고객 명단(알림일 뿐 — 판정은 백엔드 반출 가드가 한다). */
  customerNames: string[];
  onClose: () => void;
  onChanged: () => void;
  /** 발행분 최종본 PDF를 띄운다(인자는 **노트 id**). 문의는 큐에 그대로 남는다. */
  onOpenNotePdf: (noteId: number) => void;
  /** 이 고객의 포트폴리오 카드로 보낸다(모달을 닫고 상담 준비 탭에서 그 고객을 고른다).
   *  준법에게는 고객 포트폴리오 카드 자체가 없으므로 넘어오지 않는다 — 정보장벽. */
  onOpenPortfolio?: () => void;
  toast: (m: string) => void;
  /** 문의별 대화 보관 자리 — **부모가 소유한다**(이 모달은 닫히면 언마운트되므로 여기서
   *  만들면 대화도 같이 사라진다). 안 넘기면 예전처럼 닫을 때 대화가 사라진다. */
  chatKeep?: ChatKeep;
}) {
  const [res, setRes] = useState<Result>({});
  const [status, setStatus] = useState(item.status);
  const mine = role === 'pb' && customer.pb === MY_PB;
  const asked = askedHolding(item, customer);
  /** 인라인 채팅 입력창을 채우는 신호(고객 카드의 칩과 같은 방식) — 같은 칩을 두 번 눌러도
   *  다시 채워지도록 n을 올린다. **채우기만 하고 보내지 않는다**(실행은 크레딧). */
  const [prefill, setPrefill] = useState<ChatPrefill | null>(null);
  const ask = (q: string) => setPrefill((p) => ({ q, n: (p?.n ?? 0) + 1 }));
  const deny =
    role === 'comp'
      ? '이 건의 처리는 담당 PB 권한입니다'
      : '담당 PB만 처리할 수 있습니다';
  const [label, cls] = PILL[status] ?? [status, ''];

  /* 이 화면의 조작은 **하나뿐이다.**
     - `보류`는 뺐다(2026-07-28): 모달을 그냥 닫으면 건이 `확인 대기`로 남으므로 "아직
       안 봤다"는 이미 기본 상태다. 버튼으로 또 두면 같은 뜻이 두 갈래가 된다.
       (백엔드 `/api/sessions/{id}/reject`는 남겨 뒀다 — 화면에서 부르지 않을 뿐이다.)
     - 라벨이 `확인`이 아니라 `처리 완료`인 이유: 맨 `확인`은 "읽었다"로도 "승인한다"로도
       읽히는데, 여기서 승인할 대상은 없다(AI가 만든 회신문이 없다). 이 건들이 사는 카드
       이름이 **`처리 대기`**라 `처리 대기 → 처리 완료`가 그대로 짝이 되고, 누르면 실제로
       그 목록에서 내려간다. 노트 흐름의 말(검토·심의·발행)과도 안 겹친다. */
  const finish = async (): Promise<Result> => {
    const r = await apiPost(`/api/sessions/${item.id}/approve`, {
      actor: MY_PB,
    });
    if (!r.ok) return { blocked: errorMessage(r.body) };
    setStatus('done');
    toast(
      `처리 대기에서 내렸습니다. ${customer.name} 고객 회신은 PB가 직접 작성합니다`,
    );
    return {
      ok: '처리했습니다. 회신은 PB가 직접 작성합니다(AI가 대신 보내지 않습니다).',
    };
  };

  const actions: Action[] =
    status === 'pending'
      ? [{ label: '처리 완료', ok: mine, deny, run: finish }]
      : [];

  return (
    <>
      <div className="m-head">
        {/* 큐 행과 **같은 제목**을 쓴다(`item.title` = "이름 · 주제"). 큐에서 누른 줄과
            모달 제목이 글자까지 같아야 "그 건을 열었다"가 확인된다 — 예전엔 모달만
            "고객 문의 대응 준비 — 이름"이라 같은 건인지 매번 대조해야 했다. */}
        <h3>{item.title}</h3>
        <span className={`pill ${cls}`}>{label}</span>
        <button className="m-close" aria-label="닫기" onClick={onClose}>
          ×
        </button>
      </div>
      {/* 계좌 메타 줄은 뺐다 — 계좌번호는 이 화면이 답할 것과 무관한 식별정보이고,
          나이·성향·잔고·위험 플래그는 아래 "회신 전 확인할 사실"이 이미 말한다.
          담당 PB도 적지 않는다(담당이 아니면 이 건이 목록에 오지도 않는다). */}
      {/* 여기부터 스크롤 영역 — 위 제목줄만 고정이다. */}
      <div className="m-body">
        {res.blocked && <div className="vbox">⛔ {res.blocked}</div>}
        {res.ok && <div className="okbox">✓ {res.ok}</div>}
        <div className="bubble q">
          <div className="blabel">고객 질문</div>
          {item.question}
        </div>
        <div className="bubble">
          <div className="blabel">고객 정보</div>
          <div className="srows">
            {prepFacts(customer).map((s, i) => (
              <div className="srow" key={i}>
                <span className="stext">{s.text}</span>
              </div>
            ))}
          </div>
          {/* 이 줄들은 계좌 요약이다. 도넛(자산배분)·전 보유 종목 표·위험 플래그 사유는
              고객 카드가 가진 것이고, 그쪽으로 가는 길이 여기다 — 없던 시절엔 PB가 목록
              최하단에서 이 고객을 다시 찾아야 했다(HANDOFF §7). 문의는 큐에 남는다. */}
          {onOpenPortfolio && (
            <button className="linklike prep-go" onClick={onOpenPortfolio}>
              포트폴리오 →
            </button>
          )}
        </div>

        {/* ── 여기부터가 "회신 전에 확인할 사실" ──────────────────────────
            담당 PB가 아니면 그리지 않는다. 준법에게 고객 보유·공시가 갈 이유가 없고
            (정보장벽), 인라인 채팅은 서버가 어차피 404로 막는다
            (`/api/chat/stream?customer_id=`는 담당이 아니면 거절). */}
        {mine && (
          <>
            {/* 문의가 종목을 가리키면 **그 종목만** 낸다. 전 보유 종목을 늘어놓으면 이미
                특정된 질문이 목록에 묻힌다(이 화면의 값어치가 거기서 나온다).
                계좌 이야기(리밸런싱·연금·ISA)는 여기 걸리지 않고 아래 분석 칩이 받는다. */}
            {asked && (
              <div className="bubble">
                <div className="blabel">문의 종목</div>
                <PrepMemo
                  customer={customer}
                  brief={brief}
                  notes={notes}
                  onOpenNotePdf={onOpenNotePdf}
                  only={asked.code}
                  amounts
                />
              </div>
            )}

            {/* 인라인 F1 — 고객 카드의 그것과 **같은 컴포넌트·같은 칩·같은 라우트**다.
                ⚠️ 주어는 여전히 **포트폴리오**이지 사람이 아니다. 문의 모달이라 더 미끄럽다:
                   "이 고객에게 뭐라고 답하지"로 읽히면 회신문 대필(가드레일 4)을 부른다.
                   제목·칩을 고객 카드와 글자까지 같게 두는 이유가 그것이다.
                ⚠️ 입력 가드는 한글 이름을 못 잡는다(HANDOFF §7) — 이름을 안 쓰게 만드는 건
                   지금도 이 UI의 몫이다.
                ⚠️ 모달을 닫으면 대화가 사라진다(EventSource가 언마운트에서 닫힌다). F1은
                   한 턴이 수십 초라 F3(1~2분)만큼 아깝지는 않지만, 답을 받는 중이면 닫지
                   않는 게 맞다. */}
            <div className="sess-chat">
              {/* 근거 줄(`.cchat-src`)은 고객 카드와 **같이** 뺐다 — 두 화면의 제목이
                  글자까지 같아야 한다는 위 규칙 그대로다. 이유는 page.tsx의 같은 자리 참조. */}
              <div className="blabel">포트폴리오 질문</div>
              {/* 종목 칩과 분석 칩은 **줄을 나눈다** — 고객 카드와 같은 규칙이다(한 상자면
                  종목이 많을 때 분석 칩이 종목 사이에 끼어 두 종류가 섞여 보인다).
                  문의 종목을 맨 앞에 세운다 — 순서만 바꿀 뿐 목록은 고객 카드와 같다.
                  질문문도 카드와 같은 `최근 실적`이다: 주제어(실적·비중·공시·급락)로
                  의도를 추측해 채우면 틀렸을 때 크레딧을 헛쓴다. 칩은 입력창을 채울
                  뿐이고 실제로 무엇을 물을지는 PB가 고쳐 쓴다. */}
              {customer.holdings.length > 0 && (
                <div className="cchat-chips">
                  {[
                    ...(asked ? [asked] : []),
                    ...customer.holdings.filter((h) => h.code !== asked?.code),
                  ].map((h) => (
                    <button
                      key={h.code}
                      className="chip"
                      onClick={() => ask(`${h.name} 최근 실적`)}
                      title={`${h.name}(${h.code}) 질문 채우기`}
                    >
                      {h.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="cchat-chips">
                {PORTFOLIO_CHIPS.map((c) => (
                  <button
                    key={c.label}
                    className="chip ana"
                    onClick={() => ask(c.q)}
                    title={c.q}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              {/* 대화는 **문의별로** 보관된다 — 이 모달은 닫으면 언마운트되기 때문이다
                  (감춰 두면 어느 문의의 대화인지가 화면에서 사라진다, HANDOFF §7).
                  키는 문의 id다: 같은 건을 다시 열면 아까 대화가 그대로 서고, 다른 건은
                  자기 대화를 갖는다(번지면 앞 건의 종목을 이어받는다). */}
              <F1Chat
                compact
                customerId={customer.id}
                customerNames={customerNames}
                prefill={prefill}
                keep={chatKeep}
                keepKey={`session-${item.id}`}
              />
            </div>
          </>
        )}

        {/* 노트 모달과 같은 자리 — 읽을 것 아래, 조작 줄 위. 결정 직전에 반드시 지나친다. */}
        <div className="wm">{WATERMARK}</div>
        <ActionsRow
          acts={actions}
          onDone={(r) => {
            setRes(r);
            onChanged();
          }}
        />
      </div>
    </>
  );
}
