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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import './dashboard.css';
import {
  api,
  apiDelete,
  apiPost,
  ago,
  bizDay,
  detailStr,
  errorMessage,
  fmtDate,
  fmtDateTime,
  fmtKRW,
  fmtPct,
  hhmm,
  isDown,
} from './api';
import {
  ALLOC_COLORS,
  allocEntries,
  Donut,
  GateMini,
  Tip,
  useTip,
} from './charts';
import F1Chat, { type ChatKeep, type ChatPrefill } from './F1Chat';
import PrepMemo from './PrepMemo';
import ResearchCard from './ResearchCard';
import { ChatModal, NoteModal } from './ReviewModal';
import {
  ACTOR,
  actorLabel,
  PILL,
  PORTFOLIO_CHIPS,
  RISK,
  type AgentCalls,
  type Brief,
  type ChatRedaction,
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
  },
  // 준법은 이 대시보드의 사용자가 아니다 — **다른 사람의 화면**을 데모로 미리 보는 모드다.
  // 그래서 고객 포트폴리오가 안 보이고(정보장벽), 심의 단계 노트만 손댈 수 있다.
  comp: {
    aiTab: true,
    portfolio: false,
    research: false,
    brief: false,
    // 준법도 처리할 일(심의 대기 큐)부터 본다 — 감시 탭은 지표를 훑는 화면이지
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

/* ── 라이트/다크 전환 — 바이낸스 top-nav 오른쪽 묶음에 있는 그 토글 ──────────────
   처음 열면 **라이트**다(layout.tsx가 <html data-theme="light">를 서버에서 박는다).
   ⚠️ CSS 쪽 기본은 여전히 다크다 — dashboard.css의 :root가 다크 토큰이고 라이트는
      [data-theme='light'] 블록이다. 바꾼 건 토큰이 아니라 **속성이 없을 때가 아니라
      항상 붙어 있게 한 것**이라, 두 파일을 같이 봐야 기본값이 읽힌다.
   OS 설정(prefers-color-scheme)은 따라가지 않는다 — 고른 값만 반영한다.

   테마의 **정본은 React 상태가 아니라 DOM 속성**이다: 첫 페인트 전에 layout.tsx의
   부트스트랩 스크립트가 이미 값을 써 놓기 때문이다(그래야 라이트 사용자가 검은 화면을
   안 본다). 그래서 useState로 따로 들고 있으면 두 개의 진실이 생겨 버튼 라벨과 실제
   화면이 어긋난다 — 외부 저장소를 구독하는 useSyncExternalStore가 이 경우의 도구다.
   (useEffect + setState로 맞추는 방식은 React 컴파일러 규칙에도 걸린다:
    react-hooks/set-state-in-effect.) */
type Theme = 'dark' | 'light';
const themeListeners = new Set<() => void>();

const readTheme = (): Theme =>
  document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
/** 서버 렌더·하이드레이션 시점의 값. layout.tsx가 <html>에 박는 값과 같아야 화면이 안 튄다. */
const serverTheme = (): Theme => 'light';

function subscribeTheme(cb: () => void) {
  themeListeners.add(cb);
  return () => {
    themeListeners.delete(cb);
  };
}

function writeTheme(next: Theme) {
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('pb-theme', next);
  } catch {
    /* 저장이 막힌 환경(사생활 보호 모드)에서도 이번 세션 동안은 전환이 산다 */
  }
  themeListeners.forEach((l) => l());
}

function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme, serverTheme);
  const label = theme === 'dark' ? '라이트 테마로 전환' : '다크 테마로 전환';
  return (
    <button
      className="theme-toggle"
      onClick={() => writeTheme(theme === 'dark' ? 'light' : 'dark')}
      aria-label={label}
      title={label}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
    </button>
  );
}

/** 화면(탭). 어떤 탭이 실제로 나오는지는 역할이 정한다 — 아래 TABS 참조.
 *  세 뷰는 전부 **마운트된 채로** `hidden`만 토글한다. 특히 'note' 탭은 1~2분짜리 SSE가
 *  도는 곳이라, 언마운트하면 실행이 끊기고 크레딧만 쓰고 노트가 안 나온다. */
type View = 'cust' | 'note' | 'ai';

