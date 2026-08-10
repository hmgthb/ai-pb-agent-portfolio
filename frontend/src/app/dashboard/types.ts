/** 백엔드 응답 타입. 필드명은 backend/main.py의 직렬화 함수와 1:1로 맞춘다. */

/** 이 대시보드는 **PB 1인용**이다 — 'pb'가 이 화면의 주인이고, 'comp'는 같은 화면의
 *  감독 뷰가 아니라 **다른 사람(관리자)이 보는 화면**을 데모용으로 미리 보는 모드다.
 *  ⚠️ 화면 이름은 2026-08-10에 「준법」 → 「관리자」로 바뀌었지만 **id는 `comp` 그대로**다.
 *     권한 판정이 이 id에 걸려 있어(ReviewModal의 승인 버튼) 함께 바꾸면 이름 정리가
 *     권한 변경이 된다. 바꿀 거면 그 판정과 같이 볼 것. */
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
  /** 이 고객의 **상황**. 계좌 숫자가 못 보여 주는 것이 여기 있다(2026-08-07). */
  scenario?: CustomerScenario;
};

/** 고객의 상황 — 원본은 `pb_customers.scenario`, 만드는 곳은
 *  `backend/scripts/seed_scenarios.py`(난수 없음 · 다시 돌리면 같은 결과).
 *
 *  ⚠️ **AI가 쓴 것이 아니다.** 실제 배치에서는 PB가 상담 기록에서 적어 넣는 칸이라,
 *     화면에 `AI 요약` 같은 배지를 붙이지 말 것 — 붙이면 출처를 거짓으로 말하는 셈이다.
 *  ⚠️ **금액은 구간뿐이다.** 계좌 밖 자산도 `1억~5억` 같은 라벨로만 온다(원 단위 값이
 *     저장돼 있지 않다). 화면에서 구간으로부터 금액을 추정해 적지 말 것.
 *  ⚠️ 이 값은 F1 프롬프트로 **자동으로 나가지 않는다** — 경계가 화이트리스트라
 *     (`backend/redact.SANITIZED_KEYS`) 넣는 것이 명시적 결정이어야 한다. */
