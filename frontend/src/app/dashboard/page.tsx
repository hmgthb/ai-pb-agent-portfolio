'use client';

/** AI PB 어시스턴트 (H1) — docs/design/pb-admin-dashboard.html 시안의 React 포팅.
 *
 *  **대상 사용자 = PB**(2026-07-22 확정). 이 화면은 PB가 고객을 만나기 전에 여는 화면이고,
 *  AI는 PB를 대신하지 않는다 — 출처 있는 사실을 모아줄 뿐, 고객에게 나가는 말은 사람이 쓴다.
 *  그래서 기본 역할이 PB이고, 첫 화면에 "오늘 시장 → 고객 보유 종목 → 고객별 상담 준비" 순으로
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
import {
  api,
  ago,
  bizDay,
  detailStr,
  fmtDate,
  fmtKRW,
  fmtPct,
  hhmm,
  isDown,
} from './api';
import { BarChart, Donut, GateMini, LineChart, Tip, useTip } from './charts';
import F1Chat from './F1Chat';
import ResearchCard from './ResearchCard';
import { ChatModal, NoteModal } from './ReviewModal';
import {
  ACTOR,
  actorLabel,
  PILL,
  RISK,
  type AgentCalls,
  type Brief,
  type Customer,
  type DashboardAudit,
  type NoteDetail,
  type NoteIndex,
  type QueueChat,
  type QueueItem,
  type Role,
  type Summary,
} from './types';

/* ── 역할(목 로그인)별 화면 구성 ──────────────────────────── */
const ROLES: Record<
  Role,
  {
    aiTab: boolean;
    portfolio: boolean;
    research: boolean;
    /** 상담 전 브리핑 노출 — 상담 준비는 PB의 일이다. 준법 화면에 띄우면 카드가 자기를
     *  "내 고객 보유 상위"라고 소개하는데, 그 화면을 보는 사람에게 담당 고객은 없다. */
    brief: boolean;
    defaultView: 'cust' | 'ai' | null;
    queueFilter: ((it: QueueItem) => boolean) | null;
    custFilter: ((c: Customer) => boolean) | null;
    /** 큐 제목 옆 범위 라벨. 준법의 "심의 단계 건만" 라벨을 뗀 뒤로는 아무도 안 쓴다(선택). */
    qScope?: string;
  }
> = {
  // 이 화면의 주인. 담당 고객·상담은 **백엔드가 이미 걸러서** 보내므로(main.PB_NAME)
  // 여기서 다시 거를 필요가 없다 — 남의 고객은 애초에 브라우저에 도착하지 않는다.
  // 노트도 거르지 않는다: PB가 1명이니 이 대시보드의 노트는 전부 이 사람 것이다.
  // (예전엔 created_by로 걸렀는데, 생성자가 없는 노트 6건이 큐에서 통째로 사라졌다.)
  pb: {
    aiTab: false,
    portfolio: true,
    research: true,
    brief: true,
    defaultView: 'cust',
    queueFilter: null,
    custFilter: null,
    qScope: '',
  },
  // 준법은 이 대시보드의 사용자가 아니다 — **다른 사람의 화면**을 데모로 미리 보는 모드다.
  // 그래서 고객 포트폴리오가 안 보이고(정보장벽), 심의 단계 노트만 손댈 수 있다.
  comp: {
    aiTab: true,
    portfolio: false,
    research: false,
    brief: false,
    // 준법도 처리할 일(심의 대기 큐)부터 본다 — AI 평가는 지표를 훑는 화면이지
    // 오늘 손댈 것을 알려주지 않는다.
    defaultView: 'cust',
    queueFilter: (it) => it.type === 'note' && it.status === 'deliberation',
    custFilter: null,
  },
};

/* 기능 레일(F1~F5 카드 5장)은 뺐다. 5장 중 눌러서 뭔가 일어나는 건 F1 하나였고, F2·F3는
   같은 파란 테두리를 두르고도 클릭에 반응하지 않아 고장으로 읽혔다(실제 기능은 아래 각자의
   카드에 있다). F4·F5는 만들지 않은 기능의 자리표시였다 — 로드맵은 발표 자료가 할 일이지
   PB가 매일 보는 화면이 할 일이 아니다. F1 입구는 우하단 고정 버튼으로 옮겼다. */

/** 화면(탭). 어떤 탭이 실제로 나오는지는 역할이 정한다 — 아래 TABS 참조.
 *  세 뷰는 전부 **마운트된 채로** `hidden`만 토글한다. 특히 'note' 탭은 1~2분짜리 SSE가
 *  도는 곳이라, 언마운트하면 실행이 끊기고 크레딧만 쓰고 노트가 안 나온다. */
type View = 'cust' | 'note' | 'ai';

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
   앞 칸에 꽂혔다. 기준(bizDay)은 api.ts에 한 벌만 두고 여기서 가져다 쓴다. */
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
   여기서 에이전트를 새로 돌리지 않는다 — 브리프(F2)와 종목 노트(F3)가 출처와 함께 이미 가진
   것을 고객 기준으로 다시 배열할 뿐이다("공통 인프라 1 + 얇은 레이어 N"의 실제 사례).
   확인된 게 없으면 없다고 말한다 — 빈 줄을 그럴듯한 문장으로 채우지 않는다(가드레일 3). */