type Data = {
  customers: Customer[];
  queue: QueueItem[];
  notes: Record<string, NoteDetail>;
  /** 노트 전건 색인(id 내림차순). notes는 종목별 최신 1건만 담아서 감사로그 필터를
   *  못 만든다 — 같은 종목의 옛 노트(예: 기아 #8)가 키에서 밀려나기 때문이다. */
  noteList: NoteIndex[];
  summary: Summary;
  audit: DashboardAudit[];
  agents: AgentCalls[];
  /* ⚠️ `sessions`를 여기 다시 넣지 말 것(2026-07-30에 뺐다). `/api/sessions`를 받아
     담아 두기만 하고 **읽는 곳이 한 군데도 없었다** — 화면에 닿는 상담 데이터는 큐
     (`pending`만)와 `summary.sessions_pending`뿐이다. 문의 상세가 필요해지면 그때
     라우트를 다시 부르되, 쓰는 자리와 같이 들여올 것. */
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

/* ── 감사로그 표시 도우미 ─────────────────────────────────────
   이벤트를 성격별로 묶어(차단/발행/사람/도구) 색으로 구분한다 — 한눈에 스캔되게.
   permission_check는 거부된 것만 '차단'이고 통과는 일상(도구)이라 detail로 가른다. */
type AuditCat = 'block' | 'publish' | 'human' | 'tool';
const AUDIT_CAT: Record<string, AuditCat> = {
  publish_blocked: 'block',
  mnpi_warning: 'block',
  published: 'publish',
  review_started: 'human',
  deliberation_started: 'human',
  note_created: 'human',
  ack_added: 'human',
  ack_removed: 'human',
  session_approved: 'human',
  session_rejected: 'human',
  // 거절 2종도 사람의 판단이다 — 게이트 차단(block)과 **같은 칸에 두지 않는다**.
  // 저건 기계가 막은 것이고 이건 사람이 안 된다고 한 것이라, 색이 같으면 감사로그에서
  // "AI가 막힌 건수"를 셀 때 사람 판단이 섞인다.
  deliberation_rejected: 'human',
  note_discarded: 'human',
  // 브리프를 만든 건 에이전트지만(tool) **치운 건 사람이다** — 같은 칸에 두면 원장에서
  // "AI가 한 일"을 셀 때 사람이 지운 것이 섞인다.
  brief_deleted: 'human',
  brief_created: 'tool',
  chat_answered: 'tool',
  tool_use_start: 'tool',
  tool_use_end: 'tool',
};
function auditCat(a: DashboardAudit): AuditCat {
  if (a.event_type === 'permission_check')
    return (a.detail as { allowed?: boolean } | null)?.allowed === false
      ? 'block'
      : 'tool';
  return AUDIT_CAT[a.event_type] ?? 'tool';
}
/** 감사로그 행의 "언제" — `7/28 15:31`. 행이 수백 개라 연도를 뗀다(전부 최근 것이다).
 *  연도까지 필요한 자리("AI가 오늘 한 일"의 마지막 실행)는 `fmtDateTime`을 그대로 쓴다.
 *  ⚠️ 날짜·시각 조립은 `api.ts::fmtDateTime` 한 곳뿐이어야 한다 — 화면마다 잘라 쓰다
 *     `뉴스 Wed, 22 Ju`가 사용자에게 나간 적이 있고, 날짜를 UTC로 찍는 사고도 있었다. */
const whenLabel = (iso: string) => fmtDateTime(iso).slice(5).replace('-', '/');
const AUDIT_PAGE = 20;

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
  const [auditPage, setAuditPage] = useState(0);
  /** 감사로그를 노트 한 건으로 좁힌다(null = 전체 최근 200건).
   *  노트를 고르면 **그 노트의 전건**을 따로 받는다 — 전체 목록은 최근 200건 창인데
   *  감사로그의 87%가 도구 호출이라, 노트 13건 중 9건은 그 창 안에 한 줄도 없다.
   *  (원장 자체는 append-only로 전건 보존이고, 못 보던 건 화면의 창이었다.) */
  const [auditNote, setAuditNote] = useState<number | null>(null);
  const [noteAudit, setNoteAudit] = useState<DashboardAudit[]>([]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [modal, setModal] = useState<
    | { kind: 'note'; code: string }
    | { kind: 'chat'; id: number }
    /* `f1`은 여는 신호일 뿐 질문을 실어 오지 않는다(예전 `q`는 걷어냈다) — 이 모달은
       닫아도 언마운트되지 않으므로(아래 오버레이 주석) 마운트 시점에만 읽는 prop은
       두 번째 열기부터 조용히 무시된다. 채워 열어야 하면 고객 카드처럼 `prefill`로 넘길 것. */
    | { kind: 'f1' }
    | null
  >(null);
  /** 전역 F1 답변이 도는 중인가 — 모달을 닫아도 스트림은 계속 돈다(언마운트하지 않는다).
   *  닫아 둔 동안 그 사실을 말할 자리는 고정 버튼뿐이다. */
  const [f1Running, setF1Running] = useState(false);
  /** 고객 문의 모달의 대화를 **문의별로** 들고 있는 자리. 그 모달은 닫으면 언마운트되므로
   *  (전역 F1처럼 감춰 둘 수 없다 — 감추면 어느 문의의 대화인지가 사라진다) 대화를 여기
   *  페이지 쪽에 둔다. ⚠️ **고객 카드 채팅에는 넘기지 않는다** — 그쪽은 고객을 바꾸면 새로
   *  시작하는 것이 결정이다(`key={selected.id}`).
   *  ⚠️ `useRef`가 아니라 `useState`인 건 규칙 때문이다 — 렌더 중에 `ref.current`를 읽어
   *     자식에게 넘기면 `react-hooks/refs`가 잡는다. 초기화 함수로 주면 **한 번만** 만들어지고
   *     같은 Map이 계속 넘어간다(값을 바꾸지 않으므로 리렌더도 유발하지 않는다). */
  const [chatKeep] = useState<ChatKeep>(() => new Map());
  const [toastMsg, setToastMsg] = useState('');
  /** 고객 카드 안 채팅의 입력창을 채우는 신호(보유 종목 칩).
   *  같은 종목을 두 번 눌러도 다시 채워지도록 n을 올린다 — q만 보면 값이 같아 구분되지 않는다.
   *  상담 준비 메모에도 같은 일을 하는 "이 종목 묻기" 버튼이 있었는데, 칩이 보유 종목
   *  전부를 이미 덮어(둘 다 customer.holdings) 같은 동작이 두 곳에 있었다 → 버튼을 뺐다. */
  const [prefill, setPrefill] = useState<ChatPrefill | null>(null);
  const askHolding = (q: string) =>
    setPrefill((p) => ({ q, n: (p?.n ?? 0) + 1 }));
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
      const [customers, queue, noteIndex, summary, audit, agents] =
        await Promise.all([
          api<Customer[]>('/api/customers'),
          api<QueueItem[]>('/api/dashboard/queue'),
          api<NoteIndex[]>('/api/notes'),
          api<Summary>('/api/dashboard/summary'),
          api<DashboardAudit[]>('/api/dashboard/audit?limit=200'),
          api<AgentCalls[]>('/api/dashboard/agents'),
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
        // ⚠️ 보류된 노트는 **상담 재료가 아니다** — PB가 직접 버린 물건이다.
        //    거르지 않으면 같은 종목의 옛 발행분을 이 최신 1건이 덮어, 상담 준비 메모에서
        //    "PB가 상담에 실제로 써도 되는 유일한 등급"이 사라진다(HANDOFF §2와 같은 사고).
        //    감사로그 노트별 조회(noteList)에는 그대로 남으므로 추적은 끊기지 않는다.
        if (d && d.status !== 'rejected' && !notes[d.stock_code])
          notes[d.stock_code] = d;
      });
      // 브리프는 아직 없을 수 있다(404) — 그건 오류가 아니라 상태다.
      const brief = await api<Brief>('/api/briefs/latest').catch(() => null);
      setData({
        customers,
        queue,
        notes,
        noteList: noteIndex,
        summary,
        audit,
        agents,
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

  /* 노트를 고르면 그 노트의 전건을 따로 받아 온다. 전체 목록(data.audit)과 합치지
     않는다 — 한쪽은 최근 200건 "창"이고 한쪽은 "전건"이라, 섞으면 지금 무엇을 보고
     있는지가 흐려진다. 화면도 둘 중 하나만 그린다. */
  useEffect(() => {
    if (auditNote === null) return;
    let alive = true;
    api<DashboardAudit[]>(`/api/dashboard/audit?note_id=${auditNote}`)
      .then((rows) => alive && setNoteAudit(rows))
      .catch(() => alive && setNoteAudit([]));
    return () => {
      alive = false;
    };
  }, [auditNote]);

  /** 보내기 전 경고용 명단. 이미 화면(고객 표)에 그려지는 값이라 새로 노출되는 건 없다.
   *  ⚠️ 이건 알림일 뿐이고 판정 권위는 백엔드(`compliance.egress_guard`)에 있다. */
  const customerNames = useMemo(
    () => (data?.customers ?? []).map((c) => c.name),
    [data?.customers],
  );

  /* ── 브리핑 실행 (F2) ────────────────────────────────────────────────
     예전엔 빈 카드가 `POST /api/briefs/run`을 문구로 알려 주고 끝이었다 — 화면 안에서
     끝낼 수 있는 일을 터미널로 내보내고 있었다.

     이 버튼은 크레딧을 쓴다(에이전트 팬아웃 + 40~50초). 그래도 **확인 단계를 두지 않는다** —
     한 번 눌렀다가 물리려면 다시 누르면 되고(노트 보류·반려처럼 되돌릴 수 없는 조작이
     아니다), 자주 쓰는 버튼에 두 번 누르기를 걸면 비용이 이득을 넘는다.
     자리는 둘이고 생김새가 다르다: 브리프가 **없으면** 빈 상태 본문의 1차 CTA(`브리핑`,
     옐로), **있으면** 머리말 오른쪽의 조용한 버튼(`↻ 다시 생성`, 옐로 아님).
     진행 표시가 라벨 하나뿐인 건 이 라우트가 SSE가 아니라 **블로킹 POST**여서다. F3처럼
     단계를 보여주려면 백엔드에 스트림 라우트가 따로 필요하다(HANDOFF §7). */
  const [briefRunning, setBriefRunning] = useState(false);
  const [briefError, setBriefError] = useState('');

  const runBrief = useCallback(async () => {
    setBriefError('');
    setBriefRunning(true);
    try {
      const r = await apiPost('/api/briefs/run', {});
      if (!r.ok) {
        setBriefError(errorMessage(r.body, '브리핑 생성에 실패했습니다.'));
        return;
      }
      // 카드만이 아니라 전체를 다시 받는다 — 브리프 생성은 감사로그(`brief_created`)와
      // "AI가 오늘 한 일"까지 같이 움직인다.
      await load();
    } catch (e) {
      // 40~50초짜리 요청이라 네트워크가 끊기면 fetch 자체가 던진다(위 !r.ok와 다른 경로).
      setBriefError(e instanceof Error ? e.message : String(e));
    } finally {
      setBriefRunning(false);
    }
  }, [load]);

  /* ── 브리핑 삭제 ────────────────────────────────────────────────────
     ⚠️ 위 재생성과 **반대 성질이라 생김새도 반대다.** 재생성은 다시 누르면 되는 조작이라
        즉시 실행이지만, 이건 **되돌릴 수 없다**(다시 만들려면 크레딧·40~50초를 쓰고 내용도
        같지 않다) — 그래서 **두 번 누른다**(무장 → 실행). 노트 보류·반려와 같은 급이다.
     ⚠️ 지우는 범위는 화면이 정하지 않는다 — 서버가 그 브리프의 **날짜에 속한 행 전부**를
        지운다(`db.delete_briefs_on`). 같은 날 재실행 회차가 쌓여 있어서, 보이는 한 행만
        지우면 직전 회차가 올라와 아무 일도 안 일어난 것처럼 보인다.
     자주 쓰는 조작이 아니라 머리말 오른쪽 끝의 작은 글자 버튼(`.btn-quiet`)이다 —
     1차 CTA도 아니고 재생성보다도 뒤다. */
  const [briefArmed, setBriefArmed] = useState(false);
  const [briefDeleting, setBriefDeleting] = useState(false);

  const deleteBrief = useCallback(
    async (id: number) => {
      setBriefError('');
      setBriefDeleting(true);
      try {
        const r = await apiDelete(`/api/briefs/${id}`);
        if (!r.ok) {
          setBriefError(errorMessage(r.body, '브리핑을 삭제하지 못했습니다.'));
          return;
        }
        const n = (r.body as { deleted?: number } | null)?.deleted ?? 0;
        toast(`브리핑을 삭제했습니다 (${n}건).`);
        setBriefArmed(false);
        // 생성과 같은 이유로 전체를 다시 받는다 — 감사로그에 `brief_deleted`가 붙는다.
        await load();
      } catch (e) {
        setBriefError(e instanceof Error ? e.message : String(e));
      } finally {
        setBriefDeleting(false);
      }
    },
    [load, toast],
  );

  /* 고정 버튼(FAB)이 인라인 채팅의 `보내기` 오른쪽 끝을 덮는다 — 떠 있는 것은 무엇이든
     덮으므로 자리를 옮겨서 풀 문제가 아니다. **둘이 같은 일(F1)을 하니**, 인라인 채팅이
     화면에 서 있는 동안에는 떠다니는 바로가기를 내리는 쪽으로 푼다.
     ⚠️ 관찰 대상은 카드 전체가 아니라 **채팅 칸**이다(`.cust-chat`) — 고객 카드는 크고
        첫 화면을 거의 채워서, 카드로 잡으면 그 탭에서 FAB이 거의 늘 사라진다.
     ⚠️ 뷰는 `hidden` 토글이라 DOM에 남아 있는데, `display: none`이면 교차가 0이라
        관찰자가 그대로 "안 보임"으로 준다 — 탭을 옮길 때 따로 손볼 것이 없다. */
  const inlineChatRef = useRef<HTMLDivElement | null>(null);
  const [inlineChatSeen, setInlineChatSeen] = useState(false);
  useEffect(() => {
    const el = inlineChatRef.current;
    if (!el) {
      setInlineChatSeen(false);
      return;
    }
    const io = new IntersectionObserver(
      ([e]) => setInlineChatSeen(e.isIntersecting),
      { threshold: 0.15 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [role, view, data]);

  /* Esc로 모달을 닫는다. 여는 자리가 여럿이라(큐 · 고객 표 · 고정 버튼) 닫는 규칙은 여기
     한 곳에 둔다 — 배경 클릭·`×`와 **같은 일**을 해야 하므로 같은 `setModal(null)`을 쓴다.
     ⚠️ 전역 F1도 같이 닫히지만 그쪽은 `hidden` 토글이라 **대화는 남는다**(끊는 건 `새 대화`).
     ⚠️ 무장 상태(반려 사유 셀렉트 등)를 Esc로 되돌리지는 않는다 — 그 상태는 모달 안에 살고
        모달이 닫히면 같이 사라지므로, 여기서 단계를 하나 더 두면 "한 번 더 눌러야 닫히는"
        모달이 된다. */
  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setModal(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal]);

  const cfg = ROLES[role];

  /** 이 역할에게 실제로 있는 탭. 하나뿐이면 탭 줄을 아예 내지 않는다(고를 게 없다). */
  const tabs = useMemo(
    () =>
      (
        [
          // 축은 "읽기 / 하기"다. 상담 준비 = 무엇을 알아야 하나(브리핑·고객),
          // 작성·검토 = 내가 손대야 하는 것(생성·처리 대기).
          // "노트·승인"이었다 — ①승인(발행)은 준법의 일이라 PB 화면에서 못 하는 동작을
          // 이름으로 걸고 있었고 ②큐 절반이 고객 문의라 "노트"가 그 절반을 못 덮었다.
          // 지금 이름은 PB가 실제로 하는 두 동작이고 카드 순서(생성 → 큐)와 같으며
          // 큐 행의 버튼 라벨("검토")과도 이어진다.
          // 준법은 고객을 관리하지 않는다 — 이 탭이 하는 일은 심의 큐 처리뿐이라
          // "심의"로 부른다(예전 "고객 관리"는 없는 고객 카드를 기대하게 만들었다).
          {
            id: 'cust',
            label: cfg.research ? '상담 준비' : '심의',
            on: true,
          },
          { id: 'note', label: '작성·검토', on: cfg.research },
          // 준법감시인의 두 일 = 심의(통과시키기) / 감시(지켜보기). "AI 평가"는 준법이
          // AI 성능을 채점하는 것처럼 읽혀서 바꿨다 — 실제 내용은 산출물의 규정 준수 감시다.
          { id: 'ai', label: '감시', on: cfg.aiTab },
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
  /** 타입 필터(전체/노트/문의)는 큐에 여러 종류가 섞일 때만 의미 있다. 준법 큐는 심의 단계
   *  종목 노트만 담고(고객 문의는 PB 일) 한 종류뿐이라, 필터 줄을 안 내고 남아 있던 filter
   *  상태도 무시한다. cfg.queueFilter가 있으면 = 큐가 단일 종류로 좁혀진 역할(지금은 준법). */
  const showTypeTabs = !cfg.queueFilter;
  /** 지금 선택된 탭에서 실제로 보이는 건. 목록과 건수 표시가 **같은 값**을 써야 한다 —
   *  따로 세면 필터 조건이 바뀔 때 한쪽만 고치고 넘어가기 쉽다. */
  const shownQueue = useMemo(
    () =>
      showTypeTabs
        ? roleQueue.filter((it) => filter === 'all' || it.type === filter)
        : roleQueue,
    [roleQueue, filter, showTypeTabs],
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

  /* 고른 고객에 대해 물으면 **무엇이 외부 모델로 나가는가** — 질문 전에 미리 받아 둔다.
     LLM을 안 부르므로 크레딧 0이고, 값은 채팅이 실제로 쓰는 것과 **같은 백엔드 함수**에서
     온다(`redact.redact_portfolio`). ⚠️ 프론트에서 다시 계산하지 말 것 — 미리 본 것과 실제
     나가는 것이 갈리면 미리보기가 약속 구실을 못 한다.
     실패하면 조용히 감춘다: 이 상자는 부가 설명이라, 못 받았다고 오류를 띄우면 정작
     읽어야 할 고객 정보를 밀어낸다(`.tbl-scroll` 옆 상세와 같은 칸이다). */
  const [egress, setEgress] = useState<ChatRedaction | null>(null);
  const selectedIdForEgress = selected?.id;
  useEffect(() => {
    if (selectedIdForEgress === undefined) return;
    let alive = true;
    api<ChatRedaction>(`/api/customers/${selectedIdForEgress}/egress-preview`)
      .then((r) => alive && setEgress(r))
      .catch(() => alive && setEgress(null));
    return () => {
      alive = false;
    };
  }, [selectedIdForEgress]);

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

  /* 오늘(영업일) 키 — 브리프가 "오늘 것"인지 판별하는 데만 쓴다(lastDays의 마지막 칸).
     예전엔 이 14일 배열로 감시 탭의 추이 차트도 그렸지만, 그 카드는 뺐다(2026-07-27). */
  const days = useMemo(() => lastDays(14), []);

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
          // 요약 줄엔 짧은 라벨만, 긴 위반 상세는 펼쳤을 때만 보인다(카드 무게를 가볍게).
          label: blocked ? '발행 차단' : '허용 외 도구 호출 거부',
          detail: blocked
            ? detailStr(a.detail) || '게이트 미통과'
            : `도구 ${
                (a.detail as { tool_name?: string }).tool_name ?? '알 수 없음'
              } · 허용 목록 외 (permission_check)`,
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
          <div className="brand">AI PB Agent</div>
        </header>
        <section className="card">
          <div className="card-head">
            <h2>백엔드에 연결하지 못했습니다</h2>
          </div>
          <div className="hint" style={{ padding: '8px 0' }}>
            {/* 오류 원문은 제 줄에 둔다. fetch 예외의 e.message라 `Failed to fetch`
                같은 영문이 들어오는데, 한글 안내문에 이어 붙이면 한 문장으로 읽히지
                않는다(예전엔 사이를 —로 이었다). */}
            {error}
            <br />
            <code>docker compose up</code>으로 백엔드(8000)가 떠 있는지
            확인하세요.
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

  /* 지수 기준일. 지수는 같은 거래일 종가로 함께 들어오므로 보통 날짜가 같은데, 그걸
     지수마다 적으면 같은 날짜가 두 번 나와 정작 지수값·등락률을 덮는다. 같을 때만
     줄 끝에 한 번 적으려고 여기서 판정한다.
     **다르면 null이고 그때는 지수마다 적는다** — 한쪽만 갱신이 늦은 날 하나로 합치면
     한 지수에 없는 날짜를 붙이는 셈이라 없는 사실이 된다. */
  const mktAsOf = (() => {
    const ixs = data.brief?.market?.indices ?? [];
    if (!ixs.length) return null;
    return ixs.every((x) => x.as_of === ixs[0].as_of) ? ixs[0].as_of : null;
  })();
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
      : // 준법 심의 탭엔 타일을 두지 않는다. 심의 대기 수는 아래 처리 대기 카드("N건"+목록)에,
        // 게이트 차단은 감시 탭(AI 신뢰도 카드)에 이미 있어 타일은 중복 요약일 뿐이었다.
        [];

  /* "AI가 오늘 한 일" — 큐와 같이 **한 번 정의하고 자리만 옮긴다.**
     궁금할 때 열어보는 것이지 늘 보고 있을 내용이 아니라 접어 둔다. 숫자는 전부 훅이 남긴
     감사로그 실집계다(없으면 없다고 말한다). 펼침은 native <details>다 — 직접 만든 토글은
     키보드·스크린리더 동작을 다시 구현해야 하지만 이건 브라우저가 준다.

     자리는 역할이 정한다: **감시 탭이 있으면 거기, 없으면 첫 탭 맨 위.**
     준법에게 이 줄은 "오늘 손댈 것"이 아니라 지켜본 결과라 심의(처리) 탭이 아니라 감시
     탭에 속한다 — 감시 탭의 다른 카드(AI 신뢰도·알림·감사로그)와 같은 성격이고, 실제로
     같은 감사로그를 원본으로 쓴다. PB에게는 감시 탭이 없으므로 첫 탭에 남는다. */
  const aiworkCard = (
    <details className="aiwork">
      <summary>AI가 오늘 한 일</summary>
      <div className="aiwork-body">
        {aiwork.length ? (
          <span>{aiwork.join(' · ')}</span>
        ) : (
          <span className="muted">
            오늘은 실행 기록이 없습니다. 브리핑을 생성하면 여기에 표시됩니다.
          </span>
        )}
        {data.summary.today.last_run && (
          /* 날짜까지 적는다. "오늘"이 KST 기준이라 새벽·아침에는 시각만 봐서는 이 줄이
             언제 것인지 헷갈렸다 — 컨테이너·Postgres가 UTC라 하루 경계로 실제 사고가
             났던 자리다(HANDOFF §2 bizdate). 감사로그와 같은 함수로 찍는다. */
          <span className="aiwork-time">
            마지막 실행 {fmtDateTime(data.summary.today.last_run)}
          </span>
        )}
      </div>
    </details>
  );

  /* 처리 대기 카드 — 두 화면이 나눠 갖는다.
     PB에게는 「작성·검토」 탭(만드는 것과 처리하는 것을 같이 두는 곳)에,
     준법에게는 그 탭이 없으므로 원래 자리에 남긴다 — 준법이 큐를 잃으면
     심의할 노트를 화면에서 찾을 방법이 아예 없어진다. */
  const queueCard = (
    <section className="card" aria-labelledby="q-title">
      <div className="card-head">
        <h2 id="q-title">처리 대기</h2>
        {/* 건수는 두 화면 모두 **제목 옆**에 둔다 — 필터 줄 오른쪽 끝에 있으면 세는 대상
            (제목)에서 멀어져 표 헤더처럼 읽혔다. 필터를 바꾸면 이 수도 같이 바뀐다.
            aria-live: 목록이 갈리는 변화가 스크린리더에는 안 들리므로 수를 읽어 준다. */}
        <span className="hint" aria-live="polite">
          {shownQueue.length}건
        </span>
      </div>
      {showTypeTabs && (
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
          {/* 건수는 탭마다 붙이지 않고 **선택된 탭의 것 하나만** 낸다(위 헤더) — 세 개를
              늘어놓으면 지금 보고 있는 게 어느 수인지가 오히려 흐려진다. */}
        </div>
      )}
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
        <div className="brand">AI PB Agent</div>
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
          <ThemeToggle />
        </div>
      </header>

      {/* 탭 줄은 **고를 게 둘 이상일 때만** 낸다 — 선택지가 하나뿐인 탭은 고르는 장치가
          아니라 제목일 뿐이다. PB는 상담 준비 + 작성·검토, 준법은 심의 + 감시. */}
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
        {/* 감시 탭이 있는 역할(준법)에게는 여기가 아니라 그쪽에 붙는다 — 정의는 위 한 곳. */}
        {!cfg.aiTab && aiworkCard}

        {/* 오늘 규모(내 담당 고객·내 처리 대기) → 바로 만들 수 있는 것(종목 노트) 순서다.
            "AI가 오늘 한 일" 바로 아래에 오늘의 수치와 조작이 붙고, 그 아래로 읽을거리
            (브리핑·처리 대기·고객)가 이어진다. */}
        {/* 타일은 어느 화면에서나 균등 2열이다. 한때 준법 화면에서만 감시 탭의
            사이드바 격자(2fr 1fr)에 맞췄는데, 두 타일의 무게가 같은데 폭이 다르면
            왼쪽이 더 중요한 것처럼 읽힌다 — 탭 사이 이음매보다 이쪽이 우선이다. */}
        {/* 타일이 없으면(준법: 아래 처리 대기 카드가 같은 정보를 담는다) 빈 그리드를 안 낸다. */}
        {tiles.length > 0 && (
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
                  {/* 설명줄이 없는 타일은 빈 칸을 남기지 않는다(빈 div도 자리를 차지한다).
                      준법 타일엔 breakdown이 없으므로 in 가드로 좁힌다. */}
                  {'breakdown' in t && t.breakdown && (
                    <div className="breakdown">{t.breakdown}</div>
                  )}
                </Tag>
              );
            })}
          </div>
        )}

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
            {/* 재실행은 머리말 오른쪽. 브리프가 없을 때의 1차 CTA는 여기가 아니라
                **빈 상태 본문**에 있다 — 아무것도 없는 카드에서 눈이 가는 곳은
                머리말이 아니라 비어 있는 본문이다. */}
            {data.brief && (
              <span className="head-acts">
                {/* 한 번 누르면 실행이다. 확인 단계(무장 → `취소`)를 뒀다가 걷어냈다 —
                    브리프 재생성은 되돌릴 수 없는 조작이 아니라 **다시 누르면 되는 조작**이고
                    (노트 보류·반려와 그 점이 다르다), 하루에 몇 번 쓰는 버튼에 두 번 누르기를
                    걸면 비용이 이득을 넘는다. 잃는 건 하나뿐이다: 화면에 떠 있던 브리프가
                    새 것으로 바뀐다(옛 브리프 행은 DB에 남는다 — `latest`가 새 것을 볼 뿐).
                    ⚠️ 옐로(.primary)를 쓰지 않는다 — 브리핑은 첫 화면에서 가장 큰 카드라
                       그 머리말의 강조색이 페이지 전체의 시선을 가져간다. 1차 CTA는 이
                       카드가 **비어 있을 때**의 `브리핑` 하나뿐이다(HANDOFF §0-1).
                    진행 표시는 곁말이 아니라 **라벨**이 맡는다. */}
                <button
                  className="btn"
                  disabled={briefRunning}
                  onClick={() => void runBrief()}
                >
                  {briefRunning ? '생성 중…' : '↻ 다시 생성'}
                </button>
                {/* 삭제 — 자주 쓰는 조작이 아니라 옆 버튼보다 작고 조용하다(면도 테두리도
                    없는 글자). 그래도 **되돌릴 수 없어서 두 번 눌러야 실행된다**: 첫 누름은
                    무장뿐이고, 무장은 라벨이 아니라 **색(적색)과 옆에 선 `취소`**가 말한다.
                    ⚠️ 무장 상태의 색은 `--critical`이다 — 게이트 차단과 같은 색이지만 여기서는
                       형태가 다르다(막대가 아니라 글자). 새 색을 만들지 않는다(HANDOFF §0-1). */}
                {briefArmed ? (
                  <>
                    <button
                      className="btn-quiet danger"
                      disabled={briefDeleting}
                      onClick={() => {
                        if (data.brief) void deleteBrief(data.brief.id);
                      }}
                    >
                      {briefDeleting ? '삭제 중…' : '삭제'}
                    </button>
                    <button
                      className="btn-quiet"
                      disabled={briefDeleting}
                      onClick={() => setBriefArmed(false)}
                    >
                      취소
                    </button>
                  </>
                ) : (
                  <button
                    className="btn-quiet"
                    disabled={briefRunning}
                    onClick={() => setBriefArmed(true)}
                    title={`${data.brief.brief_date} 브리핑을 지웁니다. 같은 날 다시 생성한 회차까지 함께 지워지고, 되돌릴 수 없습니다.`}
                  >
                    삭제
                  </button>
                )}
              </span>
            )}
          </div>
          {briefError && (
            <div className="hint" style={{ color: 'var(--critical)' }}>
              ⛔ {briefError}
            </div>
          )}
          {data.brief ? (
            <>
              {/* 오늘 시장 — PB가 고객에게 가장 먼저 듣는 질문이 개별 종목이 아니라 시장이다.
                  못 가져왔으면 빈칸으로 두지 않고 미연결 사유를 그대로 말한다. */}
              {data.brief.market?.indices?.length ? (
                <div className="mkt">
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
                        {/* 지수마다 붙는 날짜는 서로 다를 때만 쓴다(mktAsOf 참조) */}
                        {!mktAsOf && (
                          <span className="bcode">
                            · {fmtDate(ix.as_of)} 지연
                          </span>
                        )}
                      </span>
                    );
                  })}
                  {/* 날짜가 같으면 줄 끝에 한 번만. 숫자를 읽는 데 방해가 되지 않게
                      오른쪽 끝으로 밀고 톤을 낮추되, 지우지는 않는다 — 이 값이 오늘
                      것이 아니라는 사실은 화면에 남아 있어야 한다. */}
                  {mktAsOf && (
                    <span
                      className="mkt-asof"
                      title="지수는 일별 종가 기준이라 직전 거래일 값이다(실시간 아님). 주말·휴장일과 당일 장중에는 오늘 날짜가 없다."
                    >
                      {fmtDate(mktAsOf)} 종가
                    </span>
                  )}
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
                  {/* 구분자는 콜론이다(api.ts::errorMessage의 게이트 차단 문구와 같은 형태).
                      여기 —는 접속사가 아니라 라벨과 목록을 가르는 자리였다. */}
                  ⛔ 컴플라이언스 게이트 미통과:{' '}
                  {data.brief.violations.join(' / ')}
                </div>
              )}
            </>
          ) : (
            /* 빈 상태 = 오류가 아니라 "아직 없다"다(백엔드도 404로 그렇게 말한다).
               그래서 경고색이 아니라 **할 수 있는 일 하나**를 놓는다.
               ⚠️ 진행 표시는 **버튼 라벨이 맡는다**(`브리핑` → `생성 중…`). 옆에 곁말로
                  두면 버튼과 문구가 두 덩어리로 서고, 비활성 버튼이 "왜 안 눌리지"로 먼저
                  읽힌다 — 라벨이 바뀌면 그 자리에서 답이 된다.
                  누르기 전 예상 소요는 안 적는다(망설이게만 한다). 다만 **라벨 전환 자체는
                  지우지 말 것**: 이 라우트는 SSE가 아니라 블로킹 POST라 40~50초 동안 화면이
                  조용해서, 없으면 멈춘 것으로 읽힌다. */
            <div className="brief-empty">
              <p className="hint" style={{ margin: 0 }}>
                아직 오늘 브리핑이 없습니다. 담당 고객 보유 상위 종목의
                공시·뉴스와 지수를 모아 생성합니다.
              </p>
              <div className="brief-empty-run">
                <button
                  className="btn primary"
                  onClick={() => void runBrief()}
                  disabled={briefRunning}
                >
                  {briefRunning ? '생성 중…' : '브리핑'}
                </button>
              </div>
            </div>
          )}
        </section>

        {/* 처리 대기는 작성·검토 탭으로 옮겼다(PB). 준법은 그 탭이 없어 여기 남는다. */}
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
                <div className="cust-list">
                  <input
                    className="search"
                    type="search"
                    placeholder="검색"
                    aria-label="검색"
                    /* 셋 중 여기가 제일 중요하다 — PB가 치는 값이 고객 이름이라,
                       자동완성을 켜 두면 브라우저 입력 이력에 고객명이 쌓인다. */
                    autoComplete="off"
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
                          {/* 이 표는 고객을 **찾는** 곳이다. 계좌·나이·위험성향·잔고는
                              오른쪽 상세에 전부 있으므로 여기서 뺐다 — 같은 값을 두 번
                              보여주느라 폭을 쓰면 채팅 자리가 없다. 남긴 건 이름(식별)과
                              수익률·플래그(훑을 때의 분류 신호)뿐이다. */}
                          <th>고객</th>
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
                              <strong>{c.name}</strong>
                            </td>
                            <td
                              className={`num delta ${c.ret >= 0 ? 'up' : 'down'}`}
                            >
                              {c.ret >= 0 ? '+' : ''}
                              {c.ret.toFixed(1)}%
                            </td>
                            <td>
                              {/* `.icon`은 **폭 고정 변종**이다 — 값이 있는 행과 없는 행의
                                  칸 너비를 맞춘다. 모양 자체는 이름 옆 ⚑와 같다. */}
                              {c.flag && (
                                <span
                                  className="flag icon"
                                  title={c.flagReasons
                                    .map((r) => r.text)
                                    .join(' · ')}
                                  aria-label={`위험 플래그: ${c.flagReasons
                                    .map((r) => r.text)
                                    .join(' · ')}`}
                                >
                                  ⚑
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
                        {/* 표 칸과 **같은 글리프**다(2026-07-29). 예전엔 여기만 `⚑ 위험 플래그`
                            테두리 알약이었는데 라벨을 걷어냈다 — 바로 아래 사유 줄이 이미
                            무엇 때문인지 말하고 있어서 라벨이 세 번째 되풀이였다.
                            ⚠️ 라벨이 없으니 `aria-label`이 유일한 설명이다 — 빼지 마라. */}
                        {selected.flag && (
                          <span
                            className="flag"
                            title={selected.flagReasons
                              .map((r) => r.text)
                              .join(' · ')}
                            aria-label={`위험 플래그: ${selected.flagReasons
                              .map((r) => r.text)
                              .join(' · ')}`}
                          >
                            ⚑
                          </span>
                        )}
                      </div>
                      <div className="acct">
                        {selected.acct} · {selected.age}세 ·{' '}
                        {RISK[selected.risk]}
                      </div>
                      {/* 플래그가 없으면 **줄을 안 낸다**(2026-07-29). 한동안 `위험 플래그
                          없음`을 적었는데("규칙에 안 걸렸다"와 "규칙을 안 돌렸다"를 가르려고),
                          같은 패널의 **이름 옆 `⚑ 위험 플래그` 배지가 없다는 것**이 이미 같은
                          말을 하고 있었다. 규칙이 돈다는 사실은 표의 ⚑ 열과 상단 `위험 플래그
                          N건` 타일이 말한다.
                          사유 줄에는 ⚑를 달지 않는다 — 바로 위 이름 옆 배지가 이미 마커이고,
                          3px 아래에서 같은 기호를 되풀이하면 자기 라벨을 두 번 다는 셈이다. */}
                      {selected.flag && (
                        <div className="flag-reasons">
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
                          {/* 순서·색은 도넛과 같은 출처에서 온다(charts.tsx) — 여기에
                              색 배열을 다시 적으면 둘이 조용히 어긋난다. */}
                          {allocEntries(selected.alloc).map(([k, v], i) => (
                            <div className="li" key={k}>
                              <span
                                className="sw"
                                style={{
                                  background:
                                    ALLOC_COLORS[i % ALLOC_COLORS.length],
                                }}
                              />
                              {k}
                              <span className="pct">{v}%</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <table className="holdings" aria-label="보유 종목">
                        {/* 머리글이 필요한 이유는 **비중 열 하나** 때문이다 — 맨 `50.9%`는
                            "무엇의 50.9%"가 안 정해진다(잔고 대비인지 주식 내인지). 예전엔
                            카드 맨 아래 요약 줄이 `(주식 내)`라고 괄호로 붙여 주고 있었다. */}
                        <thead>
                          <tr>
                            <th>종목</th>
                            <th className="num">평가금액</th>
                            <th className="num">주식 내</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selected.holdings.map((h) => (
                            <tr key={h.code}>
                              <td>
                                {/* 종목명이 이 표의 주어다 — 고객 표의 이름과 같은 무게로.
                                    종목코드는 부가정보라 그대로 둔다. */}
                                <strong>{h.name}</strong>{' '}
                                <span style={{ color: 'var(--muted)' }}>
                                  {h.code}
                                </span>
                              </td>
                              <td className="num">₩{fmtKRW(h.amt)}</td>
                              {/* 비중이 없으면 빈칸이 아니라 `—`. 빈칸은 "0%"로도
                                  "아직 안 셌다"로도 읽힌다. */}
                              <td className="num pct-eq">
                                {h.pct_of_equity == null
                                  ? '—'
                                  : `${h.pct_of_equity}%`}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <PrepMemo
                        customer={selected}
                        brief={data.brief}
                        notes={data.notes}
                        onOpenNote={(code) => setModal({ kind: 'note', code })}
                      />
                      {/* 여기 있던 `요약` 줄(f1.portfolio_summary)을 걷어냈다(2026-07-29).
                          세 조각 중 둘이 이 패널에 이미 있었다: `국내주식 74%`는 도넛 범례와
                          **글자까지 같았고**, `위험 플래그 …`는 이름 옆 ⚑와 사유 줄이 이미
                          말하고 있었다. 남는 하나(최대 단일 종목의 주식 내 비중)는 요약이
                          따로 말할 게 아니라 **보유 표에 없던 열**이었다 — 그래서 표로 옮겼고,
                          한 종목이 아니라 전 종목의 비중이 보이게 됐다.
                          ⚠️ 되돌리지 말 것. 되돌리려면 먼저 "표의 비중 열로 안 되는 이유"가
                             있어야 한다. `portfolio_summary`와 그 테스트는 백엔드에 남아 있다. */}
                    </>
                  )}
                </div>

                {/* ── 3열: 이 포트폴리오에 묻기 ───────────────────────────────
                    답할 수 있는 건 둘이다: **보유 종목**(공시·뉴스·지연시세, 에이전트가
                    조회) + **포트폴리오 구성**(집중도·배분·성향 대비, 코드가 계산).
                    2026-07-28에 후자를 열면서 근거에 **내부 계좌데이터**가 들어왔다 —
                    가드레일 1의 명시적 예외이고, 조건은 CLAUDE.md에 적혀 있다(수치는
                    코드가 계산 · 이름/계좌는 프롬프트에도 답변에도 없음 · 조정 지시 금지).

                    ⚠️ **여전히 "고객에 대해 묻는 챗봇"이 아니다.** 주어를 종목에서
                    포트폴리오까지만 넓혔지 **사람으로 옮기지 않았다** — 제목이 "이 고객에게
                    묻기"로 읽히는 순간 답할 수 없는 질문(고객 자체)과 해서는 안 되는 질문
                    (회신문 대필, 가드레일 4)을 부른다.
                    ⚠️ 입력 가드(compliance.PII_PATTERNS)는 주민·계좌번호 '숫자 형식'만
                    잡는다 — 한글 이름은 안 걸린다. 이름을 안 쓰게 만드는 건 지금도
                    이 UI의 몫이다(HANDOFF §7). */}
                <div className="cust-chat" ref={inlineChatRef}>
                  {selected ? (
                    <>
                      {/* 제목의 주어는 **사물(포트폴리오)**이지 사람(고객)이 아니다 —
                          위 ⚠️ 참조. 근거 줄에 '보유·배분'을 맨 앞에 둔 건 그것만
                          공개데이터가 아니어서다(문장별로는 각 출처 배지가 말한다). */}
                      <div className="cchat-head">
                        <strong>포트폴리오 질문</strong>
                        <span className="cchat-src">
                          보유·배분 · 공시 · 뉴스 · 지연시세
                        </span>
                      </div>
                      {/* 종목 칩과 분석 칩은 **줄을 나눈다**(2026-07-29). 한 상자에 담으면
                          종목이 많은 고객에서 `집중도`가 종목 사이에 끼어 줄바꿈되고, 두
                          종류가 섞여 보인다. 보유가 없으면 이 줄 자체를 안 낸다(빈 여백). */}
                      {selected.holdings.length > 0 && (
                        <div className="cchat-chips">
                          {selected.holdings.map((h) => (
                            <button
                              key={h.code}
                              className="chip"
                              onClick={() => askHolding(`${h.name} 최근 실적`)}
                              title={`${h.name}(${h.code}) 질문 채우기`}
                            >
                              {h.name}
                            </button>
                          ))}
                        </div>
                      )}
                      {/* 분석 칩 — 종목 칩과 **다른 종류**라 형태로 가른다(.chip.ana).
                          보유 종목이 없어도 낸다: 자산배분·성향 대비는 주식이 하나도
                          없어도 답이 되는 질문이고(현금성 100%도 구성이다), 오히려
                          그때 물어볼 게 이것뿐이다. */}
                      <div className="cchat-chips">
                        {PORTFOLIO_CHIPS.map((c) => (
                          <button
                            key={c.label}
                            className="chip ana"
                            onClick={() => askHolding(c.q)}
                            title={`${c.q} 질문 채우기`}
                          >
                            {c.label}
                          </button>
                        ))}
                      </div>
                      {/* 고객이 바뀌면 대화를 새로 시작한다(key). 세션을 이어가면 다음
                          질문이 **앞 고객의 종목을 이어받아**(멀티턴 last_entity) 이
                          고객이 갖고 있지도 않은 종목을 답해 버린다.
                          같은 이유로 customerId도 여기서만 넘어간다 — 전역 F1(FAB)에는
                          고객이 없어 포트폴리오 라우트가 아예 안 켜진다. */}
                      <F1Chat
                        key={selected.id}
                        compact
                        prefill={prefill}
                        customerId={selected.id}
                        customerNames={customerNames}
                        /* 미리보기는 **이 카드에만** 둔다. 여기가 고객을 살펴보는
                           화면이라 "물어보면 뭐가 나가지?"가 질문보다 먼저 오고,
                           고객 문의 모달은 이미 길다(거기서는 물어본 뒤 배지로 본다). */
                        preview={egress}
                      />
                    </>
                  ) : (
                    <div className="hint">
                      고객을 선택하면 질문할 수 있습니다.
                    </div>
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

      {/* ══════════ 탭 3 · 감시 (준법 전용) ══════════ */}
      {/* 감시 탭은 카드 셋을 전폭으로 세로로 쌓는다(요약 지표 → 막힌 사건 → 원장).
          2열로 두면 짧은 AI 신뢰도가 긴 알림 목록 높이만큼 늘어나 빈칸이 생겼다.
          세 카드의 타고난 폭(넓음/넓음/넓음)이 달라 억지로 나란히 둘 이유가 없다. */}
      <div className="view stack" hidden={view !== 'ai'}>
        {/* 오늘치 요약을 맨 위에 둔다 — 아래 세 카드가 누적 지표·사건·원장이라, 그 앞에
            "오늘은 이만큼 돌았다"가 있어야 숫자를 읽을 기준이 생긴다. */}
        {aiworkCard}
        <section className="card" aria-labelledby="tr-title">
          <div className="card-head">
            <h2 id="tr-title">AI 신뢰도</h2>
          </div>
          <div className="trust">
            <div>
              <div className="t-label">
                출처 부착률{' '}
                <span style={{ color: 'var(--muted)' }}>· 사실 주장 문장</span>
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
            </div>
            <div>
              <div className="t-label">
                게이트 차단 <span style={{ color: 'var(--muted)' }}>· 7일</span>
              </div>
              <div className="t-sub">
                <span className="t-value">{data.summary.gate_blocks_7d}</span>
                <span style={{ marginLeft: 'auto' }}>
                  <GateMini data={data.summary.gate_blocks_daily} />
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="card" aria-labelledby="f-title">
          <div className="card-head">
            <h2 id="f-title">컴플라이언스 알림</h2>
          </div>
          <div className="feed">
            {feed.map((f, i) => (
              <details className="fitem" key={i}>
                <summary>
                  <span className={`ficon ${f.sev}`}>{f.icon}</span>
                  <span className={`flabel ${f.sev}`}>{f.label}</span>
                  <span className="fref">{f.ref}</span>
                  <span className="ftime">{f.time}</span>
                </summary>
                <div className="fdetail">{f.detail}</div>
              </details>
            ))}
            {!feed.length && (
              <div className="hint" style={{ padding: '10px 4px' }}>
                차단·거부 기록이 없습니다.
              </div>
            )}
          </div>
        </section>

        {/* 감사로그는 좁은 사이드바에 두면 event_type·detail이 잘린다 —
            전폭으로 내려 한 줄에 담기게 한다. */}
        <section className="card" aria-labelledby="a-title">
          <div className="card-head">
            <h2 id="a-title">
              감사로그{' '}
              <span className="hint">
                {auditNote === null
                  ? `최근 ${data.audit.length}건`
                  : `노트 #${auditNote} 전건 ${noteAudit.length}건`}
              </span>
            </h2>
            {/* 노트별 조회 — 전체 목록은 최근 200건 창이라 옛 노트의 확인·심의 이력을
                여기서 찾을 수 없었다(노트 13건 중 9건이 창 밖). 검토 모달에 있던
                감사로그를 이리로 모으면서 같이 넣었다. */}
            <label className="alog-pick">
              <span className="hint">노트별</span>
              <select
                value={auditNote ?? ''}
                onChange={(e) => {
                  setAuditNote(e.target.value ? Number(e.target.value) : null);
                  setAuditPage(0);
                }}
                aria-label="감사로그를 노트 한 건으로 좁히기"
              >
                <option value="">전체 (최근 200건)</option>
                {data.noteList.map((n) => (
                  <option key={n.id} value={n.id}>
                    #{n.id} {n.corp_name}({n.stock_code}) ·{' '}
                    {PILL[n.status]?.[0] ?? n.status}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {(() => {
            // 전체는 최근 200건 창, 노트별은 전건. 20건씩 넘겨 본다(클라이언트 페이징).
            // page는 데이터가 줄어도 범위를 벗어나지 않게 클램프한다.
            const rows = auditNote === null ? data.audit : noteAudit;
            const pages = Math.max(1, Math.ceil(rows.length / AUDIT_PAGE));
            const page = Math.min(auditPage, pages - 1);
            const shown = rows.slice(
              page * AUDIT_PAGE,
              (page + 1) * AUDIT_PAGE,
            );
            return (
              <>
                <div className="audit">
                  {shown.map((a) => {
                    const cat = auditCat(a);
                    // 요약 줄은 점·날짜시각·이벤트명만. 노트·actor·detail은 펼쳤을 때.
                    const body = [
                      a.note_id && `노트 #${a.note_id}`,
                      a.actor && `actor: ${actorLabel(a.actor)}`,
                      detailStr(a.detail),
                    ]
                      .filter(Boolean)
                      .join(' · ');
                    return (
                      <details className="aitem" key={a.id}>
                        <summary>
                          <span className={`adot ${cat}`} aria-hidden="true" />
                          <span className="ats">{whenLabel(a.ts)}</span>
                          <span className={`aev ${cat}`}>{a.event_type}</span>
                        </summary>
                        <div className="adet-full">
                          {body || '추가 상세 없음'}
                        </div>
                      </details>
                    );
                  })}
                </div>
                {pages > 1 && (
                  <div className="apage">
                    <button
                      className="btn"
                      disabled={page === 0}
                      onClick={() => setAuditPage(page - 1)}
                    >
                      ← 이전
                    </button>
                    <span className="apage-info">
                      {page * AUDIT_PAGE + 1}–
                      {Math.min((page + 1) * AUDIT_PAGE, rows.length)} /{' '}
                      {rows.length}건
                    </span>
                    <button
                      className="btn"
                      disabled={page >= pages - 1}
                      onClick={() => setAuditPage(page + 1)}
                    >
                      다음 →
                    </button>
                  </div>
                )}
              </>
            );
          })()}
        </section>
      </div>

      {/* ── 전체 고지 = 페이지를 닫는 밝은 띠 ─────────────────
          화면 전체에 걸리는 고지다. 개별 산출물은 각자 자기 고지를 달고 다닌다 —
          종목 노트=워터마크(ReviewModal) · F1 답변=지연시세 고지(F1Chat).
          바이낸스의 footer-light(어두운 본문을 밝은 면으로 닫는다)를 여기에 쓴 건
          장식이 아니라 **대비** 때문이다: 이 문장은 반드시 읽혀야 하는데, 밝은 면 위
          검은 글자가 다크 캔버스에서 낼 수 있는 어떤 회색보다 세다.
          ⚠ 상담 전 브리핑 카드는 예외다: **자기 고지를 달지 않는다**(2026-07-30 결정).
          백엔드가 만든 "ℹ 내부 참고용" 고지는 briefs.content_md에 그대로 남아 게이트가
          검사하고, 화면에서는 이 줄이 같은 말을 한다(내부 참고용 · 투자권유·광고 아님).
          이 줄이 페이지 맨 아래라 브리핑과 한 화면에 잡히지는 않는다는 것을 알고 내린
          결정이다. ⚠️ 화면 타입(Brief)에 content_md 필드가 없는 건 누락이 아니라 그
          결과다 — "브리핑에 고지가 없다"고 다시 열지 말 것(HANDOFF 열린 항목에서도 지웠다). */}
      <footer className="page-footer">
        <p className="disclaimer" role="note">
          <span className="dot" aria-hidden="true">
            ⚠
          </span>{' '}
          본 화면의 AI 산출물은 공개 공시·뉴스·지연시세에 근거한 내부 참고용
          미검증 초안이며, 투자권유·광고가 아닙니다. 대고객 문안 작성과 발행은
          사람의 검토·심의·승인을 거칩니다.
        </p>
      </footer>

      {/* ── 종목 즉답(F1) 입구 ────────────────────────────────
          화면에서 이것만 성격이 다르다 — 나머지는 상담 **전** 준비인데 F1은 상담 **중**
          쓴다. 그래서 스크롤 위치와 무관하게 고정이고(고객 표를 보다가도 바로 누른다),
          본문 흐름에는 끼지 않으며, 모달로 열려 보고 있던 화면을 잃지 않는다.
          준법 화면에는 띄우지 않는다 — 에이전트를 돌려 산출물을 만드는 쪽은 PB고,
          준법은 그걸 통과시키는 쪽이다(cfg.research와 같은 경계). */}
      {/* 인라인 채팅이 화면에 서 있으면 내린다 — 위 `inlineChatSeen` 주석 참조.
          ⚠️ 답변이 도는 중이라도 내린다(`●`이 그때 안 보인다). 그 자리에는 같은 일을 하는
             채팅이 이미 서 있고, 스크롤을 조금만 움직이면 표시등째로 다시 뜬다. */}
      {cfg.research && !modal && !inlineChatSeen && (
        <button
          className="fab"
          /* 라벨이 제거되면서 접근 가능한 이름이 aria-hidden 이모지 하나만 남아 있었다
             (HANDOFF §7). 버튼 모양을 손보는 김에 이름을 돌려준다. */
          aria-label={
            f1Running ? '종목 즉답 열기 (답변 생성 중)' : '종목 즉답 열기'
          }
          title="종목 즉답 (F1)"
          onClick={() => setModal({ kind: 'f1' })}
        >
          <span aria-hidden="true">💬</span>
          {/* 닫아 둔 동안에도 답변이 계속 온다 — 그 사실을 알리는 유일한 신호다.
              (이름은 aria-label이 말한다. 글리프는 스크린리더에서 뺀다.) */}
          {f1Running && (
            <span className="fab-run" aria-hidden="true">
              ●
            </span>
          )}
        </button>
      )}

      {/* ── 모달 ─────────────────────────────────────────────── */}
      {/* F1은 여기서 빠진다 — 아래에 **따로 늘 마운트된 오버레이**가 있다. */}
      {modal && modal.kind !== 'f1' && (
        <div
          className="overlay"
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
                    /* 문의가 가리키는 종목의 공시·뉴스·노트를 모달 안에서 바로 읽는다 —
                       고객 카드와 **같은 재료**(브리프·노트 색인)이고 에이전트를 새로
                       돌리지 않는다(크레딧 0). */
                    brief={data.brief}
                    notes={data.notes}
                    customerNames={customerNames}
                    onOpenNote={(code) => setModal({ kind: 'note', code })}
                    onClose={() => setModal(null)}
                    onChanged={() => void load()}
                    chatKeep={chatKeep}
                    /* 준법에게는 고객 포트폴리오 카드가 없다(정보장벽) — 그때는 넘기지
                       않아서 버튼 자체가 안 그려진다. */
                    onOpenPortfolio={
                      cfg.portfolio
                        ? () => {
                            setSelectedId(c.id);
                            setView('cust');
                            setModal(null);
                            // 뷰는 `hidden` 토글이라 DOM이 이미 있다 — 다음 프레임이면
                            // 속성이 벗겨진 뒤라 스크롤 위치가 제대로 잡힌다.
                            requestAnimationFrame(() =>
                              document
                                .getElementById('c-title')
                                ?.scrollIntoView({ behavior: 'smooth' }),
                            );
                          }
                        : undefined
                    }
                  />
                );
              })()}
          </div>
        </div>
      )}

      {/* ── 전역 F1 모달 — **언마운트하지 않는다** ──────────────
          닫기는 `hidden` 토글이다(F3 생성 뷰와 같은 처방, HANDOFF §0-1). 잃는 것이 둘이라서다:
          ① 말풍선이 F1Chat의 state라 언마운트되면 대화가 사라진다 — PB는 상담 중에 화면을
             오가며 묻는데, 닫았다 열면 방금 확인한 사실이 없어졌다.
          ② cleanup이 EventSource를 닫는다 — 답변이 오는 중에 닫으면 **크레딧만 쓰고 버린다.**
          그래서 닫아 둔 동안에도 스트림은 계속 돌고, 그 사실은 고정 버튼의 `●`이 말한다.
          ⚠️ 대화를 끊는 것은 이제 닫기가 아니라 머리말의 `새 대화`다(세션 id까지 버린다).
          ⚠️ `cfg.research`가 꺼지면(준법 화면) 언마운트되고 대화도 사라진다 — 의도한 것이다.
             그 화면에는 F1 입구가 없어 감춘 채 들고 있을 이유가 없다(정보장벽과 같은 경계). */}
      {cfg.research && (
        <div
          className="overlay"
          hidden={modal?.kind !== 'f1'}
          onClick={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="종목 질문"
          >
            {/* 전역 F1에는 고객이 없어 미리보기가 없다(변환할 것도 없다). 이름 경고는
                오히려 여기가 더 필요하다 — 고객을 안 고른 채 자유롭게 치는 칸이다. */}
            <F1Chat
              customerNames={customerNames}
              onClose={() => setModal(null)}
              active={modal?.kind === 'f1'}
              onRunningChange={setF1Running}
            />
          </div>
        </div>
      )}

      {toastMsg && <div id="toast">{toastMsg}</div>}
      <Tip tip={tip} />
    </div>
  );
}
