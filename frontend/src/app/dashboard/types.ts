/** 백엔드 응답 타입. 필드명은 backend/main.py의 직렬화 함수와 1:1로 맞춘다. */

/** 이 대시보드는 **PB 1인용**이다 — 'pb'가 이 화면의 주인이고, 'comp'는 같은 화면의
 *  감독 뷰가 아니라 **다른 사람(준법)이 보는 화면**을 데모용으로 미리 보는 모드다.
 *  (관리자 역할은 삭제했다 — 여러 사람이 공유하는 콘솔이라는 전제에서만 의미가 있었다.) */
export type Role = 'pb' | 'comp';

export type FlagReason = { key: string; text: string };

export type Customer = {
  id: number;
  name: string;
  age: number;
  acct: string;
  pb: string;
  /** RISK 배열의 인덱스 (0~4) — 백엔드가 정수로 준다 */
  risk: number;
  balance: number;
  ret: number;
  /** `pct_of_equity` = **보유 종목 합계 대비** 비중(잔고 대비가 아니다). 분모와 반올림은
   *  백엔드 `f1.portfolio_facts`가 단일 출처다 — 화면에서 다시 나누지 말 것. 표의 비중과
   *  포트폴리오 채팅이 말하는 비중이 갈리면 안 된다. */
  holdings: {
    code: string;
    name: string;
    amt: number;
    pct_of_equity: number | null;
  }[];
  alloc: Record<string, number>;
  flag: boolean;
  flagReasons: FlagReason[];
};

export type QueueNote = {
  type: 'note';
  id: number;
  code: string;
  title: string;
  status: string;
  /** 담당자(검토자·심의자) — 아직 아무도 안 집었으면 '미배정' */
  who: string;
  /** 생성자. 담당과 다르다 — PB는 만들 수 있지만 검토·발행은 못 한다.
   *  created_by 컬럼이 붙기 전에 만들어진 노트는 null(생성자 미상) */
  created_by: string | null;
  violations: string[];
  updated_at: string;
};

export type QueueChat = {
  type: 'chat';
  id: number;
  customer_id: number;
  topic: string;
  title: string;
  status: string;
  who: string;
  question: string;
  updated_at: string;
};

export type QueueItem = QueueNote | QueueChat;

export type NoteSource =
  | { type: 'dart'; rcept_no: string; viewer_url: string; rcept_dt: string | null }
  | { type: 'news'; url: string; title: string; pub_date: string }
  | { type: 'krx'; as_of: string; close: string; label: string }  // F1 시세 [^krx]
  /** F1 포트폴리오 [^hold] — **유일하게 공개데이터가 아닌 출처**다(내부 계좌 보유데이터).
   *  as_of가 null인 건 pb_customers에 스냅샷 시각 컬럼이 없어서다. 지어내지 않는다. */
  | { type: 'holdings'; label: string; as_of: string | null };

/** F1 대화형 Q&A — 라우팅 배지·답변 문장·고지. 백엔드 /api/chat/stream SSE와 짝. */
export type ChatRouting = {
  entity_code: string | null;
  entity_name: string | null;
  agent: 'a1' | 'a2' | 'a4' | 'krx' | 'portfolio' | null;
  intent: string | null;
  need_clarify: boolean;
  /** 되묻는 사유. 'entity'=종목을 모른다 / 'intent'=종목은 아는데 무엇을 물었는지 모른다.
   *  되물을 **문구는 백엔드가 만든다**(f1.clarify_text) — 여기서 다시 판단하면 갈라진다. */
  clarify?: 'entity' | 'intent' | null;
  inherited: boolean;  // 멀티턴: 이전 턴 종목을 이어받았는가
  reason: string;
};
export type ChatAnswer = {
  clarify: boolean;
  notice?: string;
  text?: string;  // clarify일 때만
  sentences: NoteSentence[];
  violations: string[];
};