function PrepMemo({
  customer,
  brief,
  notes,
  onAsk,
  onOpenNote,
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
      </div>
      {rows.map(({ h, b, note }) => {
        const q = b?.quote;
        const down = q ? isDown(q.change_pct) : false;
        const lines = [
          ...(b?.disclosures ?? []).slice(0, 2).map((d) => ({
            tag: '공시',
            text: d.report_nm.trim(),
            href: d.viewer_url,
            meta: fmtDate(d.rcept_dt),
          })),
          ...(b?.news ?? []).slice(0, 1).map((n) => ({
            tag: '뉴스',
            text: n.title,
            href: n.link,
            meta: fmtDate(n.pub_date),
          })),
        ];
        return (
          <div className="prep-row" key={h.code}>
            <div className="prep-name">
              {h.name} <span className="bcode">{h.code}</span>
              {q && (
                <span className="prep-quote">
                  <strong>{Number(q.close).toLocaleString()}원</strong>{' '}
                  <span className={`delta ${down ? 'down' : 'up'}`}>
                    {down ? '▼' : '▲'}
                    {fmtPct(q.change_pct)}%
                  </span>
                  <span className="bcode"> · {fmtDate(q.as_of)} 지연시세</span>
                </span>
              )}
              <span className="spacer" style={{ flex: 1 }} />
              <button
                className="btn mini"
                onClick={() => onAsk(`${h.name} 최근 실적`)}
              >
                이 종목 묻기
              </button>
            </div>
            {lines.map((l, i) => (
              <div className="prep-line" key={i}>
                <span className="btag">{l.tag}</span>
                <a href={l.href || '#'} target="_blank" rel="noreferrer">
                  {l.text}
                </a>
                <span className="bcode"> {l.meta}</span>
              </div>
            ))}
            {note && (
              <div className="prep-line">
                <span className="btag">노트</span>
                <button className="linklike" onClick={() => onOpenNote(h.code)}>
                  {note.corp_name} 종목 노트 열기
                </button>
                <span className="bcode">
                  {' '}
                  · {PILL[note.status]?.[0] ?? note.status}
                </span>
              </div>
            )}
            {!lines.length && !note && (
              <div className="prep-line muted">
                오늘 브리핑·노트에 이 종목은 없습니다. 필요하면 &ldquo;이 종목
                묻기&rdquo;로 바로 확인하세요.
              </div>
            )}
          </div>
        );
      })}
      {!customer.holdings.length && (
        <div className="hint">보유 종목이 없습니다.</div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  // 기본 역할은 PB다 — 이 제품의 사용자가 PB이므로 첫 화면도 PB가 보는 화면이어야 한다.
  const [role, setRole] = useState<Role>('pb');
  const [view, setView] = useState<View>('cust');
  /** 종목 노트 생성이 도는 중인가 — 전용 탭에 있어서 다른 탭을 보고 있으면 실행 여부를
   *  알 수 없다. 탭 라벨의 표시등이 그걸 말한다(1~2분짜리 실행이다). */
  const [noteRunning, setNoteRunning] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'note' | 'chat'>('all');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [modal, setModal] = useState<
    | { kind: 'note'; code: string }
    | { kind: 'chat'; id: number }
    | { kind: 'f1'; q?: string }
    | null
  >(null);
  const [toastMsg, setToastMsg] = useState('');
  /** 새로고침 후에도 마지막으로 보던 화면(역할·탭)을 유지하려고 localStorage에 저장한다.
   *  SSR 초기 렌더는 기본값('pb'/'cust')이어야 하이드레이션이 어긋나지 않으므로, 복원은
   *  마운트 뒤에 한다. 이 플래그가 서기 전에는 저장하지 않는다 — 첫 렌더의 기본값이
   *  저장된 값을 덮어쓰지 않게. */
  const [restored, setRestored] = useState(false);
  const { tip, bind } = useTip();

  const toast = useCallback((m: string) => {
    setToastMsg(m);
    setTimeout(() => setToastMsg(''), 2800);
  }, []);

  // 마운트 시 저장된 역할·탭을 복원한다. 저장된 탭이 그 역할에 실제로 없으면(예: 준법인데
  // 'note') 빈 화면이 되므로, 유효할 때만 복원하고 아니면 기본 화면으로 돌린다.
  /* eslint-disable react-hooks/set-state-in-effect --
     마운트 1회 복원이다. localStorage는 SSR에서 못 읽으니 하이드레이션 불일치를 피하려면
     초기 렌더는 기본값으로 두고 마운트 뒤 여기서 복원해야 한다(브라우저 전용 상태의 정석). */
  useEffect(() => {
    try {
      const savedRole = localStorage.getItem('pb-dash-role');
      const r: Role =
        savedRole === 'comp' || savedRole === 'pb' ? savedRole : 'pb';
      setRole(r);
      const cfgR = ROLES[r];
      const savedView = localStorage.getItem('pb-dash-view');
      const viewOk =
        savedView === 'cust' ||
        (savedView === 'note' && cfgR.research) ||
        (savedView === 'ai' && cfgR.aiTab);
      if (viewOk) setView(savedView as View);
      else setView(cfgR.defaultView ?? 'cust');
    } catch {
      /* localStorage 접근 불가(프라이빗 모드 등) — 기본값 유지 */
    }
    setRestored(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // 역할·탭이 바뀌면 저장한다(복원 이후에만).
  useEffect(() => {
    if (!restored) return;
    try {
      localStorage.setItem('pb-dash-role', role);
      localStorage.setItem('pb-dash-view', view);
    } catch {
      /* 무시 */
    }
  }, [restored, role, view]);

  const load = useCallback(async () => {
    try {
      const [customers, queue, noteIndex, summary, audit, agents, sessions] =
        await Promise.all([
          api<Customer[]>('/api/customers'),
          api<QueueItem[]>('/api/dashboard/queue'),
          api<NoteIndex[]>('/api/notes'),
          api<Summary>('/api/dashboard/summary'),
          api<DashboardAudit[]>('/api/dashboard/audit?limit=200'),
          api<AgentCalls[]>('/api/dashboard/agents'),
          api<Session[]>('/api/sessions'),
        ]);
      // 노트 본문·감사로그는 목록에 없으므로 건별 상세를 따로 받는다.
      // 목록을 큐가 아니라 /api/notes에서 받는 이유: 큐는 발행분을 빼기 때문에, 큐를 쓰면
      // **발행된 노트(= PB가 상담에 써도 되는 유일한 등급)가 상담 준비 메모에서 사라진다.**
      const details = await Promise.all(
        noteIndex.map((n) =>
          api<NoteDetail>(`/api/notes/${n.id}`).catch(() => null),
        ),
      );
      // 종목별 최신 1건. noteIndex는 id 내림차순이므로 먼저 담긴 것이 최신이다
      // (덮어쓰면 같은 종목의 옛 노트가 이기고, 그게 예전 동작이었다).
      const notes: Record<string, NoteDetail> = {};
      details.forEach((d) => {
        if (d && !notes[d.stock_code]) notes[d.stock_code] = d;
      });
      // 브리프는 아직 없을 수 있다(404) — 그건 오류가 아니라 상태다.
      const brief = await api<Brief>('/api/briefs/latest').catch(() => null);
      setData({
        customers,
        queue,
        notes,
        summary,
        audit,
        agents,
        sessions,
        brief,
      });
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // 마운트 시 1회 로딩. 이 화면은 역할 전환·검토 액션이 있는 라이브 콘솔이라 서버
  // 컴포넌트로 미리 받지 않고 클라이언트에서 받는다(액션 후 같은 경로로 갱신).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 마운트 시 데이터 로딩
    void load();
  }, [load]);

  const cfg = ROLES[role];

  /** 이 역할에게 실제로 있는 탭. 하나뿐이면 탭 줄을 아예 내지 않는다(고를 게 없다). */
  const tabs = useMemo(
    () =>
      (
        [
          // 축은 "읽기 / 하기"다. 상담 준비 = 무엇을 알아야 하나(브리핑·고객),
          // 노트·승인 = 내가 손대야 하는 것(생성·처리 대기).
          // 준법은 고객을 관리하지 않는다 — 이 탭이 하는 일은 심의 큐 처리뿐이라
          // "심의"로 부른다(예전 "고객 관리"는 없는 고객 카드를 기대하게 만들었다).
          {
            id: 'cust',
            label: cfg.research ? '상담 준비' : '심의',
            on: true,
          },
          { id: 'note', label: '노트·승인', on: cfg.research },
          { id: 'ai', label: 'AI 평가', on: cfg.aiTab },
        ] as const
      ).filter((t) => t.on),
    [cfg],
  );

  function applyRole(r: Role) {
    setRole(r);
    const next = ROLES[r];
    // 역할을 바꾸면 지금 보던 탭이 없어질 수 있다 — 없으면 그 역할의 기본 화면으로 돌린다.
    // (예: 종목 노트 탭에서 준법으로 넘어가면 준법에는 그 탭이 없다.)
    const stillThere =
      view === 'cust' ||
      (view === 'note' && next.research) ||
      (view === 'ai' && next.aiTab);
    if (next.defaultView) setView(next.defaultView);
    else if (!stillThere) setView('cust');
  }

  const pending = useMemo(
    () =>
      (data?.queue ?? []).filter(
        (it) => !['published', 'done', 'rejected'].includes(it.status),
      ),
    [data],
  );
  const roleQueue = useMemo(
    () => pending.filter((it) => !cfg.queueFilter || cfg.queueFilter(it)),
    [pending, cfg],
  );
  /** 지금 선택된 탭에서 실제로 보이는 건. 목록과 건수 표시가 **같은 값**을 써야 한다 —
   *  따로 세면 필터 조건이 바뀔 때 한쪽만 고치고 넘어가기 쉽다. */
  const shownQueue = useMemo(
    () => roleQueue.filter((it) => filter === 'all' || it.type === filter),
    [roleQueue, filter],
  );
  const roleCustomers = useMemo(
    () =>
      cfg.custFilter
        ? (data?.customers ?? []).filter(cfg.custFilter)
        : (data?.customers ?? []),
    [data, cfg],
  );

  const visibleCustomers = useMemo(
    () => roleCustomers.filter((c) => c.name.includes(search.trim())),
    [roleCustomers, search],
  );

  /* 종목코드 → 이 종목을 보유한 **내 고객** 수. 브리프가 "왜 이 종목인가"를 화면에서 스스로
     설명하게 만든다 — 종목 선정 기준이 내 고객 포트폴리오이기 때문이다(backend pb_watchlist).
     한 벌이면 충분하다: /api/customers가 이미 담당 고객만 주므로 전사 수라는 게 없다.
     예전엔 선정이 전사 기준이라 "보유 21명 · 내 담당 5명"처럼 두 수를 나란히 적어야 했다. */
  const holders = useMemo(() => {
    const m = new Map<string, number>();
    (data?.customers ?? []).forEach((c) =>
      c.holdings.forEach((h) => m.set(h.code, (m.get(h.code) ?? 0) + 1)),
    );
    return m;
  }, [data]);
  const selected = useMemo(
    () =>
      visibleCustomers.find((c) => c.id === selectedId) ??
      visibleCustomers[0] ??
      null,
    [visibleCustomers, selectedId],
  );

  /* 상세에도 표와 **같은 순번**을 보여준다 — 다른 기준으로 세면 왼쪽 표의 3번과
     오른쪽 상세의 3번이 다른 사람을 가리키게 된다. 그래서 표가 그리는 목록
     (visibleCustomers)에서 그대로 센다: 검색 중이면 걸러진 목록 기준이다. */
  const selectedNo = useMemo(
    () =>
      selected
        ? visibleCustomers.findIndex((c) => c.id === selected.id) + 1
        : 0,
    [visibleCustomers, selected],
  );

  /* 추이 — 하드코딩 대신 감사로그·세션에서 집계한다. 데이터가 쌓이기 전에는 대부분 0이고,
     그게 사실이다(없는 과거를 지어내지 않는다). */
  const days = useMemo(() => lastDays(14), []);
  const trend = useMemo(() => {
    const noteByDay = new Map<string, number>();
    (data?.audit ?? [])
      .filter((a) => a.event_type === 'note_created')
      .forEach((a) =>
        noteByDay.set(dayKey(a.ts), (noteByDay.get(dayKey(a.ts)) ?? 0) + 1),
      );
    const sessByDay = new Map<string, number>();
    (data?.sessions ?? []).forEach((s) =>
      sessByDay.set(
        dayKey(s.started_at),
        (sessByDay.get(dayKey(s.started_at)) ?? 0) + 1,
      ),
    );
    return {
      notes: days.map((d) => noteByDay.get(d.key) ?? 0),
      sessions: days.map((d) => sessByDay.get(d.key) ?? 0),
    };
  }, [data, days]);

  /* 컴플라이언스 알림 — 감사로그에서 실제 차단·거부만 뽑는다 */
  const feed = useMemo(() => {
    return (data?.audit ?? [])
      .filter(
        (a) =>
          a.event_type === 'publish_blocked' ||
          (a.event_type === 'permission_check' &&
            (a.detail as { allowed?: boolean }).allowed === false),
      )
      .slice(0, 8)
      .map((a) => {
        const blocked = a.event_type === 'publish_blocked';
        return {
          sev: blocked ? 'critical' : 'warning',
          icon: blocked ? '⛔' : '◆',
          msg: blocked
            ? `발행 차단 — ${detailStr(a.detail) || '게이트 미통과'}`
            : `허용 외 도구 호출 거부 (${(a.detail as { tool_name?: string }).tool_name ?? '알 수 없음'})`,
          ref: [a.note_id && `노트 #${a.note_id}`, a.event_type]
            .filter(Boolean)
            .join(' · '),
          time: hhmm(a.ts),
        };
      });
  }, [data]);

  const openItem = (it: QueueItem) =>
    setModal(
      it.type === 'note'
        ? { kind: 'note', code: it.code }
        : { kind: 'chat', id: it.id },
    );

  /* ── 로딩 / 연결 실패 ────────────────────────────────────── */
  if (error) {
    return (
      <div className="wrap">
        <header className="topbar">
          <div className="brand">AI PB 어시스턴트</div>
        </header>
        <section className="card">
          <div className="card-head">
            <h2>백엔드에 연결하지 못했습니다</h2>
          </div>
          <div className="hint" style={{ padding: '8px 0' }}>
            {error} — <code>docker compose up</code>으로 백엔드(8000)가 떠
            있는지 확인하세요.
            <br />
            목업 데이터로 화면만 보려면 시안 파일{' '}
            <code>docs/design/pb-admin-dashboard.html</code>을 직접 열면 됩니다.
          </div>
          <button className="btn primary" onClick={() => void load()}>
            다시 시도
          </button>
        </section>
      </div>
    );
  }
  if (!data) {
    return <div className="wrap"></div>;
  }

  const noteCount = roleQueue.filter((i) => i.type === 'note').length;
  const chatCount = roleQueue.filter((i) => i.type === 'chat').length;
  const flagged = roleCustomers.filter((c) => c.flag).length;

  /* "AI가 오늘 한 일" — 백엔드가 감사로그에서 센 오늘치만 쓴다(프론트에서 audit 목록을
     세면 최근 N건 제한 때문에 조용히 적게 세인다). **0인 항목은 아예 적지 않는다** —
     "0건"을 나열하면 아무것도 안 한 날도 일한 것처럼 보인다. */
  const today = data.summary.today;
  const briefToday =
    data.brief?.brief_date === days[days.length - 1].key ? data.brief : null;
  const aiwork = [
    briefToday && `상담 전 브리핑 ${briefToday.items.length}종목 수집`,
    today.tool_calls &&
      `에이전트 도구 호출 ${today.tool_calls}건${today.agents ? ` (에이전트 ${today.agents}종)` : ''}`,
    today.chats && `종목 즉답 ${today.chats}건`,
    today.notes && `종목 노트 ${today.notes}건`,
  ].filter((x): x is string => typeof x === 'string');

  const tiles =
    role === 'pb'
      ? [
          // 설명줄은 바로 위 숫자를 쪼갠 것이어야 한다 — 종목 노트·고객 문의는 고객 수가
          // 아니라 처리 대기 건수의 내역이다(6 + 4 = 10).
          {
            label: '담당 고객',
            value: String(roleCustomers.length),
            breakdown: `위험 플래그 ${flagged}`,
          },
          {
            label: '처리 대기',
            value: String(roleQueue.length),
            breakdown: `종목 노트 ${noteCount} · 고객 문의 ${chatCount}`,
            // 큐가 다른 탭으로 갔으므로 이 타일이 그리로 가는 길이 된다 — 첫 화면에서
            // "오늘 할 일"이 사라지지 않게 붙잡아 두는 유일한 고리다.
            go: 'note' as const,
          },
        ]
      : [
          {
            label: '심의 대기',
            value: String(roleQueue.length),
          },
          {
            label: '게이트 차단 (7일)',
            value: String(data.summary.gate_blocks_7d),
            gate: true,
          },
        ];

  /* 처리 대기 카드 — 두 화면이 나눠 갖는다.
     PB에게는 「노트·승인」 탭(만드는 것과 처리하는 것을 같이 두는 곳)에,
     준법에게는 그 탭이 없으므로 원래 자리에 남긴다 — 준법이 큐를 잃으면
     심의할 노트를 화면에서 찾을 방법이 아예 없어진다. */
  const queueCard = (
    <section className="card" aria-labelledby="q-title">
      <div className="card-head">
        <h2 id="q-title">처리 대기</h2>
        {cfg.qScope && (
          <span
            className="hint"
            style={{ color: 'var(--accent)', fontWeight: 600 }}
          >
            {cfg.qScope}
          </span>
        )}
      </div>
      <div className="tabs" role="group" aria-label="대기 항목 필터">
        {(['all', 'note', 'chat'] as const).map((f) => (
          <button
            key={f}
            className="tab"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? '전체' : f === 'note' ? '종목 노트' : '고객 문의'}
          </button>
        ))}
        {/* 건수는 탭마다 붙이지 않고 **선택된 탭의 것 하나만** 낸다 — 세 개를 늘어놓으면
                  지금 보고 있는 게 어느 수인지가 오히려 흐려진다.
                  aria-live: 탭을 바꾸면 목록이 갈리는데 스크린리더에는 그 변화가 안 들린다. */}
        <span className="tab-count" aria-live="polite">
          {shownQueue.length}건
        </span>
      </div>
      <div className="queue">
        {shownQueue.map((it) => {
          const [label, cls] = PILL[it.status] ?? [it.status, ''];
          return (
            <div className="qrow" key={`${it.type}-${it.id}`}>
              <span className={`chip ${it.type}`}>
                {it.type === 'note' ? '종목 노트' : '고객 문의'}
              </span>
              <span className="title">{it.title}</span>
              {/* 담당자(it.who)는 적지 않는다 — 1인용 대시보드에서 이 큐의 건은 전부
                        한 사람 몫이라 "미배정/관리자/박PB"가 구분하는 게 없다. 누가 무엇을
                        했는지는 노트 모달의 확인·심의·발행 줄과 감사로그에 그대로 남는다
                        (거기서는 PB와 준법이 갈리므로 실제로 다른 사람을 가리킨다). */}
              <span className="meta">{ago(it.updated_at)} 경과</span>
              <span className="spacer" />
              <span className={`pill ${cls}`}>{label}</span>
              <button className="btn" onClick={() => openItem(it)}>
                검토
              </button>
            </div>
          );
        })}
        {!shownQueue.length && (
          <div className="hint" style={{ padding: '10px 4px' }}>
            표시할 대기 건이 없습니다.
          </div>
        )}
      </div>
    </section>
  );

  return (
    <div className="wrap">
      <header className="topbar">
        <div className="brand">AI PB 어시스턴트</div>
        <div className="right">
          {/* 역할 전환이 아니라 **화면 전환**이다 — 이 대시보드의 사용자는 PB 한 명이고,
              준법은 이 화면을 같이 쓰는 사람이 아니라 승인 단계를 맡는 다른 사람이다.
              데모에서 그 단계를 보여줘야 해서 미리보기로 남겨 뒀고, 라벨이 그렇게 말한다. */}
          <div
            className="role-toggle"
            role="group"
            aria-label="화면 전환 (목 로그인)"
          >
            {(['pb', 'comp'] as Role[]).map((r) => (
              <button
                key={r}
                aria-pressed={role === r}
                onClick={() => applyRole(r)}
              >
                {r === 'pb' ? 'PB' : '준법'}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* 탭 줄은 **고를 게 둘 이상일 때만** 낸다 — 선택지가 하나뿐인 탭은 고르는 장치가
          아니라 제목일 뿐이다. PB는 고객 관리 + 종목 노트, 준법은 고객 관리 + AI 평가. */}
      {tabs.length > 1 && (
        <nav className="cats" aria-label="대시보드 카테고리">
          {tabs.map((t) => (
            <button
              key={t.id}
              className="cat"
              aria-pressed={view === t.id}
              onClick={() => setView(t.id)}
            >
              {t.label}
              {/* 다른 탭을 보는 동안에도 실행이 도는 걸 알려주는 유일한 신호다. */}
              {t.id === 'note' && noteRunning && (
                <span className="cat-run" title="종목 노트 생성 중">
                  ●
                </span>
              )}
            </button>
          ))}
        </nav>
      )}

      {/* ══════════ 탭 1 · 고객 관리 ══════════ */}
      <div className="view stack" hidden={view !== 'cust'}>
        {/* AI가 오늘 한 일 — 궁금할 때 열어보는 것이지 늘 보고 있을 내용이 아니라 접어 둔다.
            숫자는 전부 훅이 남긴 감사로그 실집계다(없으면 없다고 말한다).
            펼침은 native <details>다 — 직접 만든 토글은 키보드·스크린리더 동작을 다시
            구현해야 하지만 이건 브라우저가 준다. */}
        <details className="aiwork">
          <summary>AI가 오늘 한 일</summary>
          <div className="aiwork-body">
            {aiwork.length ? (
              <span>{aiwork.join(' · ')}</span>
            ) : (
              <span className="muted">
                오늘은 실행 기록이 없습니다. 브리핑을 생성하면 여기에
                표시됩니다.
              </span>
            )}
            {data.summary.today.last_run && (
              <span className="aiwork-time">
                마지막 실행 {hhmm(data.summary.today.last_run)}
              </span>
            )}
          </div>
        </details>

        {/* 오늘 규모(내 담당 고객·내 처리 대기) → 바로 만들 수 있는 것(종목 노트) 순서다.
            "AI가 오늘 한 일" 바로 아래에 오늘의 수치와 조작이 붙고, 그 아래로 읽을거리
            (브리핑·처리 대기·고객)가 이어진다. */}
        {/* 타일은 어느 화면에서나 균등 2열이다. 한때 준법 화면에서만 AI 평가 탭의
            사이드바 격자(2fr 1fr)에 맞췄는데, 두 타일의 무게가 같은데 폭이 다르면
            왼쪽이 더 중요한 것처럼 읽힌다 — 탭 사이 이음매보다 이쪽이 우선이다. */}
        <div className="tile-row">
          {tiles.map((t) => {
            // 갈 곳이 있는 타일은 버튼이다 — div에 onClick만 얹으면 키보드로 못 누른다.
            const go = 'go' in t ? t.go : undefined;
            const Tag = go ? 'button' : 'div';
            return (
              <Tag
                className={`tile${go ? ' clickable' : ''}`}
                key={t.label}
                {...(go
                  ? { type: 'button' as const, onClick: () => setView(go) }
                  : {})}
              >
                <div className="label">
                  {t.label}
                  {go && <span className="tile-go">→</span>}
                </div>
                <div className="value">{t.value}</div>
                {'gate' in t && t.gate && (
                  <div className="sub">
                    <GateMini data={data.summary.gate_blocks_daily} />
                  </div>
                )}
                {/* 설명줄이 없는 타일은 빈 칸을 남기지 않는다(빈 div도 자리를 차지한다).
                    준법 타일엔 breakdown 자체가 없으므로 in 가드로 좁힌다(gate와 같은 패턴). */}
                {'breakdown' in t && t.breakdown && (
                  <div className="breakdown">{t.breakdown}</div>
                )}
              </Tag>
            );
          })}
        </div>

        {/* 상담 전 브리핑 (F2) — 오늘 시장 + 내 고객 보유 상위 종목의 밤사이 변화.
            선정 기준은 내 담당 고객의 보유 수다(backend pb_watchlist) — 배지가 그 근거를 적는다. */}
        <section className="card" aria-labelledby="b-title" hidden={!cfg.brief}>
          <div className="card-head">
            <h2 id="b-title">브리핑</h2>
            {data.brief && (
              <span className="hint" style={{ color: 'var(--muted)' }}>
                {data.brief.brief_date} 생성
              </span>
            )}
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
                          {down ? '▼' : '▲'}
                          {fmtPct(ix.change_pct)}%
                        </span>
                        <span className="bcode">
                          · {fmtDate(ix.as_of)} 지연
                        </span>
                      </span>
                    );
                  })}
                </div>
              ) : (
                <div className="mkt off">
                  <span className="mkt-label">오늘 시장</span>
                  <span className="hint">
                    {data.brief.market?.note ??
                      '이 브리프에는 지수가 포함되지 않았습니다.'}
                  </span>
                </div>
              )}
              <div className="brief-grid">
                {data.brief.items.map((it) => {
                  const q = it.quote;
                  const down = q ? isDown(q.change_pct) : false;
                  const rows = [
                    ...it.disclosures.map((d) => ({
                      tag: '공시',
                      text: d.report_nm.trim(),
                      href: d.viewer_url,
                      meta: fmtDate(d.rcept_dt),
                    })),
                    ...it.news.map((n) => ({
                      tag: '뉴스',
                      text: n.title,
                      href: n.link,
                      meta: fmtDate(n.pub_date),
                    })),
                  ];
                  return (
                    <div className="bcard" key={it.stock_code}>
                      <div className="bh">
                        <span className="bname">{it.corp_name}</span>
                        <span className="bcode">{it.stock_code}</span>
                        {/* 선정 근거를 카드가 스스로 말한다 — 이 종목이 위에 있는 이유가
                            "내 고객 N명이 들고 있어서"이고, 그 N이 이 카드를 건너뛰어도
                            되는지를 정한다. 0명이면 배지를 감추지 않고 0명이라고 적는다. */}
                        <span
                          className="bhold"
                          title="브리프 종목 선정 기준 = 내 담당 고객의 보유 수"
                        >
                          {holders.get(it.stock_code) ?? 0}명 보유
                        </span>
                      </div>
                      {q ? (
                        <div className="bquote">
                          <strong>{Number(q.close).toLocaleString()}원</strong>
                          <span className={`delta ${down ? 'down' : 'up'}`}>
                            {down ? '▼' : '▲'}
                            {fmtPct(q.change_pct)}%
                          </span>
                          <span className="bcode">
                            · {fmtDate(q.as_of)} 지연시세
                          </span>
                        </div>
                      ) : (
                        <div className="bempty">시세 조회 결과 없음</div>
                      )}
                      {rows.length ? (
                        rows.map((r, i) => (
                          <div className="bline" key={i}>
                            <span className="btag">{r.tag}</span>
                            <span style={{ minWidth: 0 }}>
                              <a
                                href={r.href || '#'}
                                target="_blank"
                                rel="noreferrer"
                              >
                                {r.text}
                              </a>
                              <span className="bcode"> {r.meta}</span>
                            </span>
                          </div>
                        ))
                      ) : (
                        <div className="bempty">전일 공시·밤사이 뉴스 없음</div>
                      )}
                    </div>
                  );
                })}
              </div>
              {data.brief.violations.length > 0 && (
                <div
                  className="hint"
                  style={{ marginTop: 10, color: 'var(--critical)' }}
                >
                  ⛔ 컴플라이언스 게이트 미통과 —{' '}
                  {data.brief.violations.join(' / ')}
                </div>
              )}
            </>
          ) : (
            <div className="hint" style={{ marginTop: 10 }}>
              아직 생성된 브리프가 없습니다. <code>POST /api/briefs/run</code>
              으로 배치를 실행하세요.
            </div>
          )}
        </section>

        {/* 처리 대기는 노트·승인 탭으로 옮겼다(PB). 준법은 그 탭이 없어 여기 남는다. */}
        {!cfg.research && queueCard}

        {/* 고객 포트폴리오 — PB 전용. 준법은 정보장벽으로 고객 개인정보를 안 보므로 카드
            자체를 렌더하지 않는다(예전엔 "접근 제한"만 든 빈 카드가 화면 최하단을 차지했다).
            정보장벽 자체는 서버 스코핑(남의 고객 404)이 보장한다 — 빈 카드로 광고할 게 아니다. */}
        {cfg.portfolio && (
          <section className="card" aria-labelledby="c-title">
            <div className="card-head">
              <h2 id="c-title">고객 포트폴리오</h2>
              <span className="hint">{roleCustomers.length}명</span>
            </div>
            <>
              <div className="strip">
                <div className="kv">
                  <div className="k">담당 고객자산</div>
                  <div className="v">
                    {fmtKRW(roleCustomers.reduce((a, c) => a + c.balance, 0))}
                    <span className="unit"> 원</span>
                  </div>
                </div>
                <div className="kv">
                  <div className="k">평균 수익률 (연초 대비)</div>
                  <div
                    className={`v delta ${roleCustomers.reduce((a, c) => a + c.ret, 0) >= 0 ? 'up' : 'down'}`}
                    style={{ fontSize: 19 }}
                  >
                    {(() => {
                      const avg =
                        roleCustomers.reduce((a, c) => a + c.ret, 0) /
                        (roleCustomers.length || 1);
                      return `${avg >= 0 ? '+' : ''}${avg.toFixed(1)}%`;
                    })()}
                  </div>
                </div>
                <div className="kv">
                  <div className="k">위험 플래그</div>
                  <div className="v">
                    {flagged}
                    <span className="unit">건</span>{' '}
                  </div>
                </div>
              </div>
              <div className="cust-layout">
                <div>
                  <input
                    className="search"
                    type="search"
                    placeholder="고객명 검색"
                    aria-label="고객명 검색"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                  <div className="tbl-scroll">
                    <table aria-label="고객 목록">
                      <thead>
                        <tr>
                          {/* 순번은 고객 id가 아니라 **지금 보이는 목록에서의 자리**다.
                              검색으로 걸러지면 1부터 다시 매겨진다 — 몇 번째 줄인지
                              가리키는 용도이지 고객을 식별하는 번호가 아니다. */}
                          <th className="num rownum">#</th>
                          <th>고객</th>
                          <th className="num">나이</th>
                          <th>위험성향</th>
                          <th className="num">잔고</th>
                          <th className="num">수익률</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {visibleCustomers.map((c, i) => (
                          <tr
                            key={c.id}
                            tabIndex={0}
                            aria-selected={selected?.id === c.id}
                            onClick={() => setSelectedId(c.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') setSelectedId(c.id);
                            }}
                          >
                            <td className="num rownum">{i + 1}</td>
                            <td>
                              <strong>{c.name}</strong>{' '}
                              <span
                                style={{
                                  color: 'var(--muted)',
                                  fontSize: 11.5,
                                }}
                              >
                                {c.acct}
                              </span>
                            </td>
                            <td className="num">{c.age}</td>
                            <td>
                              <span className="risk-chip">{RISK[c.risk]}</span>
                            </td>
                            <td className="num">₩{fmtKRW(c.balance)}</td>
                            <td
                              className={`num delta ${c.ret >= 0 ? 'up' : 'down'}`}
                            >
                              {c.ret >= 0 ? '+' : ''}
                              {c.ret.toFixed(1)}%
                            </td>
                            <td>
                              {c.flag && (
                                <span
                                  className="flag"
                                  title={c.flagReasons
                                    .map((r) => r.text)
                                    .join(' · ')}
                                >
                                  ▲
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="detail">
                  {selected && (
                    <>
                      <div className="name">
                        <span className="rowno">{selectedNo}</span>
                        {selected.name}{' '}
                        {selected.flag && (
                          <span className="flag">▲ 위험 플래그</span>
                        )}
                      </div>
                      <div className="acct">
                        {selected.acct} · {selected.age}세 ·{' '}
                        {RISK[selected.risk]}
                      </div>
                      {selected.flag && (
                        <div className="flag-reasons">
                          ▲{' '}
                          {selected.flagReasons.map((r) => r.text).join(' · ')}
                        </div>
                      )}
                      <div className="row">
                        <div className="kv">
                          <div className="k">잔고</div>
                          <div className="v">₩{fmtKRW(selected.balance)}</div>
                        </div>
                        <div className="kv">
                          <div className="k">수익률 (연초 대비)</div>
                          <div
                            className={`v delta ${selected.ret >= 0 ? 'up' : 'down'}`}
                          >
                            {selected.ret >= 0 ? '+' : ''}
                            {selected.ret.toFixed(1)}%
                          </div>
                        </div>
                      </div>
                      <div className="donut-wrap">
                        <Donut alloc={selected.alloc} bind={bind} />
                        <div className="legend">
                          {Object.entries(selected.alloc).map(([k, v], i) => (
                            <div className="li" key={k}>
                              <span
                                className="sw"
                                style={{
                                  background: [
                                    'var(--s1)',
                                    'var(--s2)',
                                    'var(--s3)',
                                    'var(--s4)',
                                  ][i % 4],
                                }}
                              />
                              {k}
                              <span className="pct">{v}%</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <table className="holdings" aria-label="보유 종목">
                        <tbody>
                          {selected.holdings.map((h) => (
                            <tr key={h.code}>
                              <td>
                                {h.name}{' '}
                                <span style={{ color: 'var(--muted)' }}>
                                  {h.code}
                                </span>
                              </td>
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
                      <div className="diag">
                        <span className="tag">AI 진단 · 초안·미검증</span>
                        {selected.diag}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </>
          </section>
        )}
      </div>

      {/* ══════════ 탭 2 · 종목 노트 (F3) ══════════
          `hidden`으로 감출 뿐 **언마운트하지 않는다** — 실행이 1~2분 걸리는데 언마운트되면
          ResearchCard가 스트림을 닫아(§ResearchCard의 cleanup) 노트가 안 나온다.
          그래서 생성을 걸어두고 고객 관리 탭으로 건너가도 계속 돈다. */}
      {cfg.research && (
        <div className="view stack" hidden={view !== 'note'}>
          <ResearchCard
            actor={ACTOR[role]}
            onNoteCreated={() => void load()}
            onRunningChange={setNoteRunning}
          />
          {queueCard}
        </div>
      )}

      {/* ══════════ 탭 3 · AI 평가 ══════════ */}
      <div className="view stack" hidden={view !== 'ai'}>
        <div className="grid">
          <div className="col">
            <section className="card" aria-labelledby="tr-title">
              <div className="card-head">
                <h2 id="tr-title">AI 신뢰도</h2>
                <span className="src live">DB 실데이터</span>
              </div>
              <div className="trust">
                <div>
                  <div className="t-label">
                    출처 부착률{' '}
                    <span style={{ color: 'var(--muted)' }}>
                      · 사실 주장 문장
                    </span>
                  </div>
                  <div className="t-sub">
                    <span className="t-value">
                      {data.summary.citation_rate === null ? (
                        '—'
                      ) : (
                        <>
                          {data.summary.citation_rate}
                          <span className="unit">%</span>
                        </>
                      )}
                    </span>
                  </div>
                  <div
                    className="meter"
                    role="img"
                    aria-label={`출처 부착률 ${data.summary.citation_rate ?? '측정 불가'}%, 목표 90% 이상`}
                  >
                    <div
                      className="fill"
                      style={{ width: `${data.summary.citation_rate ?? 0}%` }}
                    />
                    <div className="tick" style={{ left: '90%' }} />
                  </div>
                  <div className="meter-scale">
                    <span>0</span>
                    <span>목표 ≥90%</span>
                  </div>
                  <div className="t-cap">
                    {data.summary.citation_total
                      ? `사실 주장 ${data.summary.citation_total}문장 중 ${data.summary.citation_sourced}문장에 출처 각주가 실제 공시·뉴스와 매칭됨` +
                        ` · 해석·전망 ${data.summary.citation_interpretation}문장은 각주 대상이 아니라 분모에서 제외`
                      : '아직 생성된 노트 문장이 없습니다.'}
                  </div>
                </div>
                <div>
                  <div className="t-label">
                    발행 통과율{' '}
                    <span style={{ color: 'var(--muted)' }}>· 누적</span>
                  </div>
                  <div className="t-value">
                    {data.summary.notes_published}
                    <span className="unit"> / {data.summary.notes_total}</span>
                  </div>
                  <div className="t-cap">
                    {data.summary.notes_total
                      ? `초안 ${data.summary.notes_total}건 중 발행 ${data.summary.notes_published}건 · 대기 ${data.summary.notes_pending}건`
                      : '아직 생성된 노트가 없습니다.'}
                  </div>
                </div>
                <div>
                  <div className="t-label">
                    게이트 차단{' '}
                    <span style={{ color: 'var(--muted)' }}>· 7일</span>
                  </div>
                  <div className="t-sub">
                    <span className="t-value">
                      {data.summary.gate_blocks_7d}
                    </span>
                    <span style={{ marginLeft: 'auto' }}>
                      <GateMini data={data.summary.gate_blocks_daily} />
                    </span>
                  </div>
                  <div className="t-cap">
                    미인용·금지표현·MNPI·워터마크 누락으로 발행이 차단된 건수 —
                    0이 목표가 아니라 게이트가 일한 증거
                  </div>
                </div>
              </div>
            </section>

            {/* 간격은 바깥 .col의 gap(16px)이 준다 — marginTop을 또 주면 이 줄만
                32px로 벌어져 고객 관리 탭의 카드 간격(.stack, 16px)과 어긋난다. */}
            <div className="charts2">
              <section className="card chart-box" aria-labelledby="t2">
                <div className="card-head">
                  <h2 id="t2">
                    에이전트 호출 <span className="hint">누적</span>
                  </h2>
                  <span className="src live">DB 실데이터</span>
                </div>
                {data.agents.length ? (
                  <BarChart
                    rows={data.agents.map(
                      (a) => [a.agent, a.calls] as [string, number],
                    )}
                    bind={bind}
                  />
                ) : (
                  <div className="hint" style={{ padding: '20px 4px' }}>
                    아직 에이전트 실행 기록이 없습니다.
                  </div>
                )}
              </section>
              <section className="card chart-box" aria-labelledby="t3">
                <div className="card-head">
                  <h2 id="t3">
                    상담·노트 추이 <span className="hint">14일</span>
                  </h2>
                  <span className="src live">실집계</span>
                </div>
                <div className="chart-legend">
                  <span className="li">
                    <span className="key" style={{ background: 'var(--s1)' }} />
                    상담 세션
                  </span>
                  <span className="li">
                    <span className="key" style={{ background: 'var(--s2)' }} />
                    노트 생성
                  </span>
                </div>
                <LineChart
                  days={days.map((d) => d.label)}
                  bind={bind}
                  series={[
                    {
                      name: '상담 세션',
                      data: trend.sessions,
                      color: 'var(--s1)',
                    },
                    {
                      name: '노트 생성',
                      data: trend.notes,
                      color: 'var(--s2)',
                    },
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
                        <span className={`sev ${f.sev}`}>
                          {f.sev.toUpperCase()}
                        </span>
                        <span className="ftime">{f.time}</span>
                      </div>
                      <div className="fmsg">{f.msg}</div>
                      <div className="fref">{f.ref}</div>
                    </div>
                  </div>
                ))}
                {!feed.length && (
                  <div className="hint" style={{ padding: '10px 4px' }}>
                    차단·거부 기록이 없습니다.
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>

        {/* 감사로그는 좁은 사이드바에 두면 event_type·detail이 잘린다 —
            전폭으로 내려 한 줄에 담기게 한다. */}
        <section className="card" aria-labelledby="a-title">
          <div className="card-head">
            <h2 id="a-title">
              감사로그 <span className="hint">append-only · 최근 12건</span>
            </h2>
            <span className="src live">DB 실데이터</span>
          </div>
          <div className="audit">
            {data.audit.slice(0, 12).map((a) => (
              <div className="aitem" key={a.id}>
                <span className="ats">{hhmm(a.ts)}</span>
                <span className="aev">{a.event_type}</span>
                <span className="adet">
                  {[
                    a.note_id && `노트 #${a.note_id}`,
                    a.actor && `actor: ${actorLabel(a.actor)}`,
                    detailStr(a.detail),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ── 전체 고지 (맨 아래) ──────────────────────────────
          화면 전체에 걸리는 고지다. 개별 산출물은 각자 자기 고지를 달고 다닌다 —
          종목 노트=워터마크(ReviewModal) · F1 답변=지연시세 고지(F1Chat).
          ⚠ 상담 전 브리핑 카드만 예외다: 백엔드가 만든 "ℹ 내부 참고용" 고지가
          content_md에 있는데 화면 타입(Brief)에 그 필드가 없어 카드가 그리지 않는다.
          이 줄이 위에 있을 땐 그게 가려졌지만, 아래로 내린 지금은 브리핑이 첫 화면에서
          고지 없이 보인다 — 카드 자체 고지를 붙이는 게 맞다(미결). */}
      <p className="disclaimer" role="note">
        <span className="dot" aria-hidden="true">
          ⚠
        </span>{' '}
        투자권유·광고가 아닙니다. AI는 공개 공시·뉴스·지연시세에서 출처 있는
        사실만 모읍니다. 고객에게 나가는 말은 PB가 직접 쓰고, AI 산출물은 전부
        초안·미검증이며, 발행·전달은 사람의 검토·심의·승인 후에만 가능합니다.
      </p>

      {/* ── 종목 즉답(F1) 입구 ────────────────────────────────
          화면에서 이것만 성격이 다르다 — 나머지는 상담 **전** 준비인데 F1은 상담 **중**
          쓴다. 그래서 스크롤 위치와 무관하게 고정이고(고객 표를 보다가도 바로 누른다),
          본문 흐름에는 끼지 않으며, 모달로 열려 보고 있던 화면을 잃지 않는다.
          준법 화면에는 띄우지 않는다 — 에이전트를 돌려 산출물을 만드는 쪽은 PB고,
          준법은 그걸 통과시키는 쪽이다(cfg.research와 같은 경계). */}
      {cfg.research && !modal && (
        <button className="fab" onClick={() => setModal({ kind: 'f1' })}>
          <span aria-hidden="true">💬</span> 종목 즉답
        </button>
      )}

      {/* ── 모달 ─────────────────────────────────────────────── */}
      {modal && (
        <div
          id="overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="검토 화면"
          >
            {modal.kind === 'note' && data.notes[modal.code] && (
              <NoteModal
                key={modal.code}
                note={data.notes[modal.code]}
                role={role}
                toast={toast}
                onClose={() => setModal(null)}
                onChanged={async () => {
                  await load();
                  return api<NoteDetail>(
                    `/api/notes/${data.notes[modal.code].id}`,
                  ).catch(() => null);
                }}
              />
            )}
            {modal.kind === 'f1' && <F1Chat initial={modal.q} />}
            {modal.kind === 'chat' &&
              (() => {
                const it = data.queue.find(
                  (q): q is QueueChat => q.type === 'chat' && q.id === modal.id,
                );
                const c =
                  it && data.customers.find((x) => x.id === it.customer_id);
                if (!it || !c) return null;
                return (
                  <ChatModal
                    item={it}
                    customer={c}
                    role={role}
                    toast={toast}
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
