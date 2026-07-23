'use client';

/** AI PB 어시스턴트 (H1) — docs/design/pb-admin-dashboard.html 시안의 React 포팅.
 *
 *  **대상 사용자 = PB**(2026-07-22 확정). 이 화면은 PB가 고객을 만나기 전에 여는 화면이고,
 *  AI는 PB를 대신하지 않는다 — 출처 있는 사실을 모아줄 뿐, 고객에게 나가는 말은 사람이 쓴다.
 *  그래서 기본 역할이 PB이고, 첫 화면에 "오늘 시장 → 내 고객 종목 → 고객별 상담 준비" 순으로
 *  놓인다(관리자·준법 역할은 감독용 뷰로 유지).
 *
 *  시안과 달라진 점:
 *   · 노트 생성 카드가 시뮬레이션이 아니라 **실제 SSE**로 돈다 (ResearchCard).
 *   · 백엔드가 없으면 목업으로 폴백하지 않고 **연결 실패를 그대로 말한다**.
 *   · 추이 차트·컴플라이언스 알림을 하드코딩 대신 **감사로그에서 집계**한다.
 *  레이아웃·스타일은 시안이 원본이다(dashboard.css).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import './dashboard.css';
import { api, ago, detailStr, fmtDate, fmtKRW, fmtPct, hhmm, isDown } from './api';
import { BarChart, Donut, GateMini, LineChart, Tip, useTip } from './charts';
import F1Chat from './F1Chat';
import ResearchCard from './ResearchCard';
import { ChatModal, NoteModal } from './ReviewModal';
import {
  MY_PB, PILL, RISK,
  type AgentCalls, type Brief, type Customer, type DashboardAudit,
  type NoteDetail, type QueueChat, type QueueItem, type Role, type Summary,
} from './types';

/* ── 역할(목 로그인)별 화면 구성 ──────────────────────────── */
const ROLES: Record<Role, {
  aiTab: boolean;
  portfolio: boolean;
  research: boolean;
  defaultView: 'cust' | 'ai' | null;
  queueFilter: ((it: QueueItem) => boolean) | null;
  custFilter: ((c: Customer) => boolean) | null;
  qScope: string;
}> = {
  admin: {
    aiTab: true, portfolio: true, research: true, defaultView: null,
    queueFilter: null, custFilter: null, qScope: '',
  },
  // PB도 팩트 노트를 **생성**할 수 있다(상담 준비 자료). 검토·심의·발행은 여전히
  // 리서치·준법 권한이다 — 만드는 것과 내보내는 것을 분리하는 게 이 제품의 핵심이다.
  pb: {
    aiTab: false, portfolio: true, research: true, defaultView: 'cust',
    queueFilter: (it) => it.type === 'chat' && it.who === MY_PB,
    custFilter: (c) => c.pb === MY_PB,
    qScope: `${MY_PB}(나) 담당 건만 표시 중`,
  },
  comp: {
    aiTab: true, portfolio: false, research: false, defaultView: 'ai',
    queueFilter: (it) => it.type === 'note' && it.status === 'deliberation',
    custFilter: null,
    qScope: '심의 단계 건만 표시 중',
  },
};

/** 기능 레일은 PB가 읽는 말로 적는다 — F1~F5는 내부 코드명이라 이름만으로는 무엇을
 *  해주는지 알 수 없다. 코드는 뒤에 작게 붙여 문서·발표와 대응이 유지되게 한다. */
const FEATURES = [
  { id: 'F1', name: '종목 즉답', sub: '상담 중 질문에 출처와 함께', on: false },
  { id: 'F2', name: '상담 전 브리핑', sub: '내 고객 종목의 밤사이 변화', on: true },
  { id: 'F3', name: '종목 팩트 노트', sub: '실적·공시를 출처와 함께 정리', on: true },
  { id: 'F4', name: '피어·섹터 비교', sub: '"경쟁사 대비" 질문 대응', on: false },
  { id: 'F5', name: '규정 확인', sub: '상담 화법·고지 의무', on: false },
];

type Session = { id: number; started_at: string };

type Data = {
  customers: Customer[];
  queue: QueueItem[];
  notes: Record<string, NoteDetail>;
  summary: Summary;
  audit: DashboardAudit[];
  agents: AgentCalls[];
  sessions: Session[];
  brief: Brief | null;
};

/* ── 최근 14일 라벨 + 날짜별 집계 ───────────────────────────
   하루 경계는 브라우저 위치와 무관하게 KST 고정 — 백엔드 집계(db.py의 BIZ_TZ)와 같은
   기준이어야 추이 막대가 "AI가 오늘 한 일"과 어긋나지 않는다. 예전엔 라벨은 로컬 날짜로
   만들고 데이터는 ISO를 slice(0,10)해 UTC 날짜로 담아서, KST 00~09시에 생긴 건이 하루
   앞 칸에 꽂혔다. */
const BIZ_TZ = 'Asia/Seoul';
const bizDay = new Intl.DateTimeFormat('en-CA', { timeZone: BIZ_TZ }); // → YYYY-MM-DD