export type CustomerScenario = {
  /** 원형 키(`multi_home`·`retire_income`…). 화면 분기용이 아니라 **같은 상황끼리 묶어 볼 때** 쓴다. */
  key: string;
  /** 한 줄 요약 — 카드가 접혀 있을 때 보이는 것. 규칙이 조립한다. */
  summary: string;
  goal: string;
  /** 자금이 필요한 시점(`1~2년`·`상시`). 실질 성향이 등록 성향과 갈리는 주된 이유다. */
  horizon: string;
  /** 계좌 **밖** 자산. 증권 잔고(`balance`)는 여기 안 들어간다 — 두 번 세게 된다. */
  assets: { kind: string; band?: string; where?: string; note?: string }[];
  constraints: string[];
  plan: string[];
  /** 둘 다 `RISK` 배열의 인덱스라 **같은 축에서 견줄 수 있다**. 다르면 그 간극이
   *  상담에서 가장 먼저 확인할 것이고, 그때만 `effective_risk_why`가 온다. */
  registered_risk: number;
  effective_risk: number;
  effective_risk_why: string | null;
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

/** 비식별화 경계 보고 — **무엇이 가려진 채 외부 모델로 나갔는가**.
 *  백엔드 `redact.redact_portfolio`의 report + 실제 전송된 payload.
 *  ⚠️ `removed`에는 항목 **이름**만 온다(원본 값은 안 온다) — 이 이벤트 자체가 SSE로
 *     화면까지 오므로, 여기에 실금액을 실으면 가린 의미가 없다. */
/** 경계를 넘어 외부 모델로 나가는 포트폴리오. 백엔드 `redact.SANITIZED_KEYS`와 **1:1**이다.
 *  ⚠️ 계약은 백엔드 화이트리스트다 — 키를 늘리면 두 곳을 같이 고친다(안 고치면 반출 가드가
 *     "허용 목록에 없는 항목"으로 차단한다).
 *  실금액(`balance`·`holdings[].amt`)이 **여기 없는 것이 요점**이다. */
export type EgressPortfolio = {
  /** 이름 자리에 서는 **가명**(`고객 #1`). ⚠️ 익명이 아니다 — 원본 DB와 대조하면 사람이
   *  특정된다. 여기서 얻는 건 "모델이 이름을 못 본다"이지 "누구인지 알 수 없다"가 아니다. */
  customer_ref: string | null;
  /** 실나이가 아니라 나이대(`30대`). 일반화이지 삭제가 아니다 — 성향 대비 구성을 읽을 때
   *  맥락이 된다. ⚠️ 폭을 좁히면(5년 단위 등) 재식별이 쉬워진다. */
  age_band: string | null;
  risk_label: string | null;
  /** 실금액이 아니라 구간(`10억~50억`). 구간 폭이 곧 방어선이다(HANDOFF §0-1). */
  balance_band: string | null;
  return_pct: number | null;
  alloc: { class: string; pct: number }[];
  holdings: {
    code: string;
    name: string;
    pct_of_equity: number | null;
    pct_of_balance: number | null;
  }[];
  flags: FlagReason[];
  /** 고객 상황·상담 이력(2026-08-07). **`AI가 보는 정보` 패널이 이것도 그려야 한다** —
   *  실제로 나가는데 화면이 안 보여 주면 그 패널이 나가는 양을 축소해 말하는 셈이다.
   *  ⚠️ 성향은 라벨로 온다(정수 인덱스가 아니다 · `redact.redact_scenario`).
   *  ⚠️ 계좌 밖 자산은 **구간뿐**이다 — 구간에서 금액을 역산해 그리지 말 것. */
  scenario?: {
    summary?: string;
    goal?: string;
    horizon?: string;
    assets?: { kind: string; band?: string; where?: string; note?: string }[];
    constraints?: string[];
    plan?: string[];
    registered_risk_label?: string;
    effective_risk_label?: string;
    effective_risk_why?: string;
  };
  history?: { at: string; kind: string; detail: string }[];
};

export type ChatRedaction = {
  /** rule = 규칙(순수 코드). 실제 배치에서는 이 자리가 망분리된 내부 GPU다. */
  mode: 'rule' | 'llm';
  /** ⚠️ `kind`로 두 가지를 갈라 센다: `mask`=민감해서 가린 것(실금액) · `drop`=사본이라
   *  지운 것. 배지 숫자는 **mask만** 센다 — 섞으면 "5개나 가렸다"가 사실이 아니게 된다.
   *  ⚠️ 화면은 이 목록을 **불릿으로 늘어놓지 않는다** — 무엇이 가려졌는지는 고객 상세와
   *     같은 형식으로 그린 표(`EgressTwin`)가 제자리에서 말한다. 여기 남은 쓸모는 개수뿐이다. */
  removed: { label: string; how: string; kind: 'mask' | 'drop' }[];
  payload: EgressPortfolio;
};

/** F1 대화형 Q&A — 라우팅 배지·답변 문장·고지. 백엔드 /api/chat/stream SSE와 짝. */
export type ChatRouting = {
  entity_code: string | null;
  entity_name: string | null;
  /** ⚠️ 화면에서 이 값으로 **이름표를 찾지 말 것** — 그러다 라우트가 늘 때마다 빠졌다.
   *  배지에 적을 말은 아래 `label`로 온다. 이 필드는 라우트 자체를 가리키는 식별자다. */
  agent:
    | 'a1' | 'a2' | 'a4' | 'krx'
    | 'portfolio' | 'portfolio_advice'
    | 'situation' | 'risk_review'
    | null;
  intent: string | null;
  /** 라우팅 배지에 적는 이름 — **백엔드가 정한다**(`f1.ROUTE_LABEL`). 되묻기이거나 표에
   *  없는 라우트면 null이고, 그때 화면은 배지를 **아예 안 그린다**(F1Chat 같은 자리 주석). */
  label: string | null;
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

/** 조정 선택지 후보 — 백엔드 `f1.rebalance_options`가 규칙으로 뽑은 것.
 *  ⚠️ 화면에서 후보를 만들거나 고르지 않는다. 여기 있는 것만 PB가 **담을 수 있다**. */
export type ChatOption = {
  kind: string;
  label: string;
  targets: { code: string; name: string }[];
  /** 근거 한 줄과 그 출처 태그(`hold`=보유데이터 · `krx`=지연시세 · `none`=이 저장소의 분류) */
  basis: { text: string; src: string }[];
  /** 이 선택지가 바꾸지 않는 것 — 트레이드오프의 사실 부분이라 코드가 적는다. */
  keeps: string;
};

/** 상담 준비 메모에 담은 항목. **저장하지 않는다** — 화면이 들고 있다가 PDF를 받을 때만
 *  서버로 간다(2026-08-06 결정). 백엔드 `main.PrepItem`과 1:1.
 *
 *  셋으로 나뉘는 이유는 **누가 만든 문장인가**가 문서에서 갈려 읽혀야 해서다:
 *    sentence = AI가 쓴 답변 문장(출처 배지째 간다) · option = 코드가 뽑은 선택지 ·
 *    memo = PB가 손으로 쓴 줄(문서에서 `PB 메모` 구역으로 갈려 뜬다). */
export type PrepItem =
  | { kind: 'sentence'; text: string; sentence_kind?: SentenceKind; sources: NoteSource[] }
  | {
      kind: 'option';
      label: string;
      targets: string[];
      basis: { text: string; src: string }[];
      keeps: string;
    }
  | { kind: 'memo'; text: string };

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
  /** 이 문장의 **키워드** — 붙어 있으면 화면은 문장을 접고 이것만 낸다(꺾쇠로 편다).
   *  `Next Best Action` 패널의 F1 답변에만 온다(`f1.split_labeled`).
   *
   *  ⚠️ 갈래 이름이 아니라 **문장에서 그대로 떼어 온 조각**이다(`은퇴`,
   *     `월 생활비를 배당·이자`). 백엔드가 **부분문자열로 대조해** 통과시킨 것이라,
   *     여기 있는 말은 반드시 `text` 안에도 있다 — 화면에서 다듬거나 이어 붙이지 말 것.
   *  ⚠️ **숫자가 들어 있지 않다는 것도 백엔드의 보장이다**(`f1.valid_label`). 접힌 동안
   *     화면에 보이는 건 이것뿐이라, 수치가 여기 있으면 근거 없이 뜨는 사실 주장이
   *     된다(가드레일 3).
   *  ⚠️ 없을 수 있다(형식이 깨진 줄·전역 F1). 그때는 **접지 말고 그냥 문장으로** 낸다. */
  labels?: string[] | null;
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

/** 지금까지 만든 **상담 준비 메모** 한 건(`GET /api/prep-notes`, 최신순).
 *  본문은 없다 — 목록은 줄 하나만 그리고, 내용은 PDF를 열 때 서버가 읽는다.
 *  ⚠️ `customer_name`은 서버가 준다(화면이 고객 표에서 다시 찾지 않는다) — 그래야 이 목록이
 *     고객 목록의 필터·정렬과 무관하게 자기 줄을 설명한다. */
export type PrepNoteIndex = {
  id: number;
  customer_id: number;
  customer_name: string;
  /** 담긴 항목 수(문장·선택지·PB 메모의 합). */
  items: number;
  created_by: string | null;
  created_at: string;
};

/** 미인용 문장 확인 기록 — 관리자가 심의 단계에서 사유를 골라 남긴다.
 *  index는 NoteDetail.sentences의 위치, text는 저장 시점 원문(앞 60자)이다. */
export type NoteAck = {
  index: number;
  reason: string;
  actor: string;
  ts: string;
  text: string;
};

/** 금지 표현 예외 — 관리자가 사유를 적어 그 문장의 투자권유·광고성 표현 위반을 통과시킨 기록.
 *  ⚠️ `reason`이 **이 앱에서 유일한 자유 입력 사유**다(반려·보류·확인은 고정값).
 *     통과의 근거가 건마다 달라서인데, 그 대신 사유별 집계는 포기했다(백엔드 WAIVER_MAX_LEN). */
export type NoteWaiver = {
  index: number;
  /** 무엇을 통과시켰는가 — 사유만큼 중요하다(금지 목록이 늘어나도 기록이 남는다). */
  phrase: string;
  reason: string;
  actor: string;
  ts: string;
  text: string;
};

/** 확인 사유 — 백엔드 main.py의 ACK_REASONS와 1:1. 자유 입력이 아닌 이유는 감사 대상이라서다. */
export const ACK_REASONS = [
  '해석·전망',
  '고지·면책',
  '데이터 설명',
  '제거',
] as const;

/** 셀렉트·배지에 뜨는 말. 앞의 셋은 "무엇으로 보고 이대로 통과시켰나"라 `~으로 확인`이
 *  붙지만, `제거`는 통과가 아니라 **최종본에서 뺀다**는 판단이라 그 말이 뜻을 뒤집는다.
 *  ⚠️ 값은 그대로 `제거`로 저장된다 — 라벨만 여기서 갈린다(감사로그·백엔드 대조 대상). */
export function ackReasonLabel(reason: string): string {
  return reason === '제거' ? '제거' : `${reason}으로 확인`;
}
/** 문장에 붙는 배지. `제거`만 **`PB 제거`와 짝이 되는 말**로 적는다(`관리자 제거`) —
 *  같은 판단을 누가 했는지가 배지에서 바로 갈려 읽혀야 한다. 나머지는 확인 사유를 단다. */
export function ackBadgeLabel(reason: string): string {
  return reason === '제거' ? '관리자 제거' : `확인함 · ${reason}`;
}

/** PB가 각주 없는 문장(UNSOURCED·해석)에 남기는 판정 — 백엔드 main.py의 PB_MARKS와 1:1.
 *  ⚠️ **게이트를 열지 않는다.** 미인용 문장을 발행 가능하게 만드는 건 관리자의 확인(ack)뿐이고,
 *     이건 그 전 단계에서 PB가 훑은 흔적이다. `remove`도 문장을 실제로 지우지 않는다 —
 *     본문은 그대로 두고 표시만 남긴다(무엇을 빼기로 했는지도 감사 대상이다). */
export type PbMark = 'remove' | 'approve';
export const PB_MARK_LABEL: Record<PbMark, string> = {
  remove: 'PB 제거',
  approve: 'PB 승인',
};
/** ack와 같은 모양이되 reason 자리에 mark가 온다. index·text의 뜻도 같다(재파싱 대조용). */
export type NoteMark = {
  index: number;
  mark: PbMark;
  actor: string;
  ts: string;
  text: string;
};

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
  /** 관리자가 확인해 미인용 집계에서 뺀 문장들 */
  acks: NoteAck[];
  /** PB가 제거·승인으로 판정한 문장들. acks와 달리 집계·게이트에는 영향이 없다.
   *  (이 필드가 붙기 전에 받은 응답은 없다 — 백엔드가 항상 배열을 준다.) */
  marks: NoteMark[];
  /** 관리자가 **사유를 직접 적어** 통과시킨 금지 표현(2026-08-06). ack과 컬럼이 다른 이유는
   *  여는 규칙이 달라서다 — ack은 미인용, 이건 투자권유·광고성 표현 하나뿐. */
  waivers: NoteWaiver[];
  /** 금지 표현을 담은 문장 — **백엔드가 찾아 준다.** ⚠️ 금지 표현 목록을 이 파일로
   *  복사하지 말 것: 컴플라이언스 어휘가 두 곳으로 갈린다(`compliance.FORBIDDEN_PHRASES`). */
  blocking_phrases: { index: number; phrase: string }[];
  reviewer: string | null;
  deliberator: string | null;
  publisher: string | null;
  /** 마지막 상태 변화 시각(ISO). 상담 준비의 노트 줄이 상태 옆에 날짜를 적는다 —
   *  발행분이 우선이라 옛 발행분과 오늘 만든 초안이 같은 자리에 설 수 있다. */
  updated_at: string;
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

/** 브리프의 종목 한 건.
 *
 *  ⚠️ **새 브리프에는 오지 않는다**(2026-08-07 · `items`는 항상 빈 배열이다). 브리핑이
 *     거시 전용이 되면서 종목·고객이 통째로 빠졌다 — 백엔드 `brief.py`의 「배선 해제」 구역.
 *     타입을 남긴 이유는 **옛 브리프가 DB에 그대로 있어서**다(`/api/briefs/latest`는 저장된
 *     것을 그대로 준다). 지우면 그 행들을 읽는 코드가 타입 없이 남는다. */
export type BriefItem = {
  stock_code: string;
  corp_name: string;
  quote: {
    close: string;
    change_pct: string;
    as_of: string;
    /* ⚠️ `recent_text`(`20거래일 중 가장 큰 하락`)는 **화면이 더는 쓰지 않는다**(2026-08-06 —
       시세 줄에서 걷어냈다). 백엔드는 계속 보내고 브리프 기록에도 남아 있으므로, 되살릴 때는
       `brief.recent_move_text`가 만든 **완성된 문구를 그대로** 찍을 것: 판정(`quote.recent`)을
       화면에서 문장으로 조립하면 브리프 본문과 다른 말을 하게 된다. */
  } | null;
  disclosures: {
    report_nm: string;
    rcept_dt: string;
    viewer_url: string;
    /** 백엔드(`brief.IMPORTANCE`)가 정한 등급. **화면에 글자로 뜨지 않는다** — 태그는 그대로
     *  `공시` 하나이고, 이 값이 하는 일은 임원·주요주주 보고를 접힌 한 줄로 모으는 것뿐이다.
     *  ⚠️ `insider` = 임원·주요주주 **개인의 소액 매매 신고**(매일 수십 건)만이다.
     *     5%룰(`주식등의대량보유상황보고서`)은 이름만 비슷하고 `major`다 — 접히지 않는다.
     *  ⚠️ 프론트에서 보고서명으로 등급을 다시 판정하지 말 것 — 규칙이 두 벌이 되어 갈린다.
     *  옛 브리프(2026-08-06 이전 생성)에는 이 필드가 없다 → `other`로 본다(다시 생성하면 붙는다). */
    importance?: 'major' | 'periodic' | 'other' | 'insider';
    /** 어제 브리프에 없던 것인가. 화면은 `false`인 줄의 **톤을 낮춘다**(지우지 않는다 —
     *  어제 것도 오늘 상담에서 쓰인다).
     *  ⚠️ **없을 수 있고, 없는 것과 `false`는 다르다.** 비교할 어제 브리프가 없으면 필드
     *     자체가 붙지 않는다 — 그때는 새것/구것을 구분하지 않는 게 맞다(`is_new === false`로
     *     좁혀 판정할 것. falsy로 보면 첫 브리프가 통째로 흐려진다). */
    is_new?: boolean;
  }[];
  news: { title: string; link: string; pub_date: string; is_new?: boolean }[];
};

/** 거시 지표 한 건 — **지수·환율·금리가 같은 모양을 쓴다**(2026-08-07).
 *
 *  공급자가 둘이다(2026-08-09): 나스닥·S&P500·미국채30년은 FRED(`backend/fred.py`),
 *  원/달러·국고채10년은 한국은행 ECOS(`backend/ecos.py`). 화면이 지표마다 다른 키를 보지
 *  않도록 "오늘 얼마나 움직였나"는 `move` + `move_unit` 하나로 읽는다.
 *  (KRX 지수 경로 `backend/market.py`는 남아 있지만 이 띠에는 더 이상 들어오지 않는다 —
 *   에이전트 도구 `krx_index`가 쓴다. 옛 브리프에는 코스피·코스닥이 그대로 저장돼 있다.)
 *  ⚠️ 타입 이름은 `MarketIndex` 그대로다 — 저장된 브리프의 필드명(`market.indices`)이
 *     그것이라, 이름만 바꾸면 옛 브리프를 읽는 코드와 어긋난다. */
export type MarketIndex = {
  index_name: string;
  close: string;
  /** 수준에 붙는 단위(`""`·`"%"`). 환율은 이름이 이미 원화 표시라 비어 있다. */
  level_unit?: string;
  /** 오늘 움직임. 부호를 포함하고 **자릿수는 백엔드가 이미 정했다** — 화면은 부호만 떼고
   *  찍는다(`fmtMove`). ⚠️ 2026-08-07 이전 브리프에는 없다 → `change_pct`로 폴백. */
  move?: string;
  /** `"%"`(지수·환율) 또는 `"bp"`(금리). 금리를 %로 적으면 -1.95%가 되는데 채권에서
   *  그렇게 말하지 않는다(-7.3bp다). */
  move_unit?: '%' | 'bp';
  /** `"지연시세"`(지수 종가) 또는 `"공표"`(한국은행). 화면·본문 문구가 이 값으로 갈린다 —
   *  환율에 "지연"이라고 쓰면 틀린 말이다. ⚠️ 옛 브리프에는 없다(전부 지수였다). */
  basis?: '지연시세' | '공표';
  /** KRX 원본 등락률. **파생값(`move`)이 원본을 덮지 않게** 그대로 남긴다.
   *  ECOS 지표에는 없다 — 읽을 때는 `move`를 먼저 본다. */
  change_pct?: string;
  as_of: string;
  source: string;
  /** 오늘 등락이 창 안에서 몇 번째 움직임인가(`market.rank_recent_move`).
   *  `rank`가 null이면 평소 수준이고, 값 자체가 없으면 창이 짧아 판단하지 않은 것이다.
   *  ⚠️ **화면이 이 값으로 문장을 만들지 말 것.** 문구는 백엔드가 완성해 `notable` 불릿으로
   *     보낸다(`brief._notable_bullets`) — 여기서 조립하면 카드와 저장된 브리프가 다른
   *     말로 같은 사실을 적는다. 이 필드는 판정 원본을 남겨 두는 자리다.
   *  ⚠️ 2026-08-07 이전 브리프에는 없다. */
  recent?: { of: number; direction: 'up' | 'down'; rank: number | null } | null;
};

/** 지수를 못 가져왔으면 note에 사유가 온다 — 화면은 "지수 없음"과 "미연결"을 구분해 말한다.
 *  (지수 도입 전에 만들어진 브리프는 빈 객체다.) */
export type BriefMarket = { indices?: MarketIndex[]; note?: string | null };

/** 요약 불릿 한 줄 — 지수 띠 **아래**에 몇 개가 선다.
 *
 *  **문장은 백엔드(`brief.macro_digest`)가 완성해서 보낸다.** LLM은 이 경로에 없고, 화면도
 *  조립하지 않는다 — 여기서 문장을 만들면 저장된 브리프와 화면이 다른 말을 하게 된다.
 *  ⚠️ 이 값은 본문(`content_md`·`sentences`)에 없다 — 같은 사실을 두 번 세면 출처 부착률의
 *     분모가 흔들린다(`brief.assemble` 주석).
 *  ⚠️ **불릿당 한 문장이고, 없는 항목은 오지 않는다.** 0건을 나열하지 않는 것이 규칙이라
 *     `kind`로 자리를 비워 두거나 빈 문구를 채우지 말 것. 예외는 `delta` 하나 —
 *     거기서는 "어제 이후 방향이 바뀐 지표가 없다"가 그 자체로 답이다.
 *  ⚠️ **같은 `kind`가 여러 줄일 수 있다**(`notable`·`news`). 특히 `news`는 밤사이 사건
 *     수만큼 서므로(백엔드 `brief.cluster_headlines`, 최대 3줄) 하나로 가정하지 말 것 —
 *     각주(`sources`)가 **줄마다 다르다**는 것이 이 구조의 요점이다. */
export type BriefBullet = {
  /** delta=어제 대비 방향 전환 · notable=오늘 움직임이 평소와 다름 ·
   *  news=밤사이 시장 헤드라인(**LLM이 쓴 유일한 줄** — `ai`·`sources`가 붙는다) ·
   *  caution=유의사항(조회 실패 · 견주지 못한 이유).
   *  ⚠️ `stock`은 **옛 브리프에만 있다**(2026-08-07 이전). 새로 생기지 않지만, 남아 있는
   *     행이 화면에서 클래스 없이 찍히지 않도록 유니온에 남겨 둔다.
   *  ⚠️ 그전에 걷어낸 것 셋(2026-08-06): `lead`·`quiet`는 종목 줄과 같은 말을 했고,
   *     `market`(시장 대비)은 어느 지수와 견줄지를 종목의 시장으로 고르지 않았다. */
  kind: 'delta' | 'notable' | 'news' | 'caution' | 'stock';
  text: string;
  /** 공시 뷰어 링크. 시세 기반 불릿에는 열어 볼 원문이 없어 null(링크를 지어내지 않는다). */
  href: string | null;
  /** **밑줄이 걸리는 구간** — `text` 안에 그대로, 한 번만 나타난다.
   *  ⚠️ 거시 불릿은 이 값을 쓰지 않는다(항상 null) — 열어 볼 원문이 없다.
   *  ⚠️ `text` 안에서 못 찾으면 **링크 없이 문장 전체를 그대로 찍는다** — 문장을 자르거나
   *     버리지 않는다(`page.tsx`의 `DigestText`). */
  link_text?: string | null;
  /** 이 문장을 **LLM이 썼는가**. 화면이 그렇게 표시한다(`AI 요약`).
   *  ⚠️ 켜지는 건 `news`(밤사이 헤드라인) 하나뿐이다 — 나머지는 규칙이 쓴다.
   *  ⚠️ 표시를 빼지 말 것 — 이 불릿은 게이트를 안 타므로(본문이 아니라 `lead_json`),
   *     "규칙이 만든 문장"과 구분되는 자리가 화면의 이 배지뿐이다. */
  ai?: boolean;
  /** 이 문장의 **근거 기사**. `news` 불릿에만 붙는다.
   *  ⚠️ `href`(단일 링크)를 쓰지 않는 이유: 이 문장은 여러 제목을 뭉친 것이라 한 링크가
   *     대표하지 못한다. 화면은 각주 번호로 전부 건다.
   *  ⚠️ **빼지 말 것.** 종목 카드가 없어지면서 이 문장의 출처를 확인할 자리가 여기뿐이다
   *     (가드레일 3 — 출처 100% 노출). */
  sources?: { title: string; url: string; pub_date: string }[];
};

/** (2026-08-06 이전 브리프는 빈 객체 — 화면은 그때 아무것도 그리지 않는다.) */
export type BriefLeadPayload = { bullets?: BriefBullet[] };

export type Brief = {
  id: number;
  brief_date: string;
  /** ⚠️ 새 브리프에서는 **항상 빈 배열**이다(BriefItem 주석). 옛 브리프에만 값이 있다. */
  items: BriefItem[];
  market?: BriefMarket;
  lead?: BriefLeadPayload;
  violations: string[];
  created_at: string;
};

/** 노트 상태(백엔드) → 시안 PILL 키 */
export const PILL: Record<string, [label: string, cls: string]> = {
  // 초안 단계는 없앴다(2026-08-03) — 노트는 검토중으로 만들어진다(backend db.py SCHEMA).
  // 표는 남긴다: 새로 생기지는 않지만, 남아 있는 값이 화면에 'draft'로 찍히면 안 된다.
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

/** 관리자도 사람 이름이 아니라 역할명을 쓴다 — 1 PB · 1 관리자 전제라 구분할 상대가 없다.
 *  ⚠️ 2026-08-10에 `'준법'` → `'관리자'`로 바꿨다(화면의 역할 이름과 같은 값이어야 한다).
 *     **이미 쌓인 기록은 손대지 않는다** — 감사로그는 append-only라 소급 수정하지 않고
 *     (HANDOFF §0-1), 옛 `'준법'`은 아래 `actorLabel`이 화면에서만 지금 이름으로 옮긴다. */
export const ACTOR: Record<Role, string> = { pb: MY_PB, comp: '관리자' };

/** 감사로그·노트에 남은 actor 문자열을 화면용 역할 라벨로 정규화한다.
 *  DB 기록은 append-only라 손대지 않고(감사 이력 소급 수정 금지, HANDOFF §0-1) 화면에서만
 *  역할로 보여준다. 1 PB · 1 관리자 전제라 사람 이름을 역할로 바꿔도 가리키는 대상은 같다.
 *  ⚠️ `'준법'`은 **같은 자리의 옛 이름**이라 지금 이름으로 옮긴다(2026-08-10 개명) — 원본대로
 *     두면 한 화면에 `준법`과 `관리자`가 같이 떠서 두 사람이 한 것처럼 읽힌다.
 *  김애널 등 지난 체제의 기록은 매핑이 모호하고 화면 밖(최근 12건 밖)이라 원본대로 둔다. */
export function actorLabel(actor: string): string {
  if (actor === '관리자' || actor === '준법' || actor === '정준법') return '관리자';
  if (actor === 'PB' || actor.endsWith('PB')) return 'PB'; // PB · 박PB · 이PB · 최PB
  return actor;
}

export const WATERMARK =
  '⚠ AI 초안 · 미검증 — 사람의 검토·심의·승인 없이는 발행되지 않습니다.';

/** `Next Best Action` 칩 — 이 채팅이 답하는 둘(2026-08-07).
 *
 *  **왜 둘뿐인가.** PB가 담당하는 고객이 많아 각각의 경위를 기억할 수 없다는 것이 이 패널이
 *  있는 이유다. 그래서 묻는 것은 계좌 구성이 아니라 **이 사람의 사정**이다: 지금 어떤 상황인가,
 *  등록 성향과 지금 실질이 왜 갈리는가.
 *
 *  ⚠️ **걷어낸 것들**(2026-08-07): 보유 종목 칩(삼성전자·SK하이닉스)과 구성 칩(집중도·자산배분·
 *     성향 대비·조정 선택지·최근 흐름). 이 자리에서 자산배분을 묻지 않기로 했다.
 *     백엔드 라우트(`f1._PORTFOLIO_KEYWORDS`·`_ADVICE_KEYWORDS`)는 **지우지 않고 남겨 뒀다** —
 *     손으로 치면 여전히 답한다. 없앤 것은 그쪽으로 **유도하는 버튼**이다.
 *  ⚠️ 각 질문문은 **백엔드 라우팅 키워드를 반드시 포함해야 한다**
 *     (`f1._SITUATION_KEYWORDS`·`_RISK_KEYWORDS`). 칩이 채운 질문이 그 라우트로 안 가면
 *     종목을 되묻는 clarify로 떨어져, 누른 사람에겐 버튼이 고장 난 것처럼 보인다.
 *     라벨이 아니라 **q가 계약**이다 — 라벨만 고치는 건 안전하고, q는 키워드를 지켜야 한다.
 *
 *  page.tsx(고객 카드)와 ReviewModal.tsx(고객 문의 모달)가 **같은 칩을 쓴다** — 두 곳의
 *  인라인 채팅이 같은 라우트를 태우므로 목록도 한 곳에서만 정의한다. */
export const NBA_CHIPS: { label: string; q: string }[] = [
  { label: '상황 요약', q: '이 고객 상황 요약해줘' },
  { label: '성향 점검', q: '히스토리 기반으로 투자성향 분석해줘' },
];