/** 백엔드 citations.py의 문장 범주.
 *  heading=소제목 · boilerplate=고지문구·구분선 · claim=사실 주장 · interpretation=해석·전망.
 *  출처 부착률의 분모는 claim뿐이다 — 해석 문장은 규칙상 각주를 붙이지 않는다. */
export type SentenceKind = 'heading' | 'boilerplate' | 'claim' | 'interpretation';

export type NoteSentence = {
  text: string;
  /** sources의 첫 건. 옛 노트(kind 이전)는 이것만 있다 */
  source: NoteSource | null;
  /** 한 문장이 여러 건을 인용할 수 있다 — 전부 보여야 한다(가드레일 3) */
  sources?: NoteSource[];
  is_heading: boolean;
  kind?: SentenceKind;
};

export type AuditRow = {
  event_type: string;
  actor: string | null;
  ts: string;
  detail: Record<string, unknown>;
};

/** `/api/notes` — 발행분까지 포함한 노트 색인(본문 없음). 큐와 달리 "읽을 것"의 목록이다. */
export type NoteIndex = {
  id: number;
  stock_code: string;
  corp_name: string;
  status: string;
  created_by: string | null;
  updated_at: string;
};

/** 미인용 문장 확인 기록 — 준법이 심의 단계에서 사유를 골라 남긴다.
 *  index는 NoteDetail.sentences의 위치, text는 저장 시점 원문(앞 60자)이다. */
export type NoteAck = {
  index: number;
  reason: string;
  actor: string;
  ts: string;
  text: string;
};

/** 확인 사유 — 백엔드 main.py의 ACK_REASONS와 1:1. 자유 입력이 아닌 이유는 감사 대상이라서다. */
export const ACK_REASONS = ['해석·전망', '고지·면책', '데이터 설명'] as const;

/** 거절 사유 — 백엔드 main.py의 REJECT_REASONS/DISCARD_REASONS와 1:1.
 *  두 목록이 갈린 건 **뜻이 다른 거절**이라서다: 반려는 고쳐서 다시 올릴 수 있고(→ 검토중),
 *  폐기는 고쳐 쓸 게 아니다(→ 보류됨, 종결). 서버가 값을 대조하므로 여기서 늘리면 400이 난다. */
export const REJECT_REASONS = [
  '출처 불충분',
  '표현·규정 위반',
  '사실관계 재확인 필요',
] as const;
export const DISCARD_REASONS = [
  '사실관계 오류',
  '내용 부족',
  '중복·불필요',
] as const;

export type NoteDetail = {
  id: number;
  stock_code: string;
  corp_name: string;
  status: string;
  content_md: string;
  sentences: NoteSentence[];
  violations: string[];
  /** 사람이 확인해 미인용 집계에서 뺀 문장들 */
  acks: NoteAck[];
  reviewer: string | null;
  deliberator: string | null;
  publisher: string | null;
  audit_log: AuditRow[];
};

export type DashboardAudit = AuditRow & { id: number; note_id: number | null };

export type Summary = {
  /** 분모가 0이면 백엔드가 null을 준다 — 0%로 표시하면 안 된다 */
  citation_rate: number | null;
  citation_sourced: number;
  /** 분모 = 사실 주장 문장만 (해석·소제목·고지문구 제외) */
  citation_total: number;
  /** 분모에서 뺀 해석·전망 문장 수 — 감추지 않고 같이 노출한다 */
  citation_interpretation: number;
  notes_total: number;
  notes_published: number;
  notes_pending: number;
  publish_rate: number | null;
  sessions_pending: number;
  queue_pending: number;
  gate_blocks_7d: number;
  gate_blocks_daily: number[];
  customers_total: number;
  /** 오늘 에이전트가 실제로 한 일 — 훅이 남긴 감사로그 집계(없으면 전부 0). */
  today: {
    tool_calls: number;
    agents: number;
    briefs: number;
    notes: number;
    chats: number;
    last_run: string | null;
  };
};

export type AgentCalls = { agent: string; calls: number };

