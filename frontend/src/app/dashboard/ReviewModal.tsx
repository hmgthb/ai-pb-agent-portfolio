'use client';

/** 검토 모달 — 노트는 검토→심의→발행(게이트 재검사), 상담은 담당 PB 승인/반려.
 *
 *  상태 전이는 전부 백엔드가 원천이다(감사로그·게이트 재검사 포함). 화면은 결과를 받아
 *  다시 그릴 뿐, 여기서 상태를 임의로 바꾸지 않는다 — 시안은 목업이라 로컬에서 바꿨지만
 *  실화면에서 그렇게 하면 DB와 화면이 갈라진다.
 */

import { useState } from 'react';
import { apiPost, errorMessage, fmtKRW, hhmm } from './api';
import {
  ACK_REASONS,
  ACTOR,
  actorLabel,
  MY_PB,
  PILL,
  RISK,
  WATERMARK,
  type Customer,
  type NoteAck,
  type NoteDetail,
  type NoteSentence,
  type NoteSource,
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
 *  정렬은 stable이라 같은 등급 안에서는 원문 순서가 유지되고, 확인(ack)은 **원본 인덱스**로
 *  저장되므로 이 정렬에 영향받지 않는다(HANDOFF §1-2). */
function reviewTier(s: NoteSentence): number {
  const srcs = sourcesOf(s);
  if (!srcs.length) return s.kind === 'interpretation' ? 1 : 0;
  return srcs.some((x) => x.type === 'news') ? 3 : 2;
}

/** 문장 목록. `rows`의 i는 **원본 sentences 배열의 인덱스**다 — 확인 기록(ack)이 그
 *  인덱스로 저장되므로, 소제목·고지문구를 걸러낸 뒤의 순번을 쓰면 다른 문장을 가리킨다. */
function SentenceRows({
  rows,
  acks,
  canAck,
  onAck,
}: {
  rows: { s: NoteSentence; i: number }[];
  acks: NoteAck[];
  /** 준법 + 심의 단계에서만 확인할 수 있다 */
  canAck: boolean;
  onAck: (index: number, reason: string | null) => void;
}) {
  const ackOf = new Map(acks.map((a) => [a.index, a]));
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
                    className="sbadge ack inline"
                    title={`${actorLabel(ack.actor)} · ${hhmm(ack.ts)} 확인`}
                  >
                    확인함 · {ack.reason}
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
            </span>
            {/* 확인 UI는 미인용 문장에만 붙는다. 출처가 있는 문장은 애초에 게이트를
                막고 있지 않으므로 풀 것도 없다. 이것만 조작이라 문장 밖에 남긴다. */}
            {canAck && !srcs.length && (
              <span className="sbadges">
                <select
                  className="acksel"
                  aria-label="확인 사유"
                  value={ack?.reason ?? ''}
                  onChange={(e) => onAck(i, e.target.value || null)}
                >
                  <option value="">확인 안 함</option>
                  {ACK_REASONS.map((r) => (
                    <option key={r} value={r}>
                      {r}(으)로 확인
                    </option>
                  ))}
                </select>
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
  run: () => Promise<Result>;
};

function ActionsRow({
  acts,
  onDone,
}: {
  acts: Action[];
  onDone: (r: Result) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!acts.length) return null;
  return (
    <div className="m-actions">
      {acts.map((a, i) => (
        <span key={i} style={{ display: 'contents' }}>
          <button
            className={`btn ${a.danger ? 'danger' : 'primary'}`}
            disabled={!a.ok || busy}
            onClick={async () => {
              setBusy(true);
              onDone(await a.run());
              setBusy(false);
            }}
          >
            {a.label}
          </button>
          {!a.ok && <span className="hint">🔒 {a.deny}</span>}
        </span>
      ))}
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

  const act = async (action: string): Promise<Result> => {
    const r = await apiPost(`/api/notes/${current.id}/${action}`, { actor });
    if (!r.ok) return { blocked: errorMessage(r.body) };
    if (action === 'publish') {
      toast('발행 완료 — 감사로그에 기록되었습니다');
      return { ok: '게이트 통과 — 발행되었습니다.' };
    }
    return {};
  };

  /* 노트를 만든 사람이 PB이므로 사실 확인도 PB가 한다 — 예전엔 두 단계가 '관리자'
     권한이었는데, 1인용 대시보드에는 관리자가 없다. 마지막 단계(발행)만 준법에게 남긴다:
     **만드는 사람과 통과시키는 사람이 갈리는 지점이 여기 하나**이고, 그게 이 제품의 핵심이다.
     그래서 PB 화면에서 심의중 노트는 상태만 보이고 버튼이 없다(아래 deny 문구가 이유를 말한다). */
  const actions: Action[] =
    current.status === 'draft'
      ? [
          {
            label: '사실 확인 시작',
            ok: role === 'pb',
            deny: '노트의 사실 확인은 담당 PB가 합니다',
            run: () => act('review'),
          },
        ]
      : current.status === 'review'
        ? [
            {
              label: '확인 완료 → 준법 심의 요청',
              ok: role === 'pb',
              deny: '심의 요청은 확인한 PB가 합니다',
              run: () => act('deliberate'),
            },
          ]
        : current.status === 'deliberation'
          ? [
              {
                label: '발행',
                ok: role === 'comp',
                deny: '준법 심의 중입니다. 발행은 준법 권한입니다',
                run: () => act('publish'),
              },
            ]
          : [];

  const people = (
    [
      ['확인', current.reviewer],
      ['심의 요청', current.deliberator],
      ['발행', current.publisher],
    ] as const
  )
    .map(([k, v]) => `${k} ${v ? actorLabel(v) : '—'}`)
    .join(' · ');

  // 소제목과 고지문구·구분선은 검토 대상 문장이 아니다(백엔드 게이트와 같은 기준).
  // 원본 인덱스를 들고 다닌다 — 확인 기록이 그 인덱스로 저장되기 때문이다.
  // 정렬은 reviewTier: 미인용(확인 필요) → 공시·시세 → 뉴스. 노트를 산문으로 읽는 화면이
  // 아니라 **문장별로 출처를 확인하는 화면**이라 서술 순서보다 처리 순서를 따른다.
  const body = current.sentences
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !s.is_heading && s.kind !== 'boilerplate')
    .sort((a, b) => reviewTier(a.s) - reviewTier(b.s));

  /* 각주를 붙일 수 없는 문장(해석·고지·데이터 설명)이 실제로 있어서, 게이트가 그걸 전부
     잠그면 사람이 열 방법이 없다 — 그래서 준법이 사유를 적어 확인하면 미인용 집계에서
     빠진다. 확인은 **심의 단계에서만**(초안에서 미리 풀면 검토가 형식이 된다) 그리고
     발행과 같은 권한(준법)에게만 연다. */
  const canAck = role === 'comp' && current.status === 'deliberation';
  const acked = new Set(current.acks.map((a) => a.index));
  const blocking = body.filter(
    ({ s, i }) => !(s.sources?.length || s.source) && !acked.has(i),
  ).length;

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

  return (
    <>
      <div className="m-head">
        <h3>
          {current.corp_name}({current.stock_code}) 실적·공시 노트
        </h3>
        <span className={`pill ${cls}`}>{label}</span>
        <button className="m-close" aria-label="닫기" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="m-meta">
        노트 #{current.id} · {people}
      </div>
      {/* 여기부터가 스크롤 영역이다 — 위 두 줄(제목·×·메타)은 고정이라 긴 노트에서도
          닫기 버튼이 사라지지 않는다. */}
      <div className="m-body">
        <div className="wm">{WATERMARK}</div>
        {res.blocked && <div className="vbox">⛔ {res.blocked}</div>}
        {res.ok && <div className="okbox">✓ {res.ok}</div>}
        {/* 심의 단계에서 "무엇이 남아서 막고 있는가"를 문장 목록 위에 먼저 말한다 —
            발행 버튼을 눌러 409를 받고 나서야 아는 건 검토 화면이 할 일이 아니다. */}
        {current.status === 'deliberation' && (
          <div className={blocking ? 'ackbar' : 'ackbar done'}>
            {blocking
              ? `출처 없는 문장 ${blocking}개가 발행을 막고 있습니다. 각주를 붙일 수 없는 문장이면 사유를 골라 확인하세요.`
              : '미인용 문장이 모두 확인되었습니다 — 발행할 수 있습니다.'}
            {current.acks.length > 0 &&
              ` (확인 ${current.acks.length}개, 감사로그에 기록됨)`}
          </div>
        )}
        <SentenceRows
          rows={body}
          acks={current.acks}
          canAck={canAck}
          onAck={ack}
        />
        <ActionsRow
          acts={actions}
          onDone={async (r) => {
            setRes(r);
            const fresh = await onChanged();
            if (fresh) setCurrent(fresh);
          }}
        />
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
 *  종목 관련 사실이 필요하면 F1(종목 즉답)·브리핑으로 간다 — 여기서 지어내지 않는다. */
function prepFacts(c: Customer) {
  return [
    {
      text: `등록 투자성향 ${RISK[c.risk]} · 국내주식 비중 ${c.alloc['국내주식'] ?? 0}% · 잔고 ₩${fmtKRW(c.balance)}.`,
      badge: (
        <span className="sbadge acct" title={c.acct}>
          계좌 데이터
        </span>
      ),
    },
    ...(c.flag
      ? [
          {
            text: `위험 플래그: ${c.flagReasons.map((r) => r.text).join(' · ')}.`,
            badge: <span className="sbadge acct">규칙 판정</span>,
          },
        ]
      : []),
    {
      text: '회신 시 고지: 정보 제공 목적이며 투자권유가 아님을 밝히고, 매매 판단은 고객 확인을 거칩니다.',
      badge: <span className="sbadge ntc">필수 고지</span>,
    },
  ];
}

export function ChatModal({
  item,
  customer,
  role,
  onClose,
  onChanged,
  toast,
}: {
  item: QueueChat;
  customer: Customer;
  role: Role;
  onClose: () => void;
  onChanged: () => void;
  toast: (m: string) => void;
}) {
  const [res, setRes] = useState<Result>({});
  const [status, setStatus] = useState(item.status);
  const mine = role === 'pb' && customer.pb === MY_PB;
  const deny =
    role === 'comp'
      ? '이 건의 처리는 담당 PB 권한입니다'
      : '담당 PB만 처리할 수 있습니다';
  const [label, cls] = PILL[status] ?? [status, ''];

  const decide = async (action: 'approve' | 'reject'): Promise<Result> => {
    const r = await apiPost(`/api/sessions/${item.id}/${action}`, {
      actor: MY_PB,
    });
    if (!r.ok) return { blocked: errorMessage(r.body) };
    setStatus(action === 'approve' ? 'done' : 'rejected');
    if (action === 'approve') {
      toast(`확인 완료 — ${customer.name} 고객 회신은 PB가 직접 작성합니다`);
      return {
        ok: '확인 완료 — 회신 작성은 사람이 합니다(AI가 대신 보내지 않습니다).',
      };
    }
    toast('보류됨 — 추가 확인 필요로 표시했습니다');
    return { blocked: '보류됨 — 사실 확인이 더 필요한 건으로 표시했습니다.' };
  };

  const actions: Action[] =
    status === 'pending'
      ? [
          { label: '확인', ok: mine, deny, run: () => decide('approve') },
          {
            label: '보류',
            ok: mine,
            deny,
            danger: true,
            run: () => decide('reject'),
          },
        ]
      : [];

  return (
    <>
      <div className="m-head">
        <h3>고객 문의 대응 준비 — {customer.name}</h3>
        <span className={`pill ${cls}`}>{label}</span>
        <button className="m-close" aria-label="닫기" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="m-meta">
        {customer.acct} · {customer.age}세 · {RISK[customer.risk]} · 잔고 ₩
        {fmtKRW(customer.balance)} · 담당 {customer.pb}
        {customer.flag && (
          <>
            {' '}
            ·{' '}
            {/* 칩 안엔 표시만 둔다 — 사유까지 넣으면 한 줄짜리 검은 막대가 된다 */}
            <span className="flag">⚑ 위험 플래그</span>{' '}
            {customer.flagReasons.map((r) => r.text).join(' · ')}
          </>
        )}
      </div>
      {/* 여기부터 스크롤 영역 — 위 두 줄(제목·×·계좌 메타)은 고정이다. */}
      <div className="m-body">
        <div className="wm">
          {WATERMARK} AI는 고객 회신을 대신 쓰지 않습니다 — 아래는 PB가 회신
          전에 확인할 사실입니다.
        </div>
        {res.blocked && <div className="vbox">⛔ {res.blocked}</div>}
        {res.ok && <div className="okbox">✓ {res.ok}</div>}
        <div className="bubble q">
          <div className="blabel">고객 질문</div>
          {item.question}
        </div>
        <div className="bubble">
          <div className="blabel">
            회신 전 확인할 사실
            <span className="src mock" style={{ marginLeft: 6 }}>
              계좌는 시드 데이터 · 가상 고객
            </span>
          </div>
          <div className="srows">
            {prepFacts(customer).map((s, i) => (
              <div className="srow" key={i}>
                <span className="stext">{s.text}</span>
                <span className="sbadges">{s.badge}</span>
              </div>
            ))}
          </div>
        </div>
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
