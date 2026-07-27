'use client';

/** 검토 모달 — 노트는 검토→심의→발행(게이트 재검사), 상담은 담당 PB 승인/반려.
 *
 *  상태 전이는 전부 백엔드가 원천이다(감사로그·게이트 재검사 포함). 화면은 결과를 받아
 *  다시 그릴 뿐, 여기서 상태를 임의로 바꾸지 않는다 — 시안은 목업이라 로컬에서 바꿨지만
 *  실화면에서 그렇게 하면 DB와 화면이 갈라진다.
 */

import { useState } from 'react';
import { apiPost, errorMessage, fmtDate, fmtKRW, hhmm, detailStr } from './api';
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

type Result = { ok?: string; blocked?: string };

/* ── 문장 출처 배지 ─────────────────────────────────────────
   날짜는 출처 종류와 무관하게 같은 규칙으로 찍는다(fmtDate) — 공시는 `20260722`,
   뉴스는 RFC 2822로 원본 형식이 다른데, 그대로 두면 같은 줄에서 표기가 갈리고
   뉴스는 `.slice()`에 요일이 잘려 "Wed, 22 Ju"로 나갔다. */
function SourceBadge({ src }: { src: NoteSource | null }) {
  if (!src) return <span className="sbadge un">UNSOURCED</span>;
  if (src.type === 'dart') {
    return (
      <span className="sbadge src" title={`rcpNo ${src.rcept_no}`}>
        공시 {fmtDate(src.rcept_dt) || '접수일 미상'}
      </span>
    );
  }
  if (src.type === 'krx') {
    return (
      <span className="sbadge src" title={src.label}>
        시세 {fmtDate(src.as_of)}
      </span>
    );
  }
  return (
    <span className="sbadge src" title={src.url}>
      뉴스 {fmtDate(src.pub_date) || '시점 미상'}
    </span>
  );
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
  return (
    <div className="srows">
      {rows.map(({ s, i }) => {
        // 옛 노트는 sources 없이 source만 있다 — 둘 다 읽는다.
        const srcs = s.sources ?? (s.source ? [s.source] : []);
        const ack = ackOf.get(i);
        return (
          <div className="srow" key={i}>
            <span className="stext">{s.text}</span>
            <span className="spacer" style={{ flex: 1 }} />
            {srcs.length ? (
              srcs.map((src, j) => <SourceBadge key={j} src={src} />)
            ) : ack ? (
              // 사람이 확인한 문장 — 누가·언제·무슨 사유였는지가 배지에 남는다.
              <span
                className="sbadge ack"
                title={`${actorLabel(ack.actor)} · ${hhmm(ack.ts)} 확인`}
              >
                확인함 · {ack.reason}
              </span>
            ) : s.kind === 'interpretation' ? (
              // 각주가 없는 게 규칙대로인 문장. UNSOURCED로 칠하면 검토자가 위반으로
              // 오해한다 — 다만 판단은 사람이 하도록 큐에는 그대로 올라간다.
              <span
                className="sbadge itp"
                title="해석·전망 문장은 출처 각주 대상이 아닙니다"
              >
                해석
              </span>
            ) : (
              <SourceBadge src={null} />
            )}
            {/* 확인 UI는 미인용 문장에만 붙는다. 출처가 있는 문장은 애초에 게이트를
                막고 있지 않으므로 풀 것도 없다. */}
            {canAck && !srcs.length && (
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
            )}
          </div>
        );
      })}
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
                deny: '준법 심의 중입니다 — 발행은 준법 권한입니다',
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
  const body = current.sentences
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !s.is_heading && s.kind !== 'boilerplate');

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
      <div className="m-audit">
        <div className="alabel">감사로그 (append-only)</div>
        {current.audit_log.map((a, i) => (
          <div className="aitem" key={i}>
            <span className="ats">{hhmm(a.ts)}</span>
            <span className="aev">{a.event_type}</span>
            <span className="adet">
              {[a.actor && `actor: ${actorLabel(a.actor)}`, detailStr(a.detail)]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
        ))}
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
      <div className="wm">
        {WATERMARK} AI는 고객 회신을 대신 쓰지 않습니다 — 아래는 PB가 회신 전에
        확인할 사실입니다.
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
              <span className="spacer" style={{ flex: 1 }} />
              {s.badge}
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
    </>
  );
}