function lastDays(n: number) {
  const out: { key: string; label: string }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    // KST는 DST가 없어 24h 고정 감산으로 날짜가 정확히 하나씩 물러난다.
    const key = bizDay.format(new Date(Date.now() - i * 86_400_000));
    const [, m, d] = key.split('-');
    out.push({ key, label: `${Number(m)}/${Number(d)}` });
  }
  return out;
}
const dayKey = (iso: string) => bizDay.format(new Date(iso));

/* ── 상담 준비 메모 ───────────────────────────────────────────
   고객을 고르면, 그 고객이 **실제로 들고 있는 종목**에 대해 이미 수집된 사실만 모아 보여준다.
   여기서 에이전트를 새로 돌리지 않는다 — 브리프(F2)와 팩트 노트(F3)가 출처와 함께 이미 가진
   것을 고객 기준으로 다시 배열할 뿐이다("공통 인프라 1 + 얇은 레이어 N"의 실제 사례).
   확인된 게 없으면 없다고 말한다 — 빈 줄을 그럴듯한 문장으로 채우지 않는다(가드레일 3). */
function PrepMemo({
  customer, brief, notes, onAsk, onOpenNote,
}: {
  customer: Customer;
  brief: Brief | null;
  notes: Record<string, NoteDetail>;
  onAsk: (q: string) => void;
  onOpenNote: (code: string) => void;
}) {
  const rows = customer.holdings.map((h) => ({
    h,
    b: brief?.items.find((i) => i.stock_code === h.code) ?? null,
    note: notes[h.code] ?? null,
  }));

  return (
    <div className="prep">
      <div className="prep-head">
        <span className="tag">상담 준비</span>
        이 고객 보유 종목에서 <strong>출처가 확인된 사실</strong>만 모았습니다 — 링크로 원문을 확인한 뒤 쓰세요.
      </div>
      {rows.map(({ h, b, note }) => {
        const q = b?.quote;
        const down = q ? isDown(q.change_pct) : false;
        const lines = [
          ...(b?.disclosures ?? []).slice(0, 2).map((d) => ({
            tag: '공시', text: d.report_nm.trim(), href: d.viewer_url, meta: fmtDate(d.rcept_dt),
          })),
          ...(b?.news ?? []).slice(0, 1).map((n) => ({
            tag: '뉴스', text: n.title, href: n.link, meta: (n.pub_date || '').slice(0, 16),
          })),
        ];
        return (
          <div className="prep-row" key={h.code}>
            <div className="prep-name">
              {h.name} <span className="bcode">{h.code}</span>
              {q && (
                <span className="prep-quote">
                  <strong>{Number(q.close).toLocaleString()}원</strong>{' '}
                  <span className={`delta ${down ? 'down' : 'up'}`}>{down ? '▼' : '▲'}{fmtPct(q.change_pct)}%</span>
                  <span className="bcode"> · {fmtDate(q.as_of)} 지연시세</span>
                </span>
              )}
              <span className="spacer" style={{ flex: 1 }} />
              <button className="btn mini" onClick={() => onAsk(`${h.name} 최근 실적`)}>이 종목 묻기</button>
            </div>
            {lines.map((l, i) => (
              <div className="prep-line" key={i}>
                <span className="btag">{l.tag}</span>
                <a href={l.href || '#'} target="_blank" rel="noreferrer">{l.text}</a>
                <span className="bcode"> {l.meta}</span>
              </div>
            ))}
            {note && (
              <div className="prep-line">
                <span className="btag">노트</span>
                <button className="linklike" onClick={() => onOpenNote(h.code)}>
                  {note.corp_name} 팩트 노트 열기
                </button>
                <span className="bcode"> · {PILL[note.status]?.[0] ?? note.status}</span>
              </div>
            )}
            {!lines.length && !note && (
              <div className="prep-line muted">
                오늘 브리핑·노트에 이 종목은 없습니다 — 필요하면 &ldquo;이 종목 묻기&rdquo;로 바로 확인하세요.
              </div>
            )}
          </div>
        );
      })}
      {!customer.holdings.length && <div className="hint">보유 종목이 없습니다.</div>}
    </div>
  );
}

