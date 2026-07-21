/** 백엔드 응답 타입. 필드명은 backend/main.py의 직렬화 함수와 1:1로 맞춘다. */

export type Role = 'admin' | 'pb' | 'comp';

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
  holdings: { code: string; name: string; amt: number }[];
  alloc: Record<string, number>;
  diag: string;
  flag: boolean;
  flagReasons: FlagReason[];
};

export type QueueNote = {
  type: 'note';
  id: number;
  code: string;
  title: string;
  status: string;
  who: string;
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
  | { type: 'news'; url: string; title: string; pub_date: string };

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

export type NoteDetail = {
  id: number;
  stock_code: string;
  corp_name: string;
  status: string;
  content_md: string;
  sentences: NoteSentence[];
  violations: string[];
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
};

export type AgentCalls = { agent: string; calls: number };

export type BriefItem = {
  stock_code: string;
  corp_name: string;
  quote: { close: string; change_pct: string; as_of: string } | null;
  disclosures: { report_nm: string; rcept_dt: string; viewer_url: string }[];
  news: { title: string; link: string; pub_date: string }[];
};

export type Brief = {
  id: number;
  brief_date: string;
  items: BriefItem[];
  violations: string[];
  created_at: string;
};

/** 노트 상태(백엔드) → 시안 PILL 키 */
export const PILL: Record<string, [label: string, cls: string]> = {
  draft: ['초안', ''],
  review: ['검토중', 'review'],
  deliberation: ['심의중', 'delib'],
  pending: ['승인 대기', 'review'],
  published: ['발행완료', ''],
  done: ['전송완료', ''],
  rejected: ['반려됨', ''],
};

export const RISK = ['안정형', '안정추구형', '위험중립형', '적극투자형', '공격투자형'];

/** PB 역할로 전환하면 "이 사람으로 로그인한 것"으로 간주한다 (목 로그인) */
export const MY_PB = '박PB';

export const ACTOR: Record<Role, string> = { admin: '관리자', pb: MY_PB, comp: '정준법' };

export const WATERMARK =
  '⚠ AI 초안 · 미검증 — 사람의 검토·심의·승인 없이는 발행되지 않습니다.';
