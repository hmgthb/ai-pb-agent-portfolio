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
  fmtLevel,
  fmtMove,
  hhmm,
  isDown,
  notePdfUrl,
  prepNoteFileUrl,
  prepNotePdfUrl,
} from './api';
import {
  ALLOC_COLORS,
  allocEntries,
  Donut,
  GateMini,
  Tip,
  useTip,
} from './charts';
import F1Chat, { prepKey, type ChatKeep, type ChatPrefill } from './F1Chat';
// 고객 카드는 준비 줄만 보유 표 안에서 쓴다 — `PrepMemo`(이름 줄까지 그리는 쪽)는
// 이제 고객 문의 모달 전용이다(ReviewModal).
import ResearchCard from './ResearchCard';
import { ChatModal, NoteModal } from './ReviewModal';
import {
  ACTOR,
  actorLabel,
  MY_PB,
  PILL,
  type PrepItem,
  NBA_CHIPS,
  RISK,
  type AgentCalls,
  type Brief,
  type BriefBullet,
  type ChatRedaction,
  type Customer,
  type DashboardAudit,
  type NoteDetail,
  type NoteIndex,
  type PrepNoteIndex,
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
    // 큐는 **종목 노트만** 담는다. 고객 문의(pb_sessions)는 데이터도 API도 그대로
    // 살아 있고 여기서 목록에 안 낼 뿐이다 — 다시 내려면 이 줄을 null로 되돌리고
    // 큐 카드에 종류 필터 줄을 같이 되살린다(그 줄은 지금 없다).
    queueFilter: (it) => it.type === 'note',
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
   처음 열면 **다크**다(2026-08-04, layout.tsx가 <html data-theme="dark">를 서버에서 박는다).
   ⚠️ CSS 쪽 기본도 다크다 — dashboard.css의 :root가 다크 토큰이고 라이트는
      [data-theme='light'] 블록이다. 속성은 두 값 모두에서 **항상 붙어 있다**(라이트를 고른
      사용자를 부트스트랩이 되돌릴 자리).
   OS 설정(prefers-color-scheme)은 따라가지 않는다 — 폰이든 노트북이든 처음 화면이 같아야
   하고, 그 뒤로는 고른 값만 반영한다.

   테마의 **정본은 React 상태가 아니라 DOM 속성**이다: 첫 페인트 전에 layout.tsx의
   부트스트랩 스크립트가 이미 값을 써 놓기 때문이다(그래야 라이트 사용자가 검은 화면을
   안 본다). 그래서 useState로 따로 들고 있으면 두 개의 진실이 생겨 버튼 라벨과 실제
   화면이 어긋난다 — 외부 저장소를 구독하는 useSyncExternalStore가 이 경우의 도구다.
   (useEffect + setState로 맞추는 방식은 React 컴파일러 규칙에도 걸린다:
    react-hooks/set-state-in-effect.) */
type Theme = 'dark' | 'light';
const themeListeners = new Set<() => void>();

/** 라이트는 **명시적으로 골랐을 때만**이다 — 속성이 없거나 알 수 없는 값이면 다크로 읽는다
 *  (기본값이 다크라 "값을 모르겠으면 기본값"이 곧 다크다). */
const readTheme = (): Theme =>
  document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
/** 서버 렌더·하이드레이션 시점의 값. layout.tsx가 <html>에 박는 값과 같아야 화면이 안 튄다. */
const serverTheme = (): Theme => 'dark';

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
  /** 상담 준비에 내보내는 종목별 **발행분 1건**(아래 `pickNotes`). 검토·심의 중인 노트는
   *  안 담는다 — 그 자리에서 여는 것이 최종본 PDF이고, PDF는 발행분에만 있다. */
  notes: Record<string, NoteDetail>;
  /** id → 상세. **모달은 종목이 아니라 노트를 연다** — 종목으로 열면 큐에서 고른 건과
   *  화면이 그린 건이 갈린다(큐 행은 심의중 #32인데 발행분 #23이 열리는 식). */
  notesById: Record<number, NoteDetail>;
  /** 노트 전건 색인(id 내림차순). notes는 종목별 1건만 담아서 감사로그 필터를
   *  못 만든다 — 같은 종목의 옛 노트(예: 기아 #8)가 키에서 밀려나기 때문이다. */
  noteList: NoteIndex[];
  summary: Summary;
  audit: DashboardAudit[];
  agents: AgentCalls[];
  /** 지금까지 만든 상담 준비 메모(최신순, 담당 고객 것만). 노트와 달리 상태가 없다 —
   *  승인 흐름을 타지 않는 PB 본인용 문서라, 목록은 "만든 것 전부"다. */
  prepNotes: PrepNoteIndex[];
  /* ⚠️ `sessions`를 여기 다시 넣지 말 것(2026-07-30에 뺐다). `/api/sessions`를 받아
     담아 두기만 하고 **읽는 곳이 한 군데도 없었다** — 화면에 닿는 상담 데이터는 큐
     (`pending`만)와 `summary.sessions_pending`뿐이다. 문의 상세가 필요해지면 그때
     라우트를 다시 부르되, 쓰는 자리와 같이 들여올 것. */
  brief: Brief | null;
};

/** 상담 준비에 낼 노트 = 종목별 **발행분 최신 1건**(순수).
 *
 *  ⚠️ 예전 규칙은 "종목별 최신 1건"이라 **새 초안 하나가 발행분을 덮었다**(실측: 기아 #23
 *     발행분이 #32 검토중에 가려 열리지 않았다). 발행분은 PB가 상담에 실제로 써도 되는
 *     유일한 등급이고, 이 자리에서 여는 것도 그 등급에만 있는 **최종본 PDF**다.
 *  ⚠️ 미발행 노트는 여기 담지 않는다. 감추는 게 아니라 **자리가 다른 것**이다 —
 *     검토·심의는 `작성·검토` 탭의 큐가 맡는다("읽을 것"과 "처리할 일"은 다른 목록이다).
 *  ⚠️ 보류(rejected)는 호출자가 걸러서 넘긴다 — PB가 직접 버린 물건은 상담 재료가 아니다.
 *
 *  입력은 **id 내림차순**(최신 먼저)을 가정한다 — `/api/notes`가 그 순서로 준다.
 */
function pickNotes(live: NoteDetail[]) {
  const notes: Record<string, NoteDetail> = {};
  for (const d of live) {
    if (d.status === 'published' && !notes[d.stock_code])
      notes[d.stock_code] = d;
  }
  return notes;
}

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
  // PB가 각주 없는 문장에 남긴 판정(제거/승인). 준법의 확인(ack)과 같은 '사람' 칸이다 —
  // 단계와 사람이 다를 뿐 둘 다 사람이 문장을 보고 내린 판단이다.
  pb_mark_set: 'human',
  pb_mark_cleared: 'human',
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

/** 고객 목록의 한 줄. 같은 행이 **두 자리에 선다** — 위(문의 있는 고객 바로가기)와
 *  아래(전체 목록). 두 벌을 따로 적으면 한쪽만 고치는 일이 생기므로 한 곳에서 그린다.
 *  `no`는 **전체 목록에서의 자리**다(위 묶음도 그 수를 그대로 쓴다). */
function CustomerRow({
  c,
  no,
  asks,
  selected,
  onSelect,
}: {
  c: Customer;
  no: number;
  /** 미처리 문의 건수. 0이면 물음표를 안 낸다 */
  asks: number;
  selected: boolean;
  onSelect: (id: number) => void;
}) {
  const askLabel = `미처리 고객 문의 ${asks}건`;
  const flagLabel = c.flagReasons.map((r) => r.text).join(' · ');
  return (
    <tr
      tabIndex={0}
      aria-selected={selected}
      onClick={() => onSelect(c.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onSelect(c.id);
      }}
    >
      <td className="num rownum">{no}</td>
      <td>
        <strong>{c.name}</strong>
        {/* 미처리 고객 문의가 있다는 표시. 이름 **옆**에 붙는다 — 플래그(⚑)와 달리 제 칸을
            쓰지 않는 건, 훑을 때 걸러내는 축(위험)이 아니라 이 고객을 열어야 할 이유라서다.
            숫자는 배지에 적지 않고 aria-label·title에만 둔다: 한 고객에 두 건 이상은 드물고,
            표에서 필요한 건 "있다/없다"뿐이다(내역은 오른쪽 상세에 그대로 있다). */}
        {asks > 0 && (
          <span className="askmark" title={askLabel} aria-label={askLabel}>
            ?
          </span>
        )}
      </td>
      <td className={`num delta ${c.ret >= 0 ? 'up' : 'down'}`}>
        {c.ret >= 0 ? '+' : ''}
        {c.ret.toFixed(1)}%
      </td>
      <td>
        {/* `.icon`은 **폭 고정 변종**이다 — 값이 있는 행과 없는 행의 칸 너비를 맞춘다.
            모양 자체는 이름 옆 ⚑와 같다. */}
        {c.flag && (
          <span
            className="flag icon"
            title={flagLabel}
            aria-label={`위험 플래그: ${flagLabel}`}
          >
            ⚑
          </span>
        )}
      </td>
    </tr>
  );
}

/** 요약 불릿 한 줄 — **문장은 백엔드가 완성한 것 그대로**이고 여기서 하는 일은 밑줄 범위를
 *  가르는 것뿐이다(`link_text` 구간만 앵커).
 *
 *  ⚠️ 불릿 전체를 앵커로 감싸지 말 것 — `먼저 볼 것:`과 `(21명 보유)`는 공시 원문이 아니다.
 *     누르면 어디로 가는지가 밑줄 범위와 맞아야 한다.
 *  ⚠️ `link_text`를 못 찾으면 **링크 없이 문장 전체를 그대로 찍는다.** 문장을 자르거나
 *     버리는 쪽으로 틀리면 안 된다 — 링크가 없는 것보다 문장이 사라지는 게 훨씬 나쁘다. */