export default function DashboardPage() {
  // 기본 역할은 PB다 — 이 제품의 사용자가 PB이므로 첫 화면도 PB가 보는 화면이어야 한다.
  const [role, setRole] = useState<Role>('pb');
  const [view, setView] = useState<'cust' | 'ai'>('cust');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'note' | 'chat'>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [modal, setModal] = useState<
    { kind: 'note'; code: string } | { kind: 'chat'; id: number } | { kind: 'f1'; q?: string } | null
  >(null);
  const [toastMsg, setToastMsg] = useState('');
  const { tip, bind } = useTip();

  const toast = useCallback((m: string) => {
    setToastMsg(m);
    setTimeout(() => setToastMsg(''), 2800);
  }, []);

  const load = useCallback(async () => {
    try {
      const [customers, queue, summary, audit, agents, sessions] = await Promise.all([
        api<Customer[]>('/api/customers'),
        api<QueueItem[]>('/api/dashboard/queue'),
        api<Summary>('/api/dashboard/summary'),
        api<DashboardAudit[]>('/api/dashboard/audit?limit=200'),
        api<AgentCalls[]>('/api/dashboard/agents'),
        api<Session[]>('/api/sessions'),
      ]);
      // 노트 본문·감사로그는 큐에 없으므로 건별 상세를 따로 받는다.
      const details = await Promise.all(
        queue.filter((i): i is Extract<QueueItem, { type: 'note' }> => i.type === 'note')
          .map((n) => api<NoteDetail>(`/api/notes/${n.id}`).catch(() => null)),
      );
      const notes: Record<string, NoteDetail> = {};
      details.forEach((d) => { if (d) notes[d.stock_code] = d; });
      // 브리프는 아직 없을 수 있다(404) — 그건 오류가 아니라 상태다.
      const brief = await api<Brief>('/api/briefs/latest').catch(() => null);
      setData({ customers, queue, notes, summary, audit, agents, sessions, brief });
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // 마운트 시 1회 로딩. 이 화면은 역할 전환·검토 액션이 있는 라이브 콘솔이라 서버
  // 컴포넌트로 미리 받지 않고 클라이언트에서 받는다(액션 후 같은 경로로 갱신).
  // eslint-disable-next-line react-hooks/set-state-in-effect -- 마운트 시 데이터 로딩
  useEffect(() => { void load(); }, [load]);

  const cfg = ROLES[role];

  function applyRole(r: Role) {
    setRole(r);
    const next = ROLES[r];
    if (next.defaultView) setView(next.defaultView);
    else if (view === 'ai' && !next.aiTab) setView('cust');
  }

  const pending = useMemo(
    () => (data?.queue ?? []).filter((it) => !['published', 'done', 'rejected'].includes(it.status)),
    [data],
  );
  const roleQueue = useMemo(
    () => pending.filter((it) => !cfg.queueFilter || cfg.queueFilter(it)),
    [pending, cfg],
  );
  const roleCustomers = useMemo(
    () => (cfg.custFilter ? (data?.customers ?? []).filter(cfg.custFilter) : data?.customers ?? []),
    [data, cfg],
  );

  const visibleCustomers = useMemo(
    () => roleCustomers.filter((c) => c.name.includes(search.trim())),
    [roleCustomers, search],
  );

  /* 종목코드 → 이 종목을 보유한 (내 담당) 고객 수. 브리프가 "왜 이 종목인가"를 화면에서
     스스로 설명하게 만든다 — 종목 선정 기준이 고객 포트폴리오이기 때문이다. */
  const holders = useMemo(() => {
    const m = new Map<string, number>();
    roleCustomers.forEach((c) =>
      c.holdings.forEach((h) => m.set(h.code, (m.get(h.code) ?? 0) + 1)),
    );
    return m;
  }, [roleCustomers]);
  const selected = useMemo(
    () => visibleCustomers.find((c) => c.id === selectedId) ?? visibleCustomers[0] ?? null,
    [visibleCustomers, selectedId],
  );

  /* 추이 — 하드코딩 대신 감사로그·세션에서 집계한다. 데이터가 쌓이기 전에는 대부분 0이고,
     그게 사실이다(없는 과거를 지어내지 않는다). */
  const days = useMemo(() => lastDays(14), []);
  const trend = useMemo(() => {
    const noteByDay = new Map<string, number>();
    (data?.audit ?? []).filter((a) => a.event_type === 'note_created')
      .forEach((a) => noteByDay.set(dayKey(a.ts), (noteByDay.get(dayKey(a.ts)) ?? 0) + 1));
    const sessByDay = new Map<string, number>();
    (data?.sessions ?? []).forEach((s) =>
      sessByDay.set(dayKey(s.started_at), (sessByDay.get(dayKey(s.started_at)) ?? 0) + 1));
    return {
      notes: days.map((d) => noteByDay.get(d.key) ?? 0),
      sessions: days.map((d) => sessByDay.get(d.key) ?? 0),
    };
  }, [data, days]);

  /* 컴플라이언스 알림 — 감사로그에서 실제 차단·거부만 뽑는다 */
  const feed = useMemo(() => {
    return (data?.audit ?? [])
      .filter((a) =>
        a.event_type === 'publish_blocked' ||
        (a.event_type === 'permission_check' && (a.detail as { allowed?: boolean }).allowed === false))
      .slice(0, 8)
      .map((a) => {
        const blocked = a.event_type === 'publish_blocked';
        return {
          sev: blocked ? 'critical' : 'warning',
          icon: blocked ? '⛔' : '◆',
          msg: blocked
            ? `발행 차단 — ${detailStr(a.detail) || '게이트 미통과'}`
            : `허용 외 도구 호출 거부 (${(a.detail as { tool_name?: string }).tool_name ?? '알 수 없음'})`,
          ref: [a.note_id && `노트 #${a.note_id}`, a.event_type].filter(Boolean).join(' · '),
          time: hhmm(a.ts),
        };
      });
  }, [data]);

  const openItem = (it: QueueItem) =>
    setModal(it.type === 'note' ? { kind: 'note', code: it.code } : { kind: 'chat', id: it.id });

  /* ── 로딩 / 연결 실패 ────────────────────────────────────── */
  if (error) {
    return (
      <div className="wrap">
        <header className="topbar"><div className="brand">AI PB 어시스턴트<small>상담 전 사실 확인</small></div></header>
        <section className="card">
          <div className="card-head"><h2>백엔드에 연결하지 못했습니다</h2></div>
          <div className="hint" style={{ padding: '8px 0' }}>
            {error} — <code>docker compose up</code>으로 백엔드(8000)가 떠 있는지 확인하세요.
            <br />목업 데이터로 화면만 보려면 시안 파일 <code>docs/design/pb-admin-dashboard.html</code>을 직접 열면 됩니다.
          </div>
          <button className="btn primary" onClick={() => void load()}>다시 시도</button>
        </section>
      </div>
    );
  }
  if (!data) {
    return <div className="wrap"><div className="hint" style={{ padding: 40 }}>불러오는 중…</div></div>;
  }

  const noteCount = roleQueue.filter((i) => i.type === 'note').length;
  const chatCount = roleQueue.filter((i) => i.type === 'chat').length;
  const flagged = roleCustomers.filter((c) => c.flag).length;

  /* "AI가 오늘 한 일" — 백엔드가 감사로그에서 센 오늘치만 쓴다(프론트에서 audit 목록을
     세면 최근 N건 제한 때문에 조용히 적게 세인다). **0인 항목은 아예 적지 않는다** —
     "0건"을 나열하면 아무것도 안 한 날도 일한 것처럼 보인다. */
  const today = data.summary.today;
  const briefToday = data.brief?.brief_date === days[days.length - 1].key ? data.brief : null;
  const aiwork = [
    briefToday && `상담 전 브리핑 ${briefToday.items.length}종목 수집`,
    today.tool_calls &&
      `에이전트 도구 호출 ${today.tool_calls}건${today.agents ? ` (에이전트 ${today.agents}종)` : ''}`,
    today.chats && `종목 즉답 ${today.chats}건`,
    today.notes && `팩트 노트 ${today.notes}건`,
  ].filter((x): x is string => typeof x === 'string');

  const tiles =
    role === 'admin'
      ? [
          { label: '처리 대기', value: String(roleQueue.length), breakdown: `팩트 노트 ${noteCount} · 고객 문의 ${chatCount}` },
          { label: '위험 플래그 고객', value: String(flagged), breakdown: `전체 ${roleCustomers.length}명 중 규칙 3종으로 도출` },
        ]
      : role === 'pb'
      ? [
          { label: '내 담당 고객', value: String(roleCustomers.length), breakdown: `위험 플래그 ${flagged}명` },
          { label: '내 처리 대기', value: String(roleQueue.length), breakdown: 'AI 산출물은 사람 확인 전에는 고객에게 나가지 않습니다' },
        ]
      : [
          { label: '심의 대기', value: String(roleQueue.length), breakdown: '검토를 통과해 준법 심의를 기다리는 노트' },
          { label: '게이트 차단 (7일)', value: String(data.summary.gate_blocks_7d), breakdown: '건별 상세는 컴플라이언스 알림 카드', gate: true },
        ];

  return (
    <div className="wrap">
      <header className="topbar">
        <div className="brand">AI PB 어시스턴트<small>상담 전 사실 확인 · 리서치 코파일럿</small></div>
        <span className="env-pill">프로토타입</span>
        <div className="right">
          <div className="role-toggle" role="group" aria-label="역할 전환 (목 로그인)">
            {(['admin', 'pb', 'comp'] as Role[]).map((r) => (
              <button key={r} aria-pressed={role === r} onClick={() => applyRole(r)}>
                {r === 'admin' ? '관리자' : r === 'pb' ? 'PB' : '준법'}
              </button>
            ))}
          </div>
          <span className="asof">고객 {data.summary.customers_total}명 · 노트 {data.summary.notes_total}건</span>
        </div>
      </header>

      <div className="notice" role="note">
        <span className="dot">⚠</span>
        <span>
          <strong>PB 상담 준비용 내부 참고 자료</strong> — 투자권유·광고가 아닙니다. AI는 공개 공시·뉴스·
          지연시세에서 <strong>출처 있는 사실만</strong> 모읍니다. 고객에게 나가는 말은 PB가 직접 쓰고,
          AI 산출물은 전부 <strong>초안·미검증</strong>이며 발행·전달은 사람의 검토·심의·승인 후에만 가능합니다.
        </span>
      </div>

      <nav className="rail" aria-label="기능 레일">
        {FEATURES.map((f) => {
          const live = f.on || f.id === 'F1';  // F1은 이제 대화형 슬라이스가 동작한다
          const openChat = f.id === 'F1' ? () => setModal({ kind: 'f1' }) : undefined;
          return (
            <div
              className={`f ${live ? 'on' : 'off'}${openChat ? ' clickable' : ''}`}
              key={f.id}
              role={openChat ? 'button' : undefined}
              tabIndex={openChat ? 0 : undefined}
              onClick={openChat}
              onKeyDown={openChat ? (e) => { if (e.key === 'Enter') openChat(); } : undefined}
            >
              <div className="fname">{f.name} <span className="fcode">{f.id}</span></div>
              <div className="fsub">{f.sub}</div>
              <span className="fstate">{f.id === 'F1' ? '열기 →' : f.on ? '동작' : '로드맵'}</span>
            </div>
          );
        })}
      </nav>

      <nav className="cats" aria-label="대시보드 카테고리">
        <button className="cat" aria-pressed={view === 'cust'} onClick={() => setView('cust')}>
          고객 관리<span className="cat-sub">지금 처리할 일 · 고객 현황</span>
        </button>
        {cfg.aiTab && (
          <button className="cat" aria-pressed={view === 'ai'} onClick={() => setView('ai')}>
            AI 평가<span className="cat-sub">신뢰도 · 컴플라이언스 · 활동 감사</span>
          </button>
        )}
      </nav>

      {/* ══════════ 탭 1 · 고객 관리 ══════════ */}
      <div className="view stack" hidden={view !== 'cust'}>
        {/* AI가 오늘 한 일 — 첫 화면에서 "에이전트가 뭘 했나"가 보여야 한다.
            숫자는 전부 훅이 남긴 감사로그 실집계다(없으면 없다고 말한다). */}
        <div className="aiwork">
          <span className="aiwork-label">AI가 오늘 한 일</span>
          {aiwork.length ? (
            <span className="aiwork-body">{aiwork.join(' · ')}</span>
          ) : (
            <span className="aiwork-body muted">
              오늘은 실행 기록이 없습니다 — 브리핑을 생성하면 여기에 표시됩니다.
            </span>
          )}
          {data.summary.today.last_run && (
            <span className="aiwork-time">마지막 실행 {hhmm(data.summary.today.last_run)}</span>
          )}
          <span className="src live">감사로그 실집계</span>
        </div>

        {/* 상담 전 브리핑 (F2) — 오늘 시장 + 내 고객 보유 종목의 밤사이 변화 */}
        <section className="card" aria-labelledby="b-title">
          <div className="card-head">
            <h2 id="b-title">상담 전 브리핑</h2>
            <span className="hint">내 고객 보유 상위 종목 · 전일 공시 · 밤사이 뉴스 · 지연시세</span>
            {data.brief && <span className="hint" style={{ color: 'var(--muted)' }}>{data.brief.brief_date} 생성</span>}
            <span className="src live">DB 실데이터</span>
          </div>
          {data.brief ? (
            <>
              {/* 오늘 시장 — PB가 고객에게 가장 먼저 듣는 질문이 개별 종목이 아니라 시장이다.
                  못 가져왔으면 빈칸으로 두지 않고 미연결 사유를 그대로 말한다. */}
              {data.brief.market?.indices?.length ? (
                <div className="mkt">
                  <span className="mkt-label">오늘 시장</span>
                  {data.brief.market.indices.map((ix) => {
                    const down = isDown(ix.change_pct);
                    return (
                      <span className="mkt-item" key={ix.index_name}>
                        <span className="mkt-name">{ix.index_name}</span>
                        <strong>{Number(ix.close).toLocaleString()}</strong>
                        <span className={`delta ${down ? 'down' : 'up'}`}>
                          {down ? '▼' : '▲'}{fmtPct(ix.change_pct)}%
                        </span>
                        <span className="bcode">· {fmtDate(ix.as_of)} 지연</span>
                      </span>
                    );
                  })}
                </div>
              ) : (
                <div className="mkt off">
                  <span className="mkt-label">오늘 시장</span>
                  <span className="hint">
                    {data.brief.market?.note ?? '이 브리프에는 지수가 포함되지 않았습니다.'}
                  </span>
                </div>
              )}
              <div className="brief-grid">
                {data.brief.items.map((it) => {
                  const q = it.quote;
                  const down = q ? isDown(q.change_pct) : false;
                  const rows = [
                    ...it.disclosures.map((d) => ({ tag: '공시', text: d.report_nm.trim(), href: d.viewer_url, meta: fmtDate(d.rcept_dt) })),
                    ...it.news.map((n) => ({ tag: '뉴스', text: n.title, href: n.link, meta: (n.pub_date || '').slice(0, 16) })),
                  ];
                  return (
                    <div className="bcard" key={it.stock_code}>
                      <div className="bh">
                        <span className="bname">{it.corp_name}</span>
                        <span className="bcode">{it.stock_code}</span>
                        {!!holders.get(it.stock_code) && (
                          <span className="bhold" title="이 종목을 보유한 고객 수 — 브리프 종목 선정 기준">
                            보유 고객 {holders.get(it.stock_code)}명
                          </span>
                        )}
                      </div>
                      {q ? (
                        <div className="bquote">
                          <strong>{Number(q.close).toLocaleString()}원</strong>
                          <span className={`delta ${down ? 'down' : 'up'}`}>{down ? '▼' : '▲'}{fmtPct(q.change_pct)}%</span>
                          <span className="bcode">· {fmtDate(q.as_of)} 지연시세</span>
                        </div>
                      ) : (
                        <div className="bempty">시세 조회 결과 없음</div>
                      )}
                      {rows.length ? rows.map((r, i) => (
                        <div className="bline" key={i}>
                          <span className="btag">{r.tag}</span>
                          <span style={{ minWidth: 0 }}>
                            <a href={r.href || '#'} target="_blank" rel="noreferrer">{r.text}</a>
                            <span className="bcode"> {r.meta}</span>
                          </span>
                        </div>
                      )) : (
                        <div className="bempty">전일 공시·밤사이 뉴스 없음</div>
                      )}
                    </div>
                  );
                })}
              </div>
              {data.brief.violations.length > 0 && (
                <div className="hint" style={{ marginTop: 10, color: 'var(--critical)' }}>
                  ⛔ 컴플라이언스 게이트 미통과 — {data.brief.violations.join(' / ')}
                </div>
              )}
            </>
          ) : (
            <div className="hint" style={{ marginTop: 10 }}>
              아직 생성된 브리프가 없습니다. <code>POST /api/briefs/run</code>으로 배치를 실행하세요.
            </div>
          )}
        </section>

        {/* 타일은 브리핑 다음이다 — PB에게 먼저 필요한 건 카운터가 아니라 오늘 모인 사실이다. */}
        <div className="tile-row">
          {tiles.map((t) => (
            <div className="tile" key={t.label}>
              <div className="label">{t.label}</div>
              <div className="value">{t.value}</div>
              {'gate' in t && t.gate && <div className="sub"><GateMini data={data.summary.gate_blocks_daily} /></div>}
              <div className="breakdown">{t.breakdown}</div>
            </div>
          ))}
        </div>

        {cfg.research && <ResearchCard onNoteCreated={() => void load()} />}

        {/* 검토·승인 대기 */}
        <section className="card" aria-labelledby="q-title">
          <div className="card-head">
            <h2 id="q-title">처리 대기</h2>
            <span className="hint">사람 확인 없이는 어떤 산출물도 고객에게 나가지 않습니다</span>
            {cfg.qScope && <span className="hint" style={{ color: 'var(--accent)', fontWeight: 600 }}>{cfg.qScope}</span>}
            <span className="src live">DB 실데이터</span>
          </div>
          <div className="tabs" role="group" aria-label="대기 항목 필터">
            {(['all', 'note', 'chat'] as const).map((f) => (
              <button key={f} className="tab" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {f === 'all' ? <>전체 <span>{roleQueue.length}</span></> : f === 'note' ? '팩트 노트' : '고객 문의'}
              </button>
            ))}
          </div>
          <div className="queue">
            {roleQueue.filter((it) => filter === 'all' || it.type === filter).map((it) => {
              const [label, cls] = PILL[it.status] ?? [it.status, ''];
              return (
                <div className="qrow" key={`${it.type}-${it.id}`}>
                  <span className={`chip ${it.type}`}>{it.type === 'note' ? '팩트 노트' : '고객 문의'}</span>
                  <span className="title">{it.title}</span>
                  <span className="meta">{it.who} · {ago(it.updated_at)} 경과</span>
                  <span className="spacer" />
                  <span className={`pill ${cls}`}>{label}</span>
                  <button className="btn" onClick={() => openItem(it)}>검토</button>
                </div>
              );
            })}
            {!roleQueue.filter((it) => filter === 'all' || it.type === filter).length && (
              <div className="hint" style={{ padding: '10px 4px' }}>표시할 대기 건이 없습니다.</div>
            )}
          </div>
        </section>

        {/* 고객 포트폴리오 */}
        <section className="card" aria-labelledby="c-title">
          <div className="card-head">
            <h2 id="c-title">고객 포트폴리오</h2>
            <span className="hint">{cfg.portfolio ? (role === 'pb' ? `내 담당 ${roleCustomers.length}명` : `${roleCustomers.length}명`) : '접근 제한'}</span>
            <span className="src mock">시드 데이터 · 전원 가상 인물</span>
          </div>
          {!cfg.portfolio ? (
            <div className="hint" style={{ padding: '16px 4px' }}>
              🔒 준법 권한에서는 고객 개인 포트폴리오(잔고·보유종목)가 표시되지 않습니다 — 위험 플래그·감사로그 요약만 접근 가능합니다.
            </div>
          ) : (
            <>
              <div className="strip">
                <div className="kv">
                  <div className="k">{role === 'pb' ? '담당 고객자산' : '총 고객자산 (AUM)'}</div>
                  <div className="v">{fmtKRW(roleCustomers.reduce((a, c) => a + c.balance, 0))}<span className="unit"> 원</span></div>
                </div>
                <div className="kv">
                  <div className="k">평균 수익률 (연초 대비)</div>
                  <div className={`v delta ${roleCustomers.reduce((a, c) => a + c.ret, 0) >= 0 ? 'up' : 'down'}`} style={{ fontSize: 19 }}>
                    {(() => {
                      const avg = roleCustomers.reduce((a, c) => a + c.ret, 0) / (roleCustomers.length || 1);
                      return `${avg >= 0 ? '+' : ''}${avg.toFixed(1)}%`;
                    })()}
                  </div>
                </div>
                <div className="kv">
                  <div className="k">위험 플래그</div>
                  <div className="v">{flagged}<span className="unit">건</span> <span className="flag">▲</span></div>
                </div>
              </div>
              <div className="cust-layout">
                <div>
                  <input
                    className="search" type="search" placeholder="고객명 검색" aria-label="고객명 검색"
                    value={search} onChange={(e) => setSearch(e.target.value)}
                  />
                  <div className="tbl-scroll">
                    <table aria-label="고객 목록">
                      <thead>
                        <tr><th>고객</th><th className="num">나이</th><th>위험성향</th><th className="num">잔고</th><th className="num">수익률</th><th /></tr>
                      </thead>
                      <tbody>
                        {visibleCustomers.map((c) => (
                          <tr
                            key={c.id} tabIndex={0}
                            aria-selected={selected?.id === c.id}
                            onClick={() => setSelectedId(c.id)}
                            onKeyDown={(e) => { if (e.key === 'Enter') setSelectedId(c.id); }}
                          >
                            <td><strong>{c.name}</strong> <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>{c.acct}</span></td>
                            <td className="num">{c.age}</td>
                            <td><span className="risk-chip">{RISK[c.risk]}</span></td>
                            <td className="num">₩{fmtKRW(c.balance)}</td>
                            <td className={`num delta ${c.ret >= 0 ? 'up' : 'down'}`}>{c.ret >= 0 ? '+' : ''}{c.ret.toFixed(1)}%</td>
                            <td>{c.flag && <span className="flag" title={c.flagReasons.map((r) => r.text).join(' · ')}>▲</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="detail">
                  {selected && (
                    <>
                      <div className="name">{selected.name} {selected.flag && <span className="flag">▲ 위험 플래그</span>}</div>
                      <div className="acct">{selected.acct} · {selected.age}세 · {RISK[selected.risk]}</div>
                      {selected.flag && (
                        <div className="flag-reasons">▲ {selected.flagReasons.map((r) => r.text).join(' · ')}</div>
                      )}
                      <div className="row">
                        <div className="kv"><div className="k">잔고</div><div className="v">₩{fmtKRW(selected.balance)}</div></div>
                        <div className="kv">
                          <div className="k">수익률 (연초 대비)</div>
                          <div className={`v delta ${selected.ret >= 0 ? 'up' : 'down'}`}>{selected.ret >= 0 ? '+' : ''}{selected.ret.toFixed(1)}%</div>
                        </div>
                      </div>
                      <div className="donut-wrap">
                        <Donut alloc={selected.alloc} bind={bind} />
                        <div className="legend">
                          {Object.entries(selected.alloc).map(([k, v], i) => (
                            <div className="li" key={k}>
                              <span className="sw" style={{ background: ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)'][i % 4] }} />
                              {k}<span className="pct">{v}%</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <table className="holdings" aria-label="보유 종목">
                        <tbody>
                          {selected.holdings.map((h) => (
                            <tr key={h.code}>
                              <td>{h.name} <span style={{ color: 'var(--muted)' }}>{h.code}</span></td>
                              <td className="num">₩{fmtKRW(h.amt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <PrepMemo
                        customer={selected}
                        brief={data.brief}
                        notes={data.notes}
                        onAsk={(q) => setModal({ kind: 'f1', q })}
                        onOpenNote={(code) => setModal({ kind: 'note', code })}
                      />
                      <div className="diag"><span className="tag">AI 진단 · 초안·미검증</span>{selected.diag}</div>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      {/* ══════════ 탭 2 · AI 평가 ══════════ */}
      <div className="view" hidden={view !== 'ai'}>
        <div className="grid">
          <div className="col">
            <section className="card" aria-labelledby="tr-title">
              <div className="card-head">
                <h2 id="tr-title">AI 신뢰도</h2>
                <span className="hint">가드레일이 실제로 작동하고 있는지</span>
                <span className="src live">DB 실데이터</span>
              </div>
              <div className="trust">
                <div>
                  <div className="t-label">출처 부착률 <span style={{ color: 'var(--muted)' }}>· 사실 주장 문장</span></div>
                  <div className="t-sub">
                    <span className="t-value">
                      {data.summary.citation_rate === null ? '—' : <>{data.summary.citation_rate}<span className="unit">%</span></>}
                    </span>
                  </div>
                  <div className="meter" role="img" aria-label={`출처 부착률 ${data.summary.citation_rate ?? '측정 불가'}%, 목표 90% 이상`}>
                    <div className="fill" style={{ width: `${data.summary.citation_rate ?? 0}%` }} />
                    <div className="tick" style={{ left: '90%' }} />
                  </div>
                  <div className="meter-scale"><span>0</span><span>목표 ≥90%</span></div>
                  <div className="t-cap">
                    {data.summary.citation_total
                      ? `사실 주장 ${data.summary.citation_total}문장 중 ${data.summary.citation_sourced}문장에 출처 각주가 실제 공시·뉴스와 매칭됨` +
                        ` · 해석·전망 ${data.summary.citation_interpretation}문장은 각주 대상이 아니라 분모에서 제외`
                      : '아직 생성된 노트 문장이 없습니다.'}
                  </div>
                </div>
                <div>
                  <div className="t-label">발행 통과율 <span style={{ color: 'var(--muted)' }}>· 누적</span></div>
                  <div className="t-value">{data.summary.notes_published}<span className="unit"> / {data.summary.notes_total}</span></div>
                  <div className="t-cap">
                    {data.summary.notes_total
                      ? `초안 ${data.summary.notes_total}건 중 발행 ${data.summary.notes_published}건 · 대기 ${data.summary.notes_pending}건`
                      : '아직 생성된 노트가 없습니다.'}
                  </div>
                </div>
                <div>
                  <div className="t-label">게이트 차단 <span style={{ color: 'var(--muted)' }}>· 7일</span></div>
                  <div className="t-sub">
                    <span className="t-value">{data.summary.gate_blocks_7d}</span>
                    <span style={{ marginLeft: 'auto' }}><GateMini data={data.summary.gate_blocks_daily} /></span>
                  </div>
                  <div className="t-cap">
                    미인용·금지표현·MNPI·워터마크 누락으로 발행이 차단된 건수 — 0이 목표가 아니라 게이트가 일한 증거
                  </div>
                </div>
              </div>
            </section>

            <div className="charts2" style={{ marginTop: 16 }}>
              <section className="card chart-box" aria-labelledby="t2">
                <div className="card-head">
                  <h2 id="t2">에이전트 호출 <span className="hint">누적</span></h2>
                  <span className="src live">DB 실데이터</span>
                </div>
                {data.agents.length
                  ? <BarChart rows={data.agents.map((a) => [a.agent, a.calls] as [string, number])} bind={bind} />
                  : <div className="hint" style={{ padding: '20px 4px' }}>아직 에이전트 실행 기록이 없습니다.</div>}
              </section>
              <section className="card chart-box" aria-labelledby="t3">
                <div className="card-head">
                  <h2 id="t3">상담·노트 추이 <span className="hint">14일</span></h2>
                  <span className="src live">실집계</span>
                </div>
                <div className="chart-legend">
                  <span className="li"><span className="key" style={{ background: 'var(--s1)' }} />상담 세션</span>
                  <span className="li"><span className="key" style={{ background: 'var(--s2)' }} />노트 생성</span>
                </div>
                <LineChart
                  days={days.map((d) => d.label)} bind={bind}
                  series={[
                    { name: '상담 세션', data: trend.sessions, color: 'var(--s1)' },
                    { name: '노트 생성', data: trend.notes, color: 'var(--s2)' },
                  ]}
                />
              </section>
            </div>
          </div>

          <div className="col">
            <section className="card" aria-labelledby="f-title">
              <div className="card-head">
                <h2 id="f-title">컴플라이언스 알림</h2>
                <span className="src live">감사로그 집계</span>
              </div>
              <div className="feed">
                {feed.map((f, i) => (
                  <div className="fitem" key={i}>
                    <span className={`ficon sev ${f.sev}`}>{f.icon}</span>
                    <div className="fbody">
                      <div className="fhead">
                        <span className={`sev ${f.sev}`}>{f.sev.toUpperCase()}</span>
                        <span className="ftime">{f.time}</span>
                      </div>
                      <div className="fmsg">{f.msg}</div>
                      <div className="fref">{f.ref}</div>
                    </div>
                  </div>
                ))}
                {!feed.length && <div className="hint" style={{ padding: '10px 4px' }}>차단·거부 기록이 없습니다.</div>}
              </div>
            </section>

            <section className="card" aria-labelledby="a-title">
              <div className="card-head">
                <h2 id="a-title">감사로그 <span className="hint">append-only · 최근 12건</span></h2>
                <span className="src live">DB 실데이터</span>
              </div>
              <div className="audit">
                {data.audit.slice(0, 12).map((a) => (
                  <div className="aitem" key={a.id}>
                    <span className="ats">{hhmm(a.ts)}</span>
                    <span className="aev">{a.event_type}</span>
                    <span className="adet">
                      {[a.note_id && `노트 #${a.note_id}`, a.actor && `actor: ${a.actor}`, detailStr(a.detail)]
                        .filter(Boolean).join(' · ')}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>

      {/* ── 모달 ─────────────────────────────────────────────── */}
      {modal && (
        <div id="overlay" onClick={(e) => { if (e.target === e.currentTarget) setModal(null); }}>
          <div className="modal" role="dialog" aria-modal="true" aria-label="검토 화면">
            {modal.kind === 'note' && data.notes[modal.code] && (
              <NoteModal
                key={modal.code}
                note={data.notes[modal.code]}
                role={role}
                toast={toast}
                onClose={() => setModal(null)}
                onChanged={async () => {
                  await load();
                  return api<NoteDetail>(`/api/notes/${data.notes[modal.code].id}`).catch(() => null);
                }}
              />
            )}
            {modal.kind === 'f1' && <F1Chat initial={modal.q} />}
            {modal.kind === 'chat' && (() => {
              const it = data.queue.find((q): q is QueueChat => q.type === 'chat' && q.id === modal.id);
              const c = it && data.customers.find((x) => x.id === it.customer_id);
              if (!it || !c) return null;
              return (
                <ChatModal
                  item={it} customer={c} role={role} toast={toast}
                  onClose={() => setModal(null)}
                  onChanged={() => void load()}
                />
              );
            })()}
          </div>
        </div>
      )}

      {toastMsg && <div id="toast">{toastMsg}</div>}
      <Tip tip={tip} />
    </div>
  );
}