export type BriefItem = {
  stock_code: string;
  corp_name: string;
  quote: { close: string; change_pct: string; as_of: string } | null;
  disclosures: { report_nm: string; rcept_dt: string; viewer_url: string }[];
  news: { title: string; link: string; pub_date: string }[];
};

/** 지수(코스피·코스닥). 종목 시세와 같은 일별 종가 기준이라 "지연" 표기가 붙는다. */
export type MarketIndex = {
  index_name: string;
  close: string;
  change_pct: string;
  as_of: string;
  source: string;
};

/** 지수를 못 가져왔으면 note에 사유가 온다 — 화면은 "지수 없음"과 "미연결"을 구분해 말한다.
 *  (지수 도입 전에 만들어진 브리프는 빈 객체다.) */
export type BriefMarket = { indices?: MarketIndex[]; note?: string | null };

export type Brief = {
  id: number;
  brief_date: string;
  items: BriefItem[];
  market?: BriefMarket;
  violations: string[];
  created_at: string;
};

/** 노트 상태(백엔드) → 시안 PILL 키 */
export const PILL: Record<string, [label: string, cls: string]> = {
  draft: ['초안', ''],
  review: ['검토중', 'review'],
  deliberation: ['심의중', 'delib'],
  // 확인 대기(고객 문의)는 검토중(노트)과 다른 단계라 클래스를 따로 쓴다 —
  // 같은 'review'를 쓰던 동안 두 상태가 같은 색으로 붙어 다녔다.
  pending: ['확인 대기', 'pending'],
  published: ['발행완료', ''],
  // 상담 세션의 done은 "AI가 고객에게 보냈다"가 아니라 "PB가 이 건 처리를 끝냈다"는 뜻이다 —
  // 회신은 사람이 직접 쓴다(대상 사용자 = PB). 그래서 라벨이 `승인`류가 아니라 `처리 완료`다:
  // 이 건들이 사는 카드 이름(`처리 대기`)과 짝이 맞고, 누르면 실제로 그 목록에서 내려간다.
  done: ['처리 완료', ''],
  rejected: ['보류됨', ''],
};

export const RISK = ['안정형', '안정추구형', '위험중립형', '적극투자형', '공격투자형'];

/** 이 대시보드의 주인 (목 로그인). 백엔드 `main.PB_NAME`과 같아야 한다 —
 *  어긋나면 화면은 "내 고객"이라 적는데 서버는 다른 사람의 고객을 보낸다.
 *  사용자가 한 명뿐이라 사람 이름이 아니라 역할명을 쓴다(구분할 상대가 없다). */
export const MY_PB = 'PB';

/** 준법도 사람 이름이 아니라 역할명을 쓴다 — 1 PB · 1 준법 전제라 구분할 상대가 없다.
 *  (예전엔 '정준법'이었다. 그 이름으로 남은 과거 기록은 actorLabel로 역할로 보인다.) */
export const ACTOR: Record<Role, string> = { pb: MY_PB, comp: '준법' };

/** 감사로그·노트에 남은 actor 문자열을 화면용 역할 라벨로 정규화한다.
 *  DB 기록은 append-only라 손대지 않고(감사 이력 소급 수정 금지, HANDOFF §0-1) 화면에서만
 *  역할로 보여준다. 1 PB · 1 준법 전제라 사람 이름을 역할로 바꿔도 가리키는 대상은 같다.
 *  관리자·김애널 등 지난 체제의 기록은 매핑이 모호하고 화면 밖(최근 12건 밖)이라 원본대로 둔다. */
export function actorLabel(actor: string): string {
  if (actor === '준법' || actor === '정준법') return '준법';
  if (actor === 'PB' || actor.endsWith('PB')) return 'PB'; // PB · 박PB · 이PB · 최PB
  return actor;
}

export const WATERMARK =
  '⚠ AI 초안 · 미검증 — 사람의 검토·심의·승인 없이는 발행되지 않습니다.';