function DigestText({ b }: { b: BriefBullet }) {
  const at = b.href && b.link_text ? b.text.indexOf(b.link_text) : -1;
  if (at < 0 || !b.link_text || !b.href) return <>{b.text}</>;
  return (
    <>
      {b.text.slice(0, at)}
      <a href={b.href} target="_blank" rel="noreferrer">
        {b.link_text}
      </a>
      {b.text.slice(at + b.link_text.length)}
    </>
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
    /* 종목코드가 아니라 **노트 id**다 — 종목으로 열면 큐에서 고른 건과 화면이 그린 건이
       갈린다(같은 종목에 발행분과 새 초안이 같이 있으면 큐 행을 눌러도 발행분이 열렸다). */
    | { kind: 'note'; id: number }
    /* 발행분 **최종본 PDF**를 화면에 띄운다(상담 준비의 노트 줄). 검토 화면(`note`)과
       다른 모달인 이유: 상담 직전에 필요한 건 문장별 판정 도구가 아니라 **문서 자체**다. */
    | { kind: 'notepdf'; id: number }
    /* 만들어 둔 상담 준비 메모(`prep_notes.id`). 노트 PDF와 **다른 종류**로 두는 이유:
       id 공간이 다르고(노트 #12와 메모 #12는 남남), 문서 종류도 다르다. */
    | { kind: 'prepdf'; id: number }
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
  /** F1 대화를 **자리별로** 들고 있는 곳(말풍선 · 세션 id · 쓰던 질문). 쓰는 데는 둘이고 키
   *  앞머리로 갈라 둔다: 고객 문의 모달(`session-{문의id}`)과 고객 카드(`customer-{고객id}`).
   *  둘 다 전역 F1처럼 감춰 둘 수가 없어서(모달은 닫으면 언마운트되고, 카드의 채팅 칸은
   *  고객을 바꾸면 그 자리가 다른 고객의 것이 된다) 대화를 여기 페이지 쪽에 둔다.
   *  ⚠️ 키를 뭉뚱그리지 말 것 — 세션 id가 대화별로 보관되는 덕에 후속 질문이 **자기 대화의
   *     종목**만 이어받는다. 키가 겹치면 앞 고객의 종목이 다음 고객 답에 섞인다.
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
      const [customers, queue, noteIndex, summary, audit, agents, prepNotes] =
        await Promise.all([
          api<Customer[]>('/api/customers'),
          api<QueueItem[]>('/api/dashboard/queue'),
          api<NoteIndex[]>('/api/notes'),
          api<Summary>('/api/dashboard/summary'),
          api<DashboardAudit[]>('/api/dashboard/audit?limit=200'),
          api<AgentCalls[]>('/api/dashboard/agents'),
          // 목록만 받는다(본문은 PDF를 열 때 서버가 읽는다). 담당 고객 스코핑도 서버다.
          api<PrepNoteIndex[]>('/api/prep-notes').catch(() => []),
        ]);
      // 노트 본문·감사로그는 목록에 없으므로 건별 상세를 따로 받는다.
      // 목록을 큐가 아니라 /api/notes에서 받는 이유: 큐는 발행분을 빼기 때문에, 큐를 쓰면
      // **발행된 노트(= PB가 상담에 써도 되는 유일한 등급)가 상담 준비 메모에서 사라진다.**
      const details = await Promise.all(
        noteIndex.map((n) =>
          api<NoteDetail>(`/api/notes/${n.id}`).catch(() => null),
        ),
      );
      const live = details.filter(
        (d): d is NoteDetail => !!d && d.status !== 'rejected',
      );
      const notesById: Record<number, NoteDetail> = {};
      details.forEach((d) => {
        if (d) notesById[d.id] = d;
      });
      const notes = pickNotes(live);
      // 브리프는 아직 없을 수 있다(404) — 그건 오류가 아니라 상태다.
      const brief = await api<Brief>('/api/briefs/latest').catch(() => null);
      setData({
        customers,
        queue,
        notes,
        notesById,
        noteList: noteIndex,
        summary,
        audit,
        agents,
        prepNotes,
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
     자리는 둘이고 생김새가 다르다: 브리프가 **없으면** 빈 상태 본문의 1차 CTA(`생성`,
     옐로), **있으면** 머리말 오른쪽의 조용한 버튼(`↻ 다시 생성`, 옐로 아님).
     ⚠️ 라벨이 `브리핑`이 아니라 `생성`인 건 의도다 — 버튼은 **무엇을**이 아니라 **무엇을 하는지**를
        말해야 하고(카드 제목이 이미 `브리핑`이다), 이러면 있을 때의 `↻ 다시 생성`과 짝이 맞는다.
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
        즉시 실행이지만, 이건 **되돌릴 수 없다** — 그래서 **두 번 누른다**(무장 → 실행).
        노트 보류·반려와 같은 급이다.
     ⚠️ 재생성이 싸졌다고(2026-08-07 · 크레딧 0·몇 초) 이 두 번 누르기를 풀지 말 것.
        오히려 대가가 커졌다: 지운 브리프는 **다음 브리프의 "어제 대비" 기준**이라
        (`db.brief_before`), 어제 것을 지우면 오늘 카드에서 비교가 통째로 사라진다.
     ⚠️ 지우는 범위는 화면이 정하지 않는다 — 서버가 그 브리프의 **날짜에 속한 행 전부**를
        지운다(`db.delete_briefs_on`). 같은 날 재실행 회차가 쌓여 있어서, 보이는 한 행만
        지우면 직전 회차가 올라와 아무 일도 안 일어난 것처럼 보인다.
     자주 쓰는 조작이 아니라 머리말 오른쪽 끝의 작은 글자 버튼(`.btn-quiet`)이다 —
     1차 CTA도 아니고 재생성보다도 뒤다. */
  const [briefArmed, setBriefArmed] = useState(false);
  const [briefDeleting, setBriefDeleting] = useState(false);

  /* ⚠️ 브리핑 종목 카드의 접기 상태(`briefOpen`)와 임원 보고 접기(`insiderOpen`)는
     **걷어냈다**(2026-08-07 · 브리핑이 거시 전용이 되면서 접을 종목 카드가 없어졌다).
     되살린다면 상태는 카드마다가 아니라 **브리핑 하나에 하나**여야 했다: 세 카드가 가로로
     나란해서 하나만 펴면 나머지 둘은 아래가 빈 칸으로 남고, 그 빈 칸이 "이 종목은
     공시·뉴스가 없다"로 읽혔다(격자에서 높이는 가장 큰 카드가 정한다). */

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

  /* 채팅 칸 크게 보기(2026-08-03) — 3열 그리드의 한 칸이라 로그가 보이는 높이가 200px
     남짓이고, 답변 하나가 그 안에서 세 번 스크롤된다.
     ⚠️ **컴포넌트를 다른 곳으로 옮겨 그리지 않는다.** 모달 안에 `<F1Chat>`을 새로 세우면
        지금 것이 언마운트되면서 EventSource가 끊긴다 — 답을 받는 중이면 그 답이 통째로
        사라진다(F1Chat 주석의 같은 함정). 그래서 **같은 자리에 그대로 두고 클래스만
        바꿔** 화면 위로 띄운다(`.cust-chat.big`). 리마운트가 없으니 스트리밍도, 지금까지
        주고받은 대화도 그대로다.
     닫는 길은 셋이다: 같은 버튼 · 배경 클릭 · Esc. */
  const [chatBig, setChatBig] = useState(false);

  /* 고객 카드 채팅의 `↻ 새 대화`(2026-08-06) — 대화가 고객을 바꿔도 남게 된 뒤로, 끊는 자리가
     여기밖에 없다(예전엔 다른 고객을 고르는 것이 곧 비우기였다).
     ⚠️ 비우는 일은 F1Chat이 아니라 여기서 한다: 보관본을 지우고 `key`에 붙은 수를 올려
        **새 마운트로 갈아 끼운다** — 말풍선과 함께 세션 id도 버려야(F1Chat의 `reset`과 같은
        이유) 다음 질문이 방금 지운 대화의 종목을 이어받지 않는다.
     ⚠️ 조작은 채팅 칸의 **제목 줄**에 선다(`⤢` 옆) — 로그 상자 안에 겹치지 않는다는 이 화면의
        규칙 그대로다. 대화가 있을 때만 내므로 개수를 아래에서 받아 둔다. */
  const [cardChatNonce, setCardChatNonce] = useState<Record<number, number>>(
    {},
  );
  const [cardChatTurns, setCardChatTurns] = useState(0);
  const [cardChatRunning, setCardChatRunning] = useState(false);

  /* 상담 준비 메모(2026-08-06) — **AI가 낸 것 중 PB가 담은 것**. 채팅이 답을 내면 PB가
     고르고, 고른 것만 PDF로 나간다. 이 화면에서 PB가 하는 일이 "질문 고르기" 하나뿐이던
     문제의 답이다(피드백 3).
     ⚠️ **저장하지 않는다.** 서버에 고객 이야기를 쌓지 않는다는 F1의 규칙 그대로이고,
        PDF를 받을 때만 서버로 넘어간다(`sessionStorage`도 쓰지 않는다 — 같은 이유).
     ⚠️ 고객별로 나눠 담는다 — 고객을 오가며 훑는 동안 담아 둔 것이 사라지면 담는 일 자체가
        손해가 된다. 대화(`chatKeep`)도 같은 이유로 고객별로 남는다. */
  const [prep, setPrep] = useState<Record<number, PrepItem[]>>({});
  const [prepMemo, setPrepMemo] = useState('');
  /** 메모 입력창을 폈나. **기본은 접힘**이다 — 이 상자에서 주로 하는 일은 담은 것을 훑고
   *  빼는 것이고 손으로 쓰는 건 가끔이라, 늘 펴 두면 목록이 볼 수 있는 높이만 깎인다. */
  const [memoOpen, setMemoOpen] = useState(false);
  /** 담은 목록을 폈나. **기본은 접힘**이다 — 이 상자는 채팅 아래에 붙어 있어서, 펼쳐 두면
   *  담을수록 대화가 위로 밀린다. 담겼다는 사실은 제목 옆 개수와 문장 왼쪽 옐로 바가
   *  이미 말하므로, 목록은 확인하고 싶을 때 여는 것으로 둔다. */
  const [listOpen, setListOpen] = useState(false);
  const [prepBusy, setPrepBusy] = useState(false);
  const [prepError, setPrepError] = useState('');
  /* ── 만들어 둔 메모 삭제 ──────────────────────────────────────────
     ⚠️ **되돌릴 수 없다**(재료가 사라지면 다시 그릴 수 없다) — 그래서 브리핑 삭제와 같은
        규칙으로 **두 번 누른다**(무장 → 실행). 첫 누름은 그 줄만 무장시킨다.
     ⚠️ 무장은 **한 번에 한 줄**이다: 다른 줄의 쓰레기통을 누르면 앞의 무장이 풀린다.
        여러 줄이 동시에 빨갛게 서 있으면 어느 것을 지우는 중인지가 화면에서 흐려진다. */
  const [prepArmed, setPrepArmed] = useState<number | null>(null);
  const [prepDeleting, setPrepDeleting] = useState<number | null>(null);
  const deletePrepNote = useCallback(
    async (id: number) => {
      setPrepDeleting(id);
      try {
        const r = await apiDelete(`/api/prep-notes/${id}?actor=${MY_PB}`);
        if (!r.ok) {
          toast(errorMessage(r.body, '메모를 삭제하지 못했습니다.'));
          return;
        }
        toast('메모를 삭제했습니다.');
        setPrepArmed(null);
        // 방금 지운 것을 보고 있었다면 뷰어를 닫는다 — 안 닫으면 서버가 404를 주는 빈 판이
        // 그대로 서 있다(그 자리에서는 무슨 일이 일어났는지 알 수 없다).
        setModal((m) => (m?.kind === 'prepdf' && m.id === id ? null : m));
        // 목록을 다시 받는다(브리핑 삭제와 같은 이유) — 감사로그에 `prep_note_deleted`가 붙는다.
        await load();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      } finally {
        setPrepDeleting(null);
      }
    },
    [load, toast],
  );

  /** 만들어 둔 메모 목록에서 **사람이 펼쳐 둔 고객**. 값이 없으면 접힘이다(아래 `prepCard`) —
   *  새로 만든 메모가 펼쳐진 채로 끼어들어 카드가 튀어 오르지 않게 한다. */
  const [prepOpen, setPrepOpen] = useState<Record<number, boolean>>({});
  /* 담기는 **토글**이다(2026-08-06). 버튼이 담긴 뒤 `✓ 담김`으로 서서 상태를 말하므로,
     다시 누르면 빠지는 것이 그 표시의 짝이다(안 그러면 같은 문장이 두 번 담긴다).
     ⚠️ PB가 손으로 쓴 줄(memo)은 예외로 그냥 쌓는다 — 버튼이 아니라 입력창에서 오고,
        같은 문장을 두 번 적은 것을 실수라고 단정할 근거가 없다. */
  const pick = useCallback((cid: number, item: PrepItem) => {
    setPrepError('');
    setPrep((m) => {
      const cur = m[cid] ?? [];
      const k = prepKey(item);
      const at =
        item.kind === 'memo' ? -1 : cur.findIndex((x) => prepKey(x) === k);
      return {
        ...m,
        [cid]: at >= 0 ? cur.filter((_, j) => j !== at) : [...cur, item],
      };
    });
  }, []);
  const unpick = useCallback((cid: number, i: number) => {
    setPrep((m) => ({ ...m, [cid]: (m[cid] ?? []).filter((_, j) => j !== i) }));
  }, []);
  /* 담은 줄 고치기(2026-08-06) — **고친 줄은 PB 메모가 된다.**
     AI 문장을 고쳐 놓고 `sentence`로 남기면 문서의 `AI 분석` 구역에 사람이 쓴 말이 앉고,
     그 문장에 붙어 있던 각주가 **AI가 쓰지 않은 문장을 뒷받침하는 것처럼** 인쇄된다
     (가드레일 3·4). 손을 댄 순간 저자가 바뀐 것이므로 종류도 같이 바꾼다 — 화면 배지가
     `AI`에서 `PB`로 뒤집혀 그 사실을 그 자리에서 말한다.
     ⚠️ 선택지(`option`)에는 고치기를 내지 않는다 — 이름만 바꿔도 근거·`바꾸지 않는 것`
        줄들이 그대로 남아 문서가 앞뒤로 다른 말을 한다. 마음에 안 들면 빼는 것이 맞다. */
  const editPick = useCallback((cid: number, i: number, text: string) => {
    setPrep((m) => ({
      ...m,
      [cid]: (m[cid] ?? []).map((it, j) =>
        j === i ? { kind: 'memo' as const, text } : it,
      ),
    }));
  }, []);
  /** 지금 고치는 중인 줄. 고객이 바뀌면 index가 다른 사람의 줄을 가리키므로 **고객 id까지**
   *  들고 다닌다(`cid`가 다르면 편집 상자가 안 열린다). */
  const [editAt, setEditAt] = useState<{ cid: number; i: number } | null>(null);
  const [editText, setEditText] = useState('');
  /** 담은 것을 PDF로. **POST라 링크로 못 연다** — 받은 바이트를 blob으로 열어 새 탭에
   *  띄운다(서버가 `inline`으로 준다). 게이트에 걸리면 그 사유를 그대로 보여준다. */
  const prepPdf = useCallback(async (cid: number, items: PrepItem[]) => {
    setPrepBusy(true);
    setPrepError('');
    try {
      const r = await fetch(prepNotePdfUrl(cid, MY_PB), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      if (!r.ok) {
        setPrepError(errorMessage(await r.json().catch(() => null)));
        return;
      }
      const url = URL.createObjectURL(await r.blob());
      window.open(url, '_blank', 'noopener');
      // 새 탭이 읽어 간 뒤에 놓는다 — 바로 revoke하면 빈 탭이 열린다.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      // 서버가 방금 것을 남겼으므로 목록을 다시 받는다 — 만든 메모가 아래 카드에 바로
      // 서야 "저장됐다"는 사실이 화면에서 확인된다(새로고침을 시키지 않는다).
      void load();
    } catch (e) {
      setPrepError(e instanceof Error ? e.message : String(e));
    } finally {
      setPrepBusy(false);
    }
  }, [load]);
  useEffect(() => {
    if (!chatBig) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChatBig(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatBig]);
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
  /* 종류 필터(전체/종목 노트/고객 문의)는 없앴다 — 두 역할 다 queueFilter로 종목 노트만
     남기므로 고를 것이 하나뿐이었다. 큐에 다시 종류가 섞이면 그때 필터 줄을 되살린다. */

  /* 아직 처리하지 않은 고객 문의 — 큐 목록에서는 뺐지만 데이터는 그대로 살아 있고,
     이제 **고객 카드 쪽**에서 쓴다(이름 옆 물음표 · 선택한 고객의 문의 내역 · 타일 수).
     `status === 'pending'`으로 명시해 거른다: 처리 완료(done)는 화면에 남을 이유가 없고,
     "완료가 아닌 것"을 남기는 식으로 세면 나중에 상태가 하나 늘 때 조용히 섞인다.
     ⚠️ 고객 스코핑은 서버가 한다(main.PB_NAME) — 여기 오는 문의는 전부 담당 고객 것이다. */
  const pendingChats = useMemo(
    () =>
      (data?.queue ?? []).filter(
        (it): it is QueueChat => it.type === 'chat' && it.status === 'pending',
      ),
    [data],
  );
  /** 고객 id → 그 고객의 미처리 문의. 한 고객이 여러 건일 수 있어 배열이다. */
  const chatsByCustomer = useMemo(() => {
    const m = new Map<number, QueueChat[]>();
    pendingChats.forEach((c) => {
      const list = m.get(c.customer_id);
      if (list) list.push(c);
      else m.set(c.customer_id, [c]);
    });
    return m;
  }, [pendingChats]);
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

  /** 목록 맨 위에 한 번 더 세울 고객 — 미처리 문의가 있는 사람들. **거르는 게 아니라
   *  겹쳐 보이는 것**이라 아래 전체 목록은 그대로 남는다.
   *  `no`를 여기서 같이 들고 가는 건 위·아래 순번을 하나로 묶기 위해서다 — 전체 목록에서의
   *  자리를 그대로 쓰고, 위 묶음에서 1부터 다시 매기지 않는다. */
  const askRows = useMemo(
    () =>
      visibleCustomers
        .map((c, i) => ({ c, no: i + 1 }))
        .filter(({ c }) => chatsByCustomer.has(c.id)),
    [visibleCustomers, chatsByCustomer],
  );
  /** 같은 규칙으로 **위험 플래그** 묶음(2026-08-03). 판정은 화면이 하지 않는다 —
   *  `c.flag`는 서버가 규칙(순수 코드)으로 매긴 값이고 여기서는 그 값으로 고르기만 한다. */
  const flagRows = useMemo(
    () =>
      visibleCustomers
        .map((c, i) => ({ c, no: i + 1 }))
        .filter(({ c }) => c.flag),
    [visibleCustomers],
  );

  /* 무엇을 위로 올릴 것인가 — 검색창 오른쪽의 아이콘 토글 둘이 정한다(2026-08-03).
     `?`(미처리 문의) · `⚑`(위험 플래그)이고 **서로 배타적**이다. 누른 것을 다시 누르면
     꺼져서 분류가 없어진다 — 세 번째 상태를 위한 `전체` 칸을 따로 두지 않는 이유는
     이 칸의 폭(340px)에 검색창과 나란히 설 자리가 그만큼 없어서다.
     아이콘을 새로 만들지 않는 것이 핵심이다: 두 기호는 이미 목록 안에서 같은 뜻으로
     쓰이고 있어서(이름 옆 `?`, 줄 끝 `⚑`) 스위치와 결과가 같은 글자로 이어진다.
     기본값은 `none`이다(2026-08-03) — 첫 화면은 **손대지 않은 전체 목록**이어야 한다.
     문의 묶음을 켠 채로 시작하면 같은 고객이 위·아래에 두 번 서 있는 상태가 기본이 되고,
     그게 정렬 규칙인지 중복인지를 화면이 설명하지 않는다. 분류는 PB가 필요할 때 켠다. */
  const [groupBy, setGroupBy] = useState<'none' | 'ask' | 'flag'>('none');
  const topRows =
    groupBy === 'ask' ? askRows : groupBy === 'flag' ? flagRows : [];

  /* ⚠️ 종목코드 → 보유 고객 수(`holders`)를 걷어냈다(2026-08-07). 브리프 카드의
     `N명 보유` 배지 하나가 유일한 쓰임이었는데, 브리핑에서 종목이 빠지면서 배지도 없어졌다.
     같은 집계가 필요해지면 백엔드에 이미 있다(`main.holdings_index`) — 프론트에서 다시
     세지 말 것. */
  const selected = useMemo(
    () =>
      visibleCustomers.find((c) => c.id === selectedId) ??
      visibleCustomers[0] ??
      null,
    [visibleCustomers, selectedId],
  );

  /* 대화를 어느 자리에 보관하나 · 어느 것을 마운트하나 — **키는 고객별, nonce는 `key`에만**.
     보관 키에 nonce를 섞지 않는 이유: 비울 때 자리를 옮기는 게 아니라 그 자리의 내용을
     갈아 끼우는 것이라야, 쓰던 질문을 그대로 넘겨줄 수 있다(아래). */
  const cardChatKeep = selected ? `customer-${selected.id}` : '';
  const cardChatKey = selected
    ? `${cardChatKeep}:${cardChatNonce[selected.id] ?? 0}`
    : '';
  /* 이 고객의 대화를 비운다 — 말풍선과 **세션 id를 함께** 버린다(F1Chat의 `reset`과 같은
     이유: 세션이 남으면 다음 질문이 방금 지운 대화의 종목을 이어받는다).
     ⚠️ **입력창은 비우지 않는다** — 지금 쓰고 있는 질문은 지난 대화가 아니라 사람의 것이다
        (모달의 `↻ 새 대화`와 같은 규칙). 그래서 지우는 대신 빈 대화 + 쓰던 질문으로 덮어쓰고,
        `key`의 수를 올려 F1Chat이 그것을 읽으며 새로 서게 한다.
     ⚠️ 도는 중에는 막는다: 지금 끊으면 받는 중인 답을 크레딧만 쓰고 버리게 된다. */
  const resetCardChat = useCallback(() => {
    if (!selected || cardChatRunning) return;
    chatKeep.set(cardChatKeep, {
      turns: [],
      session: null,
      input: chatKeep.get(cardChatKeep)?.input ?? '',
    });
    setCardChatNonce((m) => ({
      ...m,
      [selected.id]: (m[selected.id] ?? 0) + 1,
    }));
    setCardChatTurns(0);
  }, [selected, cardChatRunning, cardChatKeep, chatKeep]);

  /* 이 고객에 대해 **이미 담은 것**. 답변 문장·선택지의 `담기` 버튼이 이걸 보고 `✓ 담김`으로
     선다. 메모 상자가 원본이고 이건 파생값이라, ×로 뺀 것이 버튼에도 그 프레임에 반영된다 —
     F1Chat이 따로 들고 있으면 둘이 갈려 버튼만 담긴 척 남는다. */
  const pickedKeys = useMemo(
    () => new Set((selected ? (prep[selected.id] ?? []) : []).map(prepKey)),
    [prep, selected],
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
        ? { kind: 'note', id: it.id }
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

  const flagged = roleCustomers.filter((c) => c.flag).length;

  /* "AI가 오늘 한 일" — 백엔드가 감사로그에서 센 오늘치만 쓴다(프론트에서 audit 목록을
     세면 최근 N건 제한 때문에 조용히 적게 세인다). **0인 항목은 아예 적지 않는다** —
     "0건"을 나열하면 아무것도 안 한 날도 일한 것처럼 보인다. */
  const today = data.summary.today;
  const briefToday =
    data.brief?.brief_date === days[days.length - 1].key ? data.brief : null;

  /* 거시 띠의 **대표 기준일** — 줄 끝에 한 번만 적을 날짜.
     지표마다 날짜를 적으면 같은 날짜가 다섯 번 나와 정작 값과 등락을 덮는다.

     예전에는 "전부 같을 때만" 적었는데(2026-08-06), 공급자가 둘이 되면서 **거의 항상 갈린다**:
     환율은 매매기준율이라 당일 아침에 나오고, 국고채는 전 거래일 공표치다(실측 2026-08-07 —
     원/달러 08-07 · 나머지 08-06). 그 규칙이면 다섯 지표가 전부 제 날짜를 달고 선다.
     ⚠️ 2026-08-09에 띠가 미국 지표 위주로 바뀌면서 이 규칙이 더 필요해졌다 — 나스닥·S&P500은
        미국장이 한국 시간 밤에 닫아 국내 지표와 하루가 어긋나고, 미국채30년(재무부 CMT)은
        그 지수보다 또 하루 늦게 붙는 날이 있다(실측 2026-08-07 — 지수 08-07 · DGS30 08-06).

     그래서 **가장 많은 지표가 공유하는 날짜**를 대표로 뽑고, 거기서 벗어나는 지표만 제
     날짜를 단다(아래 렌더). 합쳐서 뭉개는 게 아니다 — 어느 수가 어느 날짜인지는 여전히
     화면에서 하나하나 확정된다.
     ⚠️ 혼자인 날짜는 대표가 될 수 없다(2건 이상). 지표가 하나뿐이면 그 지표가 직접 적는다. */
  const mktAsOf = (() => {
    const ixs = data.brief?.market?.indices ?? [];
    const count = new Map<string, number>();
    ixs.forEach((x) => count.set(x.as_of, (count.get(x.as_of) ?? 0) + 1));
    const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    return top && top[1] >= 2 ? top[0] : null;
  })();
  /* 카드 맨 위 요약 불릿 — **백엔드가 완성한 문장을 그대로 꺼내 쓴다.**
     여기서 items를 다시 훑어 문장을 만들면 규칙이 두 벌이 되고, 화면과 저장된 브리프가
     서로 다른 말로 "오늘 무슨 일이 있었나"를 답하게 된다. */
  const briefBullets = data.brief?.lead?.bullets ?? [];
  const aiwork = [
    /* 브리핑은 이제 거시 전용이라 셀 종목이 없다(2026-08-07 · 예전엔 `N종목 수집`이었다).
       ⚠️ **이 줄에 지수 개수를 적지 말 것** — 매일 2로 고정된 수라 "오늘 무엇을 했나"를
          말하지 못하고, 그런 수를 적으면 아무 일 없는 날도 일한 것처럼 보인다. */
    briefToday && '브리핑 생성',
    today.tool_calls &&
      `에이전트 도구 호출 ${today.tool_calls}건${today.agents ? ` (에이전트 ${today.agents}종)` : ''}`,
    today.chats && `종목 즉답 ${today.chats}건`,
    today.notes && `종목 노트 ${today.notes}건`,
  ].filter((x): x is string => typeof x === 'string');

  const tiles =
    role === 'pb'
      ? [
          // 설명줄은 바로 위 숫자를 쪼갠 것이어야 한다.
          {
            label: '담당 고객',
            value: String(roleCustomers.length),
            breakdown: `위험 플래그 ${flagged}`,
          },
          {
            // 아직 답하지 않은 고객 문의 수. 내역줄이 없는 건 쪼갤 것이 없어서다 —
            // 쪼갤 게 없는데 적으면 바로 위 숫자를 그대로 되풀이하게 된다.
            // 누르는 곳이 아니다(go 없음): 문의는 이 화면 아래 고객 목록에서 물음표로
            // 표시되고 고른 고객의 상세에 내역이 붙는다 — 갈 곳이 따로 없다.
            label: '고객 문의',
            value: String(pendingChats.length),
          },
        ]
      : // 준법 심의 탭엔 타일을 두지 않는다. 심의 대기 수는 아래 처리 대기 카드("N건"+목록)에,
        // 게이트 차단은 감시 탭(AI 신뢰도 카드)에 이미 있어 타일은 중복 요약일 뿐이었다.
        [];

  /* "AI가 오늘 한 일" — 큐와 같이 **한 번 정의하고 자리만 옮긴다.**
     궁금할 때 열어보는 것이지 늘 보고 있을 내용이 아니라 접어 둔다. 숫자는 전부 훅이 남긴
     감사로그 실집계다(없으면 없다고 말한다). 펼침은 native <details>다 — 직접 만든 토글은
     키보드·스크린리더 동작을 다시 구현해야 하지만 이건 브라우저가 준다.

     **자리는 감시 탭 하나다**(2026-08-06). 이 줄은 "오늘 손댈 것"이 아니라 **지켜본 결과**라
     심의(처리) 탭이 아니라 감시 탭에 속한다 — 감시 탭의 다른 카드(AI 신뢰도·알림·감사로그)와
     같은 성격이고 실제로 같은 감사로그를 원본으로 쓴다.
     ⚠️ 예전에는 감시 탭이 없는 역할(PB)의 첫 탭 맨 위에도 놓았는데 걷어냈다 — PB의 첫 화면
        맨 윗자리는 상담 준비(브리핑·고객)의 것이고, 지켜본 결과가 그 앞에 설 이유가 없다.
        **PB 화면에 되살리지 말 것.** */
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

  /* 발행된 노트 — **읽을 것**의 목록이다. 바로 아래 `종목 노트` 카드는 **처리할 일**의
     목록이고(큐는 발행분을 뺀다), 둘은 같지 않다(HANDOFF §2 · `/api/notes` 주석).
     지금까지 발행된 노트는 화면 어디에도 목록이 없었다 — 고객 카드의 보유 표를 펴야
     한 종목씩 나왔고, 그래서 "다 된 게 뭐가 있나"를 볼 자리가 없었다.

     ⚠️ **PDF로 열리는 유일한 등급이 발행분이다**(`notePdfUrl`이 다른 상태면 서버가 409).
        카드 이름이 곧 왜 여기 것만 PDF가 되는지를 말한다 — `완성된`·`보관함` 같은 말로
        바꾸면 그 연결이 끊긴다.
     ⚠️ **다시 정렬하지 않는다.** `/api/notes`가 이미 최신순(id DESC)이고, 여기서 또 정렬하면
        순서 규칙이 두 벌이 된다.
     ⚠️ 상태 배지를 줄마다 달지 않는다 — 이 카드는 한 상태만 담아서 모든 행이 카드 제목을
        그대로 반복하게 된다(옆 큐 카드에서 종류 배지를 뺀 것과 같은 이유). */
  const publishedNotes = data.noteList.filter((n) => n.status === 'published');
  const publishedCard = (
    <section className="card" aria-labelledby="pub-title">
      <div className="card-head">
        <h2 id="pub-title">발행된 노트</h2>
        <span className="hint" aria-live="polite">
          {publishedNotes.length}건
        </span>
      </div>
      <div className="queue">
        {publishedNotes.map((n) => {
          // 본문 상세를 못 받은 건은 PDF 모달이 아무것도 못 그린다 — 누르면 조용히
          // 아무 일도 안 일어나느니, 눌리지 않고 이유를 말하는 편이 낫다.
          const ready = !!data.notesById[n.id];
          return (
            <div className="qrow" key={n.id}>
              <span className="title">
                {n.corp_name}({n.stock_code})
              </span>
              {/* `updated_at`은 마지막 상태 변화 시각인데, 발행이 종착이라 발행분에서는
                  곧 발행 시각이다. 그래도 `발행 시각`이라고 단정해 적지는 않는다. */}
              <span className="meta">{fmtDateTime(n.updated_at)}</span>
              <span className="spacer" />
              <button
                className="btn"
                disabled={!ready}
                title={
                  ready
                    ? `${n.corp_name} 종목 노트 PDF 열기`
                    : '노트 본문을 불러오지 못했습니다. 새로 고쳐 주세요.'
                }
                onClick={() => setModal({ kind: 'notepdf', id: n.id })}
              >
                PDF
              </button>
            </div>
          );
        })}
        {!publishedNotes.length && (
          <div className="hint" style={{ padding: '10px 4px' }}>
            아직 발행된 노트가 없습니다. 검토·심의를 거쳐 발행되면 여기
            쌓입니다.
          </div>
        )}
      </div>
    </section>
  );

  /* 만들어 둔 상담 준비 메모 — `발행된 노트`와 **같은 형식**(제목 · 시각 · PDF 버튼)이되
     고객으로 한 겹 묶는다. 한 고객에게 날짜가 다른 여러 건이 쌓이므로, 평평한 목록이면
     같은 이름이 줄줄이 반복되고 "이 고객 것이 몇 건인가"를 세어야 알게 된다.

     ⚠️ **줄이 곧 문서다** — 메모에는 노트 같은 상태(검토·심의·발행)가 없다. 승인 흐름을
        타지 않는 PB 본인용 문서라 만든 것이 전부이고, 그래서 상태 배지도 없다.
     ⚠️ 묶음 제목에 **고객 이름**을 쓴다(파일명은 번호다 — `notepdf.prep_filename`).
        여기는 담당 PB만 보는 화면이고 바로 위 표가 이미 이름으로 고객을 가리킨다.
     ⚠️ **정렬하지 않는다**: 서버가 최신순으로 주고 묶음 순서도 그 안에서 처음 나온 순서다. */
  const prepGroups: { id: number; name: string; rows: PrepNoteIndex[] }[] = [];
  {
    const byId = new Map<number, { id: number; name: string; rows: PrepNoteIndex[] }>();
    for (const p of data.prepNotes) {
      const g = byId.get(p.customer_id);
      if (g) {
        g.rows.push(p);
        continue;
      }
      const made = { id: p.customer_id, name: p.customer_name, rows: [p] };
      byId.set(p.customer_id, made);
      prepGroups.push(made);
    }
  }
  const prepCard = (
    <section className="card" aria-labelledby="prep-title">
      <div className="card-head">
        <h2 id="prep-title">상담 준비 메모</h2>
        <span className="hint" aria-live="polite">
          {data.prepNotes.length}건
        </span>
      </div>
      <div className="queue">
        {prepGroups.map((g) => (
          <details
            className="prepgrp"
            key={g.id}
            /* **기본은 접힘**이다(2026-08-06). 한동안 지금 고른 고객의 묶음을 펼쳐 뒀는데,
               메모를 새로 만들면 그 고객이 곧 고른 고객이라 새 줄이 **펼쳐진 채로** 나타나
               카드 높이가 그때마다 뛰었다. 목록은 훑는 자리이고, 펴는 건 사람이 정한다. */
            open={prepOpen[g.id] ?? false}
            /* ⚠️ 열림 여부를 **여기서 읽어 둔다.** `setPrepOpen`의 갱신 함수는 나중에
               (렌더 중에) 도는데, 그때 `e.currentTarget`은 React가 이미 비운 뒤라
               null이다 — 그 자리에서 읽으면 화면이 통째로 죽는다(실측). */
            onToggle={(e) => {
              const open = e.currentTarget.open;
              setPrepOpen((m) => ({ ...m, [g.id]: open }));
            }}
          >
            <summary>
              {/* 번호 → 이름 → 건수 → 최근 시각. 접었을 때 남는 것들이고, 이 순서가
                  "누구 것 · 얼마나 · 언제까지"를 한 줄로 읽게 한다.
                  ⚠️ 번호는 **고객 id**다(고객 표의 순번이 아니다) — 표의 `#`는 검색·분류로
                     바뀌는 자리 번호라, 그걸 쓰면 검색 한 번에 같은 메모의 번호가 달라진다.
                     id는 PDF 파일명(`상담메모_고객3_0806.pdf`)·감사로그가 쓰는 값과 같다. */}
              <span className="cno">#{g.id}</span>
              <strong>{g.name}</strong>
              <span className="hint">{g.rows.length}건</span>
              <span className="meta">최근 {fmtDateTime(g.rows[0].created_at)}</span>
            </summary>
            {g.rows.map((p) => (
              <div className="qrow" key={p.id}>
                {/* 묶음 안에서 건을 가르는 것은 **시각**이다(고객 이름은 제목 줄이 이미
                    말했다) — 그래서 시각이 발행된 노트의 종목명 자리에 선다. */}
                <span className="title">{fmtDateTime(p.created_at)}</span>
                <span className="meta">{p.items}개 항목</span>
                <span className="spacer" />
                {/* 노트 PDF와 **같은 방식**으로 연다 — 화면 안 뷰어(모달)에 그대로 싣는다.
                    저장된 문서를 GET으로 받는 자리라 blob으로 감싸지 않는다(만들 때는
                    POST라 어쩔 수 없이 blob이었다). */}
                <button
                  className="btn"
                  title={`${g.name} 상담 준비 메모 PDF 열기 (${fmtDateTime(p.created_at)})`}
                  onClick={() => setModal({ kind: 'prepdf', id: p.id })}
                >
                  PDF
                </button>
                {/* 삭제 — **되돌릴 수 없어서 두 번 눌러야 실행된다**(브리핑 삭제와 같은
                    규칙). 첫 누름은 이 줄만 무장시키고, 무장은 라벨이 아니라 **색(적색)과
                    옆에 선 `취소`**가 말한다. 평소에는 글리프 하나라 설명은 title이 나른다. */}
                {prepArmed === p.id ? (
                  <>
                    <button
                      className="btn-quiet danger"
                      disabled={prepDeleting === p.id}
                      onClick={() => void deletePrepNote(p.id)}
                    >
                      {prepDeleting === p.id ? '삭제 중…' : '삭제'}
                    </button>
                    <button
                      className="btn-quiet"
                      disabled={prepDeleting === p.id}
                      onClick={() => setPrepArmed(null)}
                    >
                      취소
                    </button>
                  </>
                ) : (
                  <button
                    className="iconbtn"
                    aria-label={`${g.name} ${fmtDateTime(p.created_at)} 메모 삭제`}
                    title="이 메모를 지웁니다 — 되돌릴 수 없습니다"
                    onClick={() => setPrepArmed(p.id)}
                  >
                    {/* 글꼴에 기대지 않는다(🗑는 기기마다 색·모양이 다르고, 이 줄에서
                        혼자 컬러 이모지가 된다). 선은 `currentColor`라 테마·상태를
                        그대로 따라간다. */}
                    <svg
                      viewBox="0 0 16 16"
                      width="14"
                      height="14"
                      aria-hidden="true"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                    >
                      <path d="M2.5 4h11M6.5 4V2.6h3V4M4 4l.7 9.4h6.6L12 4M6.6 6.4v5M9.4 6.4v5" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </details>
        ))}
        {!data.prepNotes.length && (
          <div className="hint" style={{ padding: '10px 4px' }}>
            아직 만든 메모가 없습니다. 위 고객 카드에서 답변·선택지를 담아 PDF로
            만들면 여기 쌓입니다.
          </div>
        )}
      </div>
    </section>
  );

  /* 처리 대기 카드 — 두 화면이 나눠 갖는다.
     PB에게는 「작성·검토」 탭(만드는 것과 처리하는 것을 같이 두는 곳)에,
     준법에게는 그 탭이 없으므로 원래 자리에 남긴다 — 준법이 큐를 잃으면
     심의할 노트를 화면에서 찾을 방법이 아예 없어진다.

     ⚠️ 이름은 **`처리 대기`**다(2026-08-06에 `종목 노트`에서 되돌렸다). 이 카드가 담는 건
        노트 전부가 아니라 **아직 처리할 것**이고(발행분은 빠진다), 바로 위에 `발행된 노트`가
        서면서 `종목 노트`라는 이름이 둘을 다 가리키는 것처럼 읽혔다.
        코드의 나머지는 줄곧 이 이름을 쓰고 있었다 — 생성 토스트(`처리 대기 큐에 올렸습니다`),
        보류·처리 완료 토스트, `PILL` 주석(`처리 대기 → 처리 완료`가 짝), `db.py`·`main.py`
        주석. 카드 하나만 갈려 있던 것이라 되돌리는 쪽이 맞다. */
  const queueCard = (
    <section className="card" aria-labelledby="q-title">
      <div className="card-head">
        <h2 id="q-title">처리 대기</h2>
        {/* 건수는 두 화면 모두 **제목 옆**에 둔다 — 세는 대상(제목)에서 멀어지면 표 헤더처럼
            읽힌다. aria-live: 목록이 갈리는 변화가 스크린리더에는 안 들리므로 수를 읽어 준다. */}
        <span className="hint" aria-live="polite">
          {roleQueue.length}건
        </span>
      </div>
      <div className="queue">
        {roleQueue.map((it) => {
          const [label, cls] = PILL[it.status] ?? [it.status, ''];
          return (
            <div className="qrow" key={`${it.type}-${it.id}`}>
              {/* 종류 배지(`종목 노트`)는 뺐다 — 목록이 한 종류뿐이라 배지가 가르는 게
                  없다. 종류가 다시 섞이면(고객 문의가 큐로 돌아오면) 되살릴 자리다. */}
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
        {!roleQueue.length && (
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
        {/* ⚠️ 여기 있던 「AI가 오늘 한 일」은 걷어냈다(2026-08-06) — **감시 탭에만 산다.**
            그 줄은 "오늘 손댈 것"이 아니라 **지켜본 결과**라, PB의 첫 화면 맨 위에서
            상담 준비(브리핑·고객)보다 앞자리를 먹을 이유가 없었다. 성격이 같은 카드
            (AI 신뢰도·컴플라이언스 알림·감사로그)가 전부 감시 탭에 있고 원본도 같은
            감사로그다. **PB 화면에 되살리지 말 것.** */}

        {/* 오늘 규모(내 담당 고객·내 처리 대기) → 바로 만들 수 있는 것(종목 노트) 순서다.
            그 아래로 읽을거리(브리핑·처리 대기·고객)가 이어진다. */}
        {/* 타일은 어느 화면에서나 균등 2열이다. 한때 준법 화면에서만 감시 탭의
            사이드바 격자(2fr 1fr)에 맞췄는데, 두 타일의 무게가 같은데 폭이 다르면
            왼쪽이 더 중요한 것처럼 읽힌다 — 탭 사이 이음매보다 이쪽이 우선이다. */}
        {/* 타일이 없으면(준법: 아래 처리 대기 카드가 같은 정보를 담는다) 빈 그리드를 안 낸다. */}
        {tiles.length > 0 && (
          <div className="tile-row">
            {/* 지금은 두 타일 다 **읽는 값**이다 — 누르는 타일(`.tile.clickable`,
                라벨 옆 →)은 없앴다. 처리 대기 노트 타일이 작성·검토 탭으로 가던 자리인데,
                고객 문의 수로 바뀌면서 갈 곳이 없어졌다(문의는 이 화면 아래에 있다).
                다시 필요해지면 button + setView로 되살린다 — CSS는 그대로 있다. */}
            {tiles.map((t) => (
              <div className="tile" key={t.label}>
                <div className="label">{t.label}</div>
                <div className="value">{t.value}</div>
                {/* 설명줄이 없는 타일은 빈 칸을 남기지 않는다(빈 div도 자리를 차지한다). */}
                {'breakdown' in t && t.breakdown && (
                  <div className="breakdown">{t.breakdown}</div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* 브리핑 (F2) — **거시 전용**(2026-08-07). 오늘 지수와, 어제 대비 달라진 것. */}
        <section className="card" aria-labelledby="b-title" hidden={!cfg.brief}>
          <div className="card-head">
            {/* `종목 브리핑`이 아니라 `브리핑`이다(2026-08-07 · 2026-08-03 결정을 뒤집음).
                그때는 이 카드가 담는 게 지수 한 줄 + **보유 상위 종목**이라 이름이 무엇에
                대한 브리핑인지까지 말해야 했다. 지금은 종목이 없고 담는 것이 거시 하나라,
                한정어가 가리킬 대상이 사라졌다.
                ⚠️ `거시 브리핑`으로도 하지 않는다 — PB가 아침에 여는 화면에서 브리핑은
                   이것 하나이고, 옆에 다른 브리핑이 없으면 한정어는 고르는 데 쓰이지 않는다. */}
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
                       카드가 **비어 있을 때**의 `생성` 하나뿐이다(HANDOFF §0-1).
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
              {/* 지수 띠 — **카드 맨 위**다(2026-08-07 · 2026-08-06 결정을 뒤집음).
                  그때는 요약 불릿이 위였다: 불릿이 "오늘 무슨 일이 있었나"를 통째로 답하고
                  지수·종목 카드가 그 근거였기 때문이다. 지금은 카드에 담긴 것이 거시 하나라
                  **숫자 자체가 카드**이고, 불릿은 그 숫자에 붙는 해석이다 — 해석이 숫자보다
                  위에 서면 무엇에 대한 말인지 모르는 채로 먼저 읽게 된다.
                  못 가져왔으면 빈칸으로 두지 않고 미연결 사유를 그대로 말한다. */}
              {data.brief.market?.indices?.length ? (
                <div className="mkt">
                  {data.brief.market.indices.map((ix) => {
                    /* `move`가 없으면 2026-08-07 이전 브리프다 — 그때는 지수뿐이었고
                       값이 `change_pct`에 있었다(backend `brief.move_of`와 같은 폴백). */
                    const move = ix.move ?? ix.change_pct;
                    const down = move !== undefined && isDown(move);
                    return (
                      <span className="mkt-item" key={ix.index_name}>
                        <span className="mkt-name">{ix.index_name}</span>
                        <strong>
                          {fmtLevel(ix.close)}
                          {ix.level_unit ?? ''}
                        </strong>
                        {/* ⚠️ 움직임을 못 받았으면 **아무것도 그리지 않는다.** `▲0.00%`로
                            채우면 "오늘 안 움직였다"는 없는 사실이 되고, 수준(왼쪽)은
                            멀쩡히 있으므로 줄이 비어 보이지도 않는다. */}
                        {move !== undefined && (
                          <span className={`delta ${down ? 'down' : 'up'}`}>
                            {down ? '▼' : '▲'}
                            {fmtMove(move, ix.move_unit)}
                            {ix.move_unit ?? '%'}
                          </span>
                        )}
                        {/* 대표 기준일에서 **벗어나는 지표만** 표시를 단다(mktAsOf 참조).
                            `지연`(주가지수 종가)과 `공표`(한국은행 환율·금리, 미 재무부 국채
                            수익률)를 가려 적는다 — 둘은 성격이 달라서, 환율에 `지연`이라고
                            쓰면 틀린 말이 된다. 판단 근거는 백엔드가 준 `basis` 하나다.

                            2026-08-09: 날짜를 글자로 적던 자리(`· 2026-08-06 공표`)를 `i`
                            하나로 줄였다. 미국 지표가 들어오면서 어긋나는 지표가 날마다
                            달라져, 띠가 매일 다른 자리에서 길어졌다 짧아졌다 했다.
                            ⚠️ **`title`을 쓰지 않는다.** 브라우저 기본 툴팁은 1초쯤 머물러야
                               뜨고 몇 초 뒤 저절로 사라져서, 커서만 `?`로 바뀌고 글자는 안
                               뜨는 것처럼 보인다(실제로 그렇게 보였다). 문구는 CSS가
                               `data-tip`으로 그린다(`.mkt-odd::after`) — 바로 뜨고 머문다.
                            ⚠️ 그래서 문구를 **한 번 만들어** `data-tip`과 `aria-label`에 같이
                               쓴다. 따로 조립하면 보이는 글자와 읽히는 글자가 갈린다.
                            ⚠️ 이 표시는 **감춤이 아니라 접기**여야 한다: 그리는 조건에
                               `:focus-visible`을 같이 두고(css) tabIndex로 초점을 받는다 —
                               마우스가 없으면 날짜가 통째로 사라지면 안 된다. */}
                        {ix.as_of !== mktAsOf &&
                          (() => {
                            const odd = `${fmtDate(ix.as_of)} ${
                              ix.basis === '공표' ? '공표' : '지연'
                            }`;
                            return (
                              <span
                                className="mkt-odd"
                                tabIndex={0}
                                role="note"
                                aria-label={`${ix.index_name} 기준일 ${odd}`}
                                data-tip={odd}
                              >
                                i
                              </span>
                            );
                          })()}
                      </span>
                    );
                  })}
                  {/* 대표 기준일은 줄 끝에 한 번만. 숫자를 읽는 데 방해가 되지 않게
                      오른쪽 끝으로 밀고 톤을 낮추되, 지우지는 않는다 — 이 값이 오늘
                      것이 아니라는 사실은 화면에 남아 있어야 한다.
                      ⚠️ `종가`라고 쓰지 않는다(2026-08-07) — 이 띠에는 종가(주가지수)와
                         공표치(환율·금리)가 섞여 있어서, 한 낱말로 둘 다를 부르면 한쪽이
                         틀린 말이 된다. 성격은 지표마다 위에서 적고, 여기는 날짜만 맡는다. */}
                  {mktAsOf && (
                    <span
                      className="mkt-asof"
                      title="나스닥·S&P500은 일별 종가(FRED), 원/달러·국고채10년은 한국은행 일별 공표치, 미국채30년은 미 재무부 국채 수익률(CMT) 일별 공표치다(모두 실시간 아님). 기준일이 다른 지표는 값 옆에 제 날짜를 단다."
                    >
                      {fmtDate(mktAsOf)} 기준
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
              {/* 요약 불릿 — **지수 띠 바로 아래**(2026-08-07 · 위 주석 참조). 바로 위
                  숫자를 읽고 나서 "그래서 어제와 뭐가 다른가"를 답하는 자리다.
                  ⚠️ **문장을 여기서 만들지 않는다** — 백엔드가 완성해서 보낸 것을 그대로
                     찍는다(types.ts `BriefBullet`). 없는 항목은 오지 않으므로 빈 자리를
                     문구로 채우지도 않는다.
                  ⚠️ 새 색을 쓰지 않는다. 종류를 가르는 일은 색이 아니라 **문장**이 한다.
                  ⚠️ 평소 대비 꼬리표(`notable`)를 **지수 띠에 또 적지 말 것** — 같은 사실이
                     두 줄이 되고, 그때는 어느 쪽이 맞는지가 아니라 왜 두 번 적혔는지를
                     화면이 설명하지 못한다(backend `brief._notable_bullets` 주석). */}
              {briefBullets.length > 0 && (
                <ul className="digest">
                  {briefBullets.map((b, i) => (
                    <li className={`digest-${b.kind}`} key={i}>
                      <DigestText b={b} />
                      {/* **규칙이 쓴 문장과 구분한다.** 이 불릿들은 본문이 아니라
                          `lead_json`에 살아 컴플라이언스 게이트를 안 탄다 — 나머지는
                          "데이터에 없는 말을 못 한다"는 보장이 있고 이것만 없다.
                          그 사실을 말하는 자리가 화면에서 이 배지뿐이라 **빼지 말 것**.
                          ⚠️ 켜지는 건 밤사이 헤드라인(`news`) 하나뿐이다. */}
                      {b.ai && (
                        <span
                          className="digest-ai"
                          title="이 한 줄은 AI가 뉴스 제목만 보고 쓴 요약입니다. 나머지 불릿은 규칙이 씁니다."
                        >
                          AI 요약
                        </span>
                      )}
                      {/* 근거 기사 — **각주 번호로 전부 건다.** 한 링크가 대표하지 못하는
                          문장이라(여러 제목을 뭉친 것) 대표를 고르지 않는다.
                          ⚠️ **빼지 말 것.** 종목 카드가 없어지면서 이 문장의 출처를 확인할
                             자리가 화면에서 여기뿐이다(가드레일 3 · types.ts `sources`).
                          ⚠️ 제목은 `title`로만 단다 — 여섯 건을 다 펴면 요약 한 줄이
                             목록보다 길어진다(요약이 목록이 되는 것을 막는 규칙). */}
                      {(b.sources ?? []).map((s, n) => (
                        <a
                          key={s.url}
                          className="digest-src"
                          href={s.url}
                          target="_blank"
                          rel="noreferrer"
                          title={s.title}
                        >
                          [{n + 1}]
                        </a>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
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
               ⚠️ 진행 표시는 **버튼 라벨이 맡는다**(`생성` → `생성 중…`). 옆에 곁말로
                  두면 버튼과 문구가 두 덩어리로 서고, 비활성 버튼이 "왜 안 눌리지"로 먼저
                  읽힌다 — 라벨이 바뀌면 그 자리에서 답이 된다.
                  누르기 전 예상 소요는 안 적는다(망설이게만 한다). **라벨 전환 자체는 남긴다**:
                  블로킹 POST라 도는 동안 화면이 조용하다. 그 시간은 이제 몇 초다(2026-08-07 —
                  거시 전용이 되면서 LLM이 빠졌다. 예전엔 40~50초였다). */
            <div className="brief-empty">
              <p className="hint" style={{ margin: 0 }}>
                아직 오늘 브리핑이 없습니다. 오늘 지수와 어제 대비 달라진 것을
                모아 생성합니다.
              </p>
              <div className="brief-empty-run">
                <button
                  className="btn primary"
                  onClick={() => void runBrief()}
                  disabled={briefRunning}
                >
                  {briefRunning ? '생성 중…' : '생성'}
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
                  {/* 검색과 분류가 한 줄에 선다 — 둘 다 "무엇을 먼저 볼까"를 정하는
                      조작이라 붙여 두면 눈이 한 번만 멈춘다. */}
                  <div className="cust-tools">
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
                    {/* 분류 토글 — 아이콘은 목록 안의 것과 **같은 기호**다(이름 옆 `?`,
                        줄 끝 `⚑`). 개수를 같이 적어 누르기 전에 몇 명이 올라올지 보인다.
                        낭독에는 `aria-pressed`로 켜짐/꺼짐이 실린다. */}
                    {(
                      [
                        ['ask', '?', askRows.length, '미처리 문의'],
                        ['flag', '⚑', flagRows.length, '위험 플래그'],
                      ] as const
                    ).map(([key, icon, n, label]) => (
                      <button
                        key={key}
                        type="button"
                        className={`grpbtn ${key}${groupBy === key ? ' on' : ''}`}
                        aria-pressed={groupBy === key}
                        title={
                          groupBy === key
                            ? `${label} 고객을 위로 올려 두었습니다 — 다시 누르면 분류가 풀립니다`
                            : `${label} 고객 ${n}명을 목록 위로 올립니다`
                        }
                        onClick={() =>
                          setGroupBy((g) => (g === key ? 'none' : key))
                        }
                      >
                        <span aria-hidden="true">{icon}</span>
                        <span className="grpbtn-n">{n}</span>
                        <span className="sr-only">{label}</span>
                      </button>
                    ))}
                  </div>
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
                        {/* 고른 묶음(미처리 문의 또는 위험 플래그)을 **맨 위에 한 번 더**
                            세운다. 거르는 게 아니라 겹쳐 보이는 것이다 — 아래 전체 목록은
                            1~50 그대로 남고, 위 묶음은 오늘 먼저 볼 사람의 바로가기다.
                            ⚠️ 순번(#)은 위·아래가 **같은 수**여야 한다 — 위 묶음에서 1,2,3을
                               다시 매기면 같은 고객이 두 자리 번호를 갖게 되고, 오른쪽 상세의
                               `selectedNo`(전체 목록 기준)와도 어긋난다.
                            검색 중이면 위 묶음도 같이 걸러진다: 아래 목록에 없는 사람이
                            위에만 남아 있으면 검색이 걸리지 않은 것처럼 보인다. */}
                        {topRows.map(({ c, no }) => (
                          <CustomerRow
                            key={`top-${c.id}`}
                            c={c}
                            no={no}
                            asks={chatsByCustomer.get(c.id)?.length ?? 0}
                            selected={selected?.id === c.id}
                            onSelect={setSelectedId}
                          />
                        ))}
                        {topRows.length > 0 && (
                          /* 구분선 한 줄. 누르는 행이 아니다 — 보이는 건 선뿐이고,
                             화면 낭독에는 "여기부터 전체 고객"이 대신 읽힌다
                             (선은 보이지 않으므로 목록이 왜 다시 시작하는지 알 길이 없다). */
                          <tr className="tsep">
                            <td colSpan={4}>
                              <span className="sr-only">
                                여기부터 전체 고객
                              </span>
                            </td>
                          </tr>
                        )}
                        {visibleCustomers.map((c, i) => (
                          <CustomerRow
                            key={c.id}
                            c={c}
                            no={i + 1}
                            asks={chatsByCustomer.get(c.id)?.length ?? 0}
                            selected={selected?.id === c.id}
                            onSelect={setSelectedId}
                          />
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
                      {/* 등록 성향 옆에 **상황을 반영한 실질 성향**을 붙인다(2026-08-07).
                          이 카드가 오래 `공격투자형`만 적어 왔는데, 정작 상담에서 먼저 확인할
                          것은 그 등록값이 지금도 유효한가다 — 반년 뒤 보증금을 치러야 하면
                          등록이 공격투자형이어도 지금 실질은 그렇지 않다.
                          ⚠️ **다를 때만 낸다.** 같은데도 `= 실질 …`을 적으면 매 고객 줄에
                             같은 말이 두 번 서고, 정작 다를 때의 표시가 그 사이에 묻힌다
                             (브리핑의 `평소 수준`을 걷어낸 것과 같은 판단).
                          ⚠️ 화면이 판정하지 않는다 — 값도 이유도 백엔드가 저장해 둔 것을
                             그대로 찍는다(`pb_customers.scenario`). 여기서 다시 계산하면
                             채팅 답변과 화면이 다른 말을 하게 된다. */}
                      <div className="acct">
                        {selected.acct} · {selected.age}세 ·{' '}
                        {RISK[selected.risk]}
                        {selected.scenario &&
                          selected.scenario.effective_risk !==
                            selected.scenario.registered_risk && (
                            <span
                              className="risk-eff"
                              title={
                                selected.scenario.effective_risk_why ??
                                '상황을 반영한 실질 위험성향'
                              }
                            >
                              → 실질 {RISK[selected.scenario.effective_risk]}
                            </span>
                          )}
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
                        {/* **종목 이름이 곧 그 종목의 최종본 PDF를 여는 버튼이다**
                            (2026-08-06). 예전에는 눌러서 준비 줄(공시·뉴스·노트)을 펼쳤는데,
                            상담 직전에 실제로 여는 것은 결국 노트였고 펼침은 그 앞의 한 단계였다.
                            ⚠️ **발행분이 없는 종목은 버튼을 아예 안 그린다** — 회색 버튼이나
                               빈 뷰어를 여는 대신 누를 것이 없는 상태로 둔다("못 하는 조작은
                               버튼을 그리지 않는다"와 같은 규칙).
                            ⚠️ 꺾쇠 칸도 같이 걷어냈다 — 펼칠 것이 없으면 그 기호는 거짓말이다.
                            ⚠️ 이 표에서 공시·뉴스 줄이 빠진다. 그건 브리핑 카드와 고객 문의
                               모달(PrepMemo)에 그대로 있다. */}
                        <tbody>
                          {selected.holdings.map((h) => {
                            const note = data.notes[h.code] ?? null;
                            return (
                              <tr className="hrow" key={h.code}>
                                <td>
                                  {note ? (
                                    <button
                                      type="button"
                                      className="hrow-toggle"
                                      title={`${h.name} 종목 노트 PDF 열기 (발행분)`}
                                      onClick={() =>
                                        setModal({
                                          kind: 'notepdf',
                                          id: note.id,
                                        })
                                      }
                                    >
                                      <strong>{h.name}</strong>{' '}
                                      <span style={{ color: 'var(--muted)' }}>
                                        {h.code}
                                      </span>
                                    </button>
                                  ) : (
                                    <span className="hrow-plain">
                                      <strong>{h.name}</strong>{' '}
                                      <span style={{ color: 'var(--muted)' }}>
                                        {h.code}
                                      </span>
                                    </span>
                                  )}
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
                            );
                          })}
                        </tbody>
                      </table>
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

                {/* ── 3열: Next Best Action ───────────────────────────────────
                    **답하기로 한 것은 둘이다**(2026-08-07): ① 이 고객의 상황 요약
                    (목표·제약·정리 계획) ② 상담 이력을 바탕으로 한 투자성향 점검.
                    이유는 하나다 — PB가 담당하는 고객이 많아 **각각의 경위를 기억할 수 없다.**
                    근거는 `pb_customers.scenario`·`history`이고 둘 다 코드가 만든 구조다
                    (LLM은 문장만 쓴다).

                    ⚠️ **자산배분·집중도는 이 자리에서 묻지 않는다.** 칩을 걷어냈고 안내
                    문구에서도 뺐다. 백엔드 라우트는 남아 있어 손으로 치면 답하지만,
                    **유도하지 않는 것**이 결정이다(types.ts `NBA_CHIPS`).
                    ⚠️ 근거에 **내부 계좌데이터·상담 기록**이 들어간다 — 가드레일 1의 명시적
                    예외이고 조건은 CLAUDE.md에 있다(수치는 코드가 계산 · 이름/계좌는
                    프롬프트에도 답변에도 없음 · 특정 행동을 권하지 않음).
                    ⚠️ **이름이 `Next Best Action`이어도 다음 행동을 정해 주는 자리가 아니다.**
                    고르는 일은 PB의 몫이다(가드레일 4) — 답변 규칙이 그걸 막고 있고
                    (`f1.ANSWER_SYSTEM_PROMPT`), 그 규칙을 풀면 이 패널이 회신 대필로 미끄러진다.
                    ⚠️ 입력 가드(compliance.PII_PATTERNS)는 주민·계좌번호 '숫자 형식'만
                    잡는다 — 한글 이름은 안 걸린다. 이름을 안 쓰게 만드는 건 지금도
                    이 UI의 몫이다(HANDOFF §7). */}
                {/* 크게 보기 배경 — 누르면 닫힌다. 채팅 칸보다 한 겹 아래(z-index 5/6)라
                    같은 흐름 안에서 순서만으로 위아래가 정해진다. */}
                {chatBig && (
                  <div
                    className="overlay chat-overlay"
                    onClick={() => setChatBig(false)}
                  />
                )}
                <div
                  className={chatBig ? 'cust-chat big' : 'cust-chat'}
                  ref={inlineChatRef}
                >
                  {selected ? (
                    <>
                      {/* 제목의 주어는 **사물(포트폴리오)**이지 사람(고객)이 아니다 —
                          위 ⚠️ 참조.
                          근거 줄(`.cchat-src`, "보유·배분 · 공시 · 뉴스 · 지연시세")은 뺐다 —
                          질문하기 **전에** 걸린 예고라 아직 아무것도 안 나온 화면에서
                          읽을 이유가 없었다. 실제 근거는 나온 뒤에 말한다: 문장마다 출처
                          배지가 붙고, F1 필수 고지(`compliance.CHAT_NOTICE` — 지연시세·
                          투자권유 아님·내부 계좌데이터)는 백엔드가 답변마다 강제로 붙여
                          `F1Chat`이 그린다. 규정 항목은 그쪽이지 이 줄이 아니었다.
                          ⚠️ 되살린다면 `ReviewModal`의 같은 줄도 함께 — 두 화면은 글자까지
                             같아야 한다(아래 문의 모달 주석). */}
                      {/* 크게 보기 — **제목 줄 맨 오른쪽**(2026-08-06). 한동안 대화 로그
                          오른쪽 위 모서리에 겹쳐 뒀는데(2026-08-03), 로그 상자 안에 조작이
                          떠 있으면 대화의 일부처럼 보이고 첫 답변이 오면 그 위에 겹친다.
                          이건 **이 칸 전체를 보는 방식**을 바꾸는 조작이라 칸의 제목 줄이
                          제자리다 — `↻ 새 대화`·`×`가 모달 머리말에 서는 것과 같은 규칙. */}
                      <div className="cchat-head">
                        <strong>Next Best Action</strong>
                        {/* 조작 둘을 한 상자에 모은다 — 각자 `margin-left: auto`를 달면
                            남는 자리가 둘로 갈려 사이가 벌어진다(모달 머리말 `.m-acts`와
                            같은 함정·같은 처방). */}
                        <div className="cchat-acts">
                          {/* 대화가 있을 때만 낸다(빈 화면에서 비울 것이 없다 — 모달
                              머리말의 `↻ 새 대화`와 같은 규칙). 도는 중에는 눌리지 않는다:
                              지금 끊으면 받는 중인 답을 크레딧만 쓰고 버린다. */}
                          {cardChatTurns > 0 && (
                            <button
                              type="button"
                              className="cchat-reset"
                              disabled={cardChatRunning}
                              title="이 고객과의 대화를 비웁니다. 다음 질문은 이전 종목을 이어받지 않습니다."
                              onClick={resetCardChat}
                            >
                              ↻ 새 대화
                            </button>
                          )}
                          <button
                            type="button"
                            className="cchat-zoom"
                            aria-label={
                              chatBig ? '채팅 창 줄이기' : '채팅 창 크게 보기'
                            }
                            title={
                              chatBig
                                ? '원래 크기로 (Esc)'
                                : '크게 보기 — 대시보드 위에 띄웁니다'
                            }
                            onClick={() => setChatBig((v) => !v)}
                          >
                            <span aria-hidden="true">
                              {chatBig ? '⤢' : '⤢'}
                            </span>
                          </button>
                        </div>
                      </div>
                      {/* 이 고객이 남긴 미처리 문의. 질문 칩보다 **위**에 둔다 — 무엇을
                          물어볼지 고르기 전에 "고객이 이미 무엇을 물었는지"가 먼저다.
                          ⚠️ 여기는 회신을 쓰는 자리가 아니다(가드레일 4). 원문을 그대로
                             보여줄 뿐이고, 답은 아래 질문으로 사실을 확인한 뒤 PB가 쓴다.
                          원문은 신뢰하지 않는 데이터다 — 텍스트로만 렌더하고 그 안의
                          지시문처럼 보이는 문장을 화면이 실행하는 경로를 두지 않는다.
                          주제(`q.topic`)는 내지 않는다 — 원문 바로 위에 요약된 제목이 서면
                          PB가 원문 대신 제목을 읽는다. 원문 한 줄이면 충분하고, 주제는
                          누가 붙였는지도 화면에 드러나지 않는다(데이터에는 그대로 남아
                          `ReviewModal`이 문의 종목을 찾는 데 쓴다). */}
                      {(chatsByCustomer.get(selected.id) ?? []).map((q) => (
                        <div className="cchat-ask" key={q.id}>
                          <div className="ask-head">
                            <span className="ask-meta">
                              {ago(q.updated_at)} 경과
                            </span>
                          </div>
                          <p className="ask-body">{q.question}</p>
                        </div>
                      ))}
                      {/* 칩은 **둘뿐이다**(2026-08-07 · types.ts `NBA_CHIPS`).
                          ⚠️ 보유 종목 칩(삼성전자·SK하이닉스)을 여기 되살리지 말 것 —
                             이 패널이 답하는 건 종목이 아니라 **이 사람의 사정**이다.
                             종목을 묻는 자리는 우하단 FAB(전역 F1)이고 거기는 그대로다. */}
                      <div className="cchat-chips">
                        {NBA_CHIPS.map((c) => (
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
                      {/* 고객이 바뀌면 이 컴포넌트는 갈아 끼워지고(key), 앞 고객의 대화는
                          `chatKeep`에 남아 그 고객으로 돌아오면 되살아난다(2026-08-06).
                          한동안은 되살리지 않는 것이 결정이었다 — 세션을 이어가면 다음 질문이
                          **앞 고객의 종목을 이어받아**(멀티턴 last_entity) 이 고객이 갖고
                          있지도 않은 종목을 답해 버려서다. 그 위험은 **키가 고객별**이라
                          그대로 막힌다: 보관본에는 세션 id가 같이 들어 있어, 돌아온 대화는
                          자기 세션을 이어받고 새 고객은 언제나 빈 세션에서 시작한다.
                          비우는 길은 제목 줄의 `↻ 새 대화`다(key에 붙은 nonce가 그 통로).
                          customerId는 여전히 여기서만 넘어간다 — 전역 F1(FAB)에는 고객이
                          없어 포트폴리오 라우트가 아예 안 켜진다. */}
                      <F1Chat
                        key={cardChatKey}
                        keep={chatKeep}
                        keepKey={cardChatKeep}
                        onTurnsChange={setCardChatTurns}
                        onRunningChange={setCardChatRunning}
                        compact
                        prefill={prefill}
                        customerId={selected.id}
                        customerNames={customerNames}
                        /* 미리보기는 **이 카드에만** 둔다. 여기가 고객을 살펴보는
                           화면이라 "물어보면 뭐가 나가지?"가 질문보다 먼저 오고,
                           고객 문의 모달은 이미 길다(거기서는 물어본 뒤 배지로 본다). */
                        preview={egress}
                        /* 보통/크게 — 바뀌면 미리보기 상자가 **접힌 채로** 다시 선다.
                           같은 DOM에 클래스만 바꾸는 구조라(위 주석) 열어 둔 `<details>`가
                           그대로 따라 올라오는데, 크게 보려던 것은 대화지 이 표가 아니다. */
                        viewMode={chatBig ? 'big' : 'inline'}
                        /* 담기 — AI가 낸 것 중 무엇을 상담에 가져갈지 PB가 고른다.
                           전역 F1(FAB)에는 안 넘긴다: 거기엔 고객이 없어 담을 메모도 없다. */
                        onPick={(item) => pick(selected.id, item)}
                        picked={pickedKeys}
                      />
                      {/* 상담 준비 메모 — **담은 것이 있을 때만 선다.** 빈 상자를 미리 세우면
                          "여기 뭔가 채워야 한다"가 되고, 이 기능의 요점은 채우기가 아니라
                          고르기다. 담는 순간 자리가 생기는 편이 순서에 맞는다.
                          ⚠️ 저장하지 않는다 — 새로고침하면 사라진다(위 `prep` 주석). */}
                      {(prep[selected.id] ?? []).length > 0 && (
                        <div className="prepbox">
                          <div className="prepbox-head">
                            {/* 제목이 곧 접기 버튼이다 — 이 화면의 접이식 어휘를 그대로
                                쓴다(`AI가 보는 정보`·`AI가 오늘 한 일`: 테두리·면 없이
                                **꺾쇠 + 굵은 한 줄**). 개수를 버튼 안에 두는 이유: 접었을 때
                                남는 유일한 단서가 그 숫자다.
                                ⚠️ `<details>`가 아닌 건 머리 줄에 `＋ 메모`가 같이 서기
                                   때문이다(summary 안의 버튼은 누를 때마다 상자가 여닫힌다). */}
                            <button
                              className="prep-toggle"
                              aria-expanded={listOpen}
                              title={listOpen ? '목록 접기' : '목록 펼치기'}
                              onClick={() => setListOpen((v) => !v)}
                            >
                              <strong>상담 준비 메모</strong>
                              <span className="hint">
                                {prep[selected.id].length}개
                              </span>
                            </button>
                            {/* 메모 입력창은 **부를 때만 선다**(2026-08-06). 이 상자에서
                                PB가 주로 하는 일은 담은 것을 훑고 빼는 것이고, 손으로 쓰는
                                건 가끔이다 — 늘 펼쳐 두면 목록이 볼 수 있는 높이를 입력창이
                                상시로 깎는다(목록은 140px에서 이미 안쪽 스크롤이다).
                                자리는 제목 줄이다: 상자에 무엇을 더하는 조작이라 상자 머리에
                                붙는 것이 맞고, 아래에 두면 닫혔을 때 빈 줄만 남는다. */}
                            <button
                              className="btn-quiet prep-addbtn"
                              aria-expanded={memoOpen}
                              title={
                                memoOpen
                                  ? '메모 입력 닫기'
                                  : '내가 쓴 줄을 메모에 더합니다'
                              }
                              onClick={() => {
                                setMemoOpen((v) => !v);
                                if (memoOpen) setPrepMemo('');
                              }}
                            >
                              {memoOpen ? '− 메모' : '＋ 메모'}
                            </button>
                          </div>
                          <div className="prep-items" hidden={!listOpen}>
                            {prep[selected.id].map((it, i) => {
                              const editing =
                                editAt?.cid === selected.id && editAt.i === i;
                              const save = () => {
                                const v = editText.trim();
                                if (v) editPick(selected.id, i, v);
                                setEditAt(null);
                              };
                              return (
                                <div className="prep-item" key={i}>
                                  <span className="btag">
                                    {it.kind === 'option'
                                      ? '선택지'
                                      : it.kind === 'memo'
                                        ? 'PB'
                                        : 'AI'}
                                  </span>
                                  {editing ? (
                                    <input
                                      className="waive-in"
                                      autoComplete="off"
                                      autoFocus
                                      maxLength={400}
                                      title="Enter로 저장, Esc로 취소합니다."
                                      value={editText}
                                      onChange={(e) =>
                                        setEditText(e.target.value)
                                      }
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') save();
                                        if (e.key === 'Escape') setEditAt(null);
                                      }}
                                    />
                                  ) : (
                                    <span className="prep-item-text">
                                      {it.kind === 'option'
                                        ? it.label
                                        : it.text}
                                    </span>
                                  )}
                                  {/* 고치기 — 선택지에는 안 낸다(위 `editPick` 주석).
                                    고치는 중에는 같은 자리가 `저장`이 된다: 조작 칸이
                                    늘었다 줄었다 하면 옆의 `×` 자리가 흔들린다. */}
                                  {it.kind !== 'option' &&
                                    (editing ? (
                                      <button
                                        className="btn-quiet"
                                        aria-label="고친 내용 저장"
                                        title="저장 (Esc로 취소)"
                                        onClick={save}
                                      >
                                        ✓
                                      </button>
                                    ) : (
                                      <button
                                        className="btn-quiet"
                                        aria-label="이 줄 고치기"
                                        title={
                                          it.kind === 'memo'
                                            ? '고치기'
                                            : '고치기 — 고친 줄은 PB 메모가 됩니다(AI 문장에 붙은 출처 각주가 빠집니다).'
                                        }
                                        onClick={() => {
                                          setEditAt({ cid: selected.id, i });
                                          setEditText(it.text);
                                        }}
                                      >
                                        ✎
                                      </button>
                                    ))}
                                  <button
                                    className="btn-quiet"
                                    aria-label="메모에서 빼기"
                                    title="빼기"
                                    /* 편집 중이던 줄이 있으면 닫는다 — 빼면 뒤 항목의
                                     index가 하나씩 당겨져, 열려 있던 편집 상자가
                                     **다른 줄을 고치게 된다.** */
                                    onClick={() => {
                                      setEditAt(null);
                                      unpick(selected.id, i);
                                    }}
                                  >
                                    ×
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                          {/* PB가 손으로 쓰는 줄 — 문서에서 `PB 메모` 구역으로 갈려 뜬다.
                              ⚠️ 이 줄도 게이트를 받는다(사람이 썼다고 규정을 비켜 가지 않는다). */}
                          {memoOpen && (
                            <div className="prep-add">
                              <input
                                className="waive-in"
                                autoComplete="off"
                                /* 부른 자리에 바로 쓴다 — 버튼을 누른 다음 입력창을 또 눌러야
                                 하면 조작이 둘로 나뉜다. 상자가 열릴 때만 마운트되므로
                                 `autoFocus`가 열 때마다 동작한다. */
                                autoFocus
                                placeholder="메모를 입력하세요."
                                maxLength={400}
                                value={prepMemo}
                                onChange={(e) => setPrepMemo(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' && prepMemo.trim()) {
                                    pick(selected.id, {
                                      kind: 'memo',
                                      text: prepMemo.trim(),
                                    });
                                    setPrepMemo('');
                                  }
                                  // 닫는 길을 키보드에도 둔다(＋ 버튼까지 가지 않아도 된다).
                                  if (e.key === 'Escape') {
                                    setPrepMemo('');
                                    setMemoOpen(false);
                                  }
                                }}
                              />
                              <button
                                className="btn"
                                disabled={!prepMemo.trim()}
                                onClick={() => {
                                  pick(selected.id, {
                                    kind: 'memo',
                                    text: prepMemo.trim(),
                                  });
                                  setPrepMemo('');
                                }}
                              >
                                담기
                              </button>
                            </div>
                          )}
                          {prepError && (
                            <div className="vbox">⛔ {prepError}</div>
                          )}
                          <div className="prep-acts">
                            <button
                              className="btn primary"
                              disabled={prepBusy}
                              onClick={() =>
                                void prepPdf(selected.id, prep[selected.id])
                              }
                            >
                              {prepBusy ? 'PDF 만드는 중…' : 'PDF'}
                            </button>
                          </div>
                        </div>
                      )}
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

        {/* 만들어 둔 상담 준비 메모 — **읽을 것**의 목록이고, 위 카드가 만드는 자리다
            (`발행된 노트`와 `종목 노트` 카드의 관계 그대로: 만드는 곳 다음에 다 된 것).
            ⚠️ PB 전용이다 — 준법은 고객 카드를 안 보는데 그 고객의 메모만 볼 수는 없다.
            ⚠️ **다시 정렬하지 않는다.** 서버가 최신순(id DESC)으로 주고, 고객 묶음의 순서도
               그 안에서 처음 나온 순서다(= 최근에 메모를 만든 고객이 위). */}
        {cfg.portfolio && prepCard}
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
          {/* 순서는 **만든다 → 다 된 것을 읽는다 → 처리할 것을 본다**이다. 발행분을 큐
              위에 두는 이유: 상담에 실제로 쓸 수 있는 등급은 발행분뿐이고, 큐는 아직
              쓸 수 없는 것들이다. ⚠️ 이 카드는 PB 화면 전용이다 — 준법에는 이 탭이 없다. */}
          {publishedCard}
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
            /* PDF를 싣는 모달은 둘 다 넓은 뷰어 판(`pdfmodal`)이다 — 종목 노트와 상담
               준비 메모는 문서 종류만 다르고 여는 방식이 같다. */
            className={`modal${
              modal.kind === 'notepdf' || modal.kind === 'prepdf'
                ? ' pdfmodal'
                : ''
            }`}
            role="dialog"
            aria-modal="true"
            aria-label={
              modal.kind === 'notepdf'
                ? '종목 노트'
                : modal.kind === 'prepdf'
                  ? '상담 준비 메모'
                  : '검토 화면'
            }
          >
            {/* 발행분 최종본 — **문서를 그대로 띄운다.** 상담 직전에 필요한 건 문장별 판정
                도구가 아니라 읽을 문서라, 검토 화면(NoteModal)을 열지 않는다.
                ⚠️ 여기서 다시 그리지 않고 백엔드가 만든 PDF를 그대로 싣는다 — 화면용으로
                   HTML을 따로 만들면 인쇄물과 화면이 갈린다(그게 각주 번호가 어긋나는 길이다).
                브라우저 기본 뷰어라 내려받기·인쇄는 그 툴바에 이미 있다. */}
            {modal.kind === 'notepdf' && data.notesById[modal.id] && (
              <>
                <div className="m-head">
                  <h3>
                    {data.notesById[modal.id].corp_name}(
                    {data.notesById[modal.id].stock_code}) 종목 노트
                  </h3>
                  <span className="m-id" aria-label={`노트 번호 ${modal.id}`}>
                    #{modal.id}
                  </span>
                  <span className="pill">{PILL.published[0]}</span>
                  {/* 뷰어가 없는 브라우저에서 상자가 비어 버리는 경우의 탈출구다. 급이 낮아
                      `.btn-quiet`(면도 테두리도 없는 글자)이고, 내려받기가 아니라 **여는**
                      길이다 — 저장은 뷰어 툴바가 이미 갖고 있다. */}
                  <div className="m-acts">
                    <a
                      className="btn-quiet"
                      href={notePdfUrl(modal.id, ACTOR[role], true)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      새 탭에서 열기
                    </a>
                    <button
                      className="m-close"
                      aria-label="닫기"
                      onClick={() => setModal(null)}
                    >
                      ×
                    </button>
                  </div>
                </div>
                <iframe
                  className="pdfframe"
                  src={notePdfUrl(modal.id, ACTOR[role], true)}
                  title={`${data.notesById[modal.id].corp_name} 종목 노트 PDF`}
                />
              </>
            )}
            {/* 만들어 둔 상담 준비 메모 — 노트 PDF와 **같은 판**이다(위 뷰어와 같은 이유:
                문서를 그대로 싣는다). 다른 점은 서버가 저장된 재료로 **그때 인쇄한 그대로**
                다시 그린다는 것뿐이다(오늘 잔고가 어제 문서에 들어오지 않는다). */}
            {modal.kind === 'prepdf' &&
              (() => {
                const p = data.prepNotes.find((n) => n.id === modal.id);
                // 번호를 이름 앞에 붙인다 — 목록의 묶음 제목(`#5 신태윤`)·문서 머리말과 같은
                // 형식이라, 세 자리가 같은 방식으로 고객을 가리킨다(번호는 고객 id다).
                const who = p
                  ? `#${p.customer_id} ${p.customer_name} · ${fmtDateTime(p.created_at)}`
                  : '';
                return (
                  <>
                    <div className="m-head">
                      <h3>상담 준비 메모</h3>
                      {/* 어느 고객의 언제 것인가 — 제목이 종류만 말하므로 이 줄이 건을
                          가른다(노트 모달에서 종목명이 하는 일). */}
                      {who && <span className="m-id">{who}</span>}
                      <div className="m-acts">
                        <a
                          className="btn-quiet"
                          href={prepNoteFileUrl(modal.id, ACTOR[role])}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          새 탭에서 열기
                        </a>
                        <button
                          className="m-close"
                          aria-label="닫기"
                          onClick={() => setModal(null)}
                        >
                          ×
                        </button>
                      </div>
                    </div>
                    <iframe
                      className="pdfframe"
                      src={prepNoteFileUrl(modal.id, ACTOR[role])}
                      title={`상담 준비 메모 PDF${who ? ` (${who})` : ''}`}
                    />
                  </>
                );
              })()}
            {modal.kind === 'note' && data.notesById[modal.id] && (
              <NoteModal
                key={modal.id}
                note={data.notesById[modal.id]}
                role={role}
                toast={toast}
                onClose={() => setModal(null)}
                onChanged={async () => {
                  await load();
                  return api<NoteDetail>(`/api/notes/${modal.id}`).catch(
                    () => null,
                  );
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
                    onOpenNotePdf={(id) => setModal({ kind: 'notepdf', id })}
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
