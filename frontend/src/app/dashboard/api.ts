/** 백엔드 호출 + 표시용 포맷 헬퍼.
 *
 * 시안 HTML은 백엔드가 없으면 목업으로 폴백했지만, 이 화면은 백엔드와 같이 배포되므로
 * 폴백하지 않는다 — 연결이 안 되면 **가짜 데이터를 보여주는 대신 그 사실을 말한다**.
 * 목업 폴백이 필요하면 시안 파일(docs/design/pb-admin-dashboard.html)을 열면 된다.
 */

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000';

export async function api<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json() as Promise<T>;
}

export type PostResult = { ok: boolean; status: number; body: unknown };

export async function apiPost(path: string, body: unknown): Promise<PostResult> {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
}

/** `actor`는 목 로그인 사용자 — 노트의 생성자로 남아 "내가 만든 노트"를 찾을 수 있게 한다. */
export const streamUrl = (stockCode: string, actor?: string) =>
  `${BASE}/api/research/stream?stock_code=${encodeURIComponent(stockCode)}` +
  (actor ? `&actor=${encodeURIComponent(actor)}` : '');

/** customerId를 붙이면 포트폴리오 질문(집중도·배분·성향 대비)까지 답한다. 안 붙이면
 *  종목 질문만 답하는 예전 동작 그대로다(우하단 고정 버튼으로 여는 전역 F1이 그 경로).
 *  ⚠️ id를 붙인다고 아무 고객이나 열리지 않는다 — 담당이 아니면 서버가 404다. */
export const chatStreamUrl = (
  q: string,
  session?: string | null,
  customerId?: number | null,
) =>
  `${BASE}/api/chat/stream?q=${encodeURIComponent(q)}` +
  (session ? `&session=${encodeURIComponent(session)}` : '') +
  (customerId != null ? `&customer_id=${customerId}` : '');

/** FastAPI의 에러 본문에서 사람이 읽을 메시지를 꺼낸다. 게이트 차단은 violations를 준다. */
export function errorMessage(body: unknown, fallback = '처리에 실패했습니다.'): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string') return detail;
  const d = detail as { message?: string; violations?: string[] } | undefined;
  if (d?.violations?.length) return `컴플라이언스 게이트 차단: ${d.violations.join(' / ')}`;
  return d?.message ?? fallback;
}

export const fmtKRW = (v: number) =>
  v >= 1e8 ? `${(v / 1e8).toFixed(1)}억` : `${Math.round(v / 1e4).toLocaleString()}만`;

/** 등락률 표시용. KRX 원본은 "-.58"·"4.08"처럼 앞자리 0이 없거나 부호만 붙어 온다 —
 *  방향은 화살표(▲▼)와 색이 이미 말하므로 **절댓값**만 찍고 자릿수를 정규화한다.
 *  ("▼-.58%"처럼 부호가 겹쳐 보이던 것을 고친다. 값 자체는 손대지 않는다.) */
export const fmtPct = (v: string | number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.abs(n).toFixed(2) : String(v);
};

/** 등락률이 음수인가 — 표시(화살표·색)의 단일 판단 지점 */
export const isDown = (v: string | number) => Number(v) < 0;

/* 하루 경계는 브라우저 위치와 무관하게 KST 고정 — 백엔드(bizdate.py)와 같은 기준이어야
   집계·표기가 어긋나지 않는다. **프론트에서는 여기가 유일한 정의다**(page.tsx가 가져다 쓴다).
   같은 상수가 backend/bizdate.py·dart_server.py에도 있다 — 늘리지 말 것(HANDOFF §2). */
export const BIZ_TZ = 'Asia/Seoul';
export const bizDay = new Intl.DateTimeFormat('en-CA', { timeZone: BIZ_TZ }); // → YYYY-MM-DD

/** 화면의 날짜 표기는 `YYYY-MM-DD`(KST) 하나다. 들어오는 값이 세 가지라 여기서 흡수한다:
 *   - DART 접수일 `20260722` (8자리)
 *   - 이미 `2026-07-22…`인 값 (ISO 앞 10자리)
 *   - 뉴스 발행시각 `Wed, 22 Jul 2026 21:34:00 +0900` (RFC 2822, 네이버 API)
 *
 *  마지막 것을 `.slice()`로 자르면 **요일이 잘린 "Wed, 22 Ju"가 그대로 화면에 나간다** —
 *  노트 인용 배지와 F1 채팅에서 실제로 그렇게 나가고 있었다. 파싱해서 KST 날짜로 찍는다.
 *  UTC로 찍으면 안 되는 이유: KST 00~09시 뉴스가 전날로 밀린다. 브리핑이 내세우는 게
 *  하필 "밤사이 뉴스"라 그 창이 정확히 밀리는 구간이다.
 *  못 읽는 값은 지어내지 않고 원문을 그대로 돌려준다. */
export const fmtDate = (s: string | null | undefined) => {
  const v = (s ?? '').trim();
  if (!v) return '';
  const packed = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (packed) return `${packed[1]}-${packed[2]}-${packed[3]}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? v : bizDay.format(t);
};

export const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

/** 시각이 있는 사건의 "언제" — `2026-07-28 15:31`. **날짜도 KST로 찍는다.**
 *
 *  ⚠️ 여기에 `fmtDate(iso)`를 쓰면 안 된다. ISO 타임스탬프는 위 `^\d{4}-\d{2}-\d{2}` 분기에
 *     걸려 **원문 문자열을 그대로 자르는데**, 백엔드가 보내는 값이 UTC(`+00:00`)다. 시각은
 *     `hhmm`이 KST로 찍으므로 둘의 기준이 갈린다 — KST 00~09시 사건이 **날짜만 하루 전**으로
 *     나온다(실측: `2026-07-28T16:30Z` → `07-28 01:30`, 정답은 `07-29 01:30`).
 *     `fmtDate` 쪽은 그대로 둔다 — 거기 들어오는 공시일(`20260722`)·뉴스일은 시각이 없어
 *     자르는 게 맞고, 고치면 그쪽이 깨진다. 하루 경계 규칙은 HANDOFF §2. */
export const fmtDateTime = (iso: string) => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : `${bizDay.format(t)} ${hhmm(iso)}`;
};

export const ago = (iso: string) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (m < 1) return '방금';
  if (m < 60) return `${m}분`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}시간` : `${Math.round(h / 24)}일`;
};

/** 감사로그 detail(JSON)을 한 줄로. seed는 내부 필드라 감춘다. */
export const detailStr = (d: Record<string, unknown> | null | undefined): string => {
  if (!d || typeof d !== 'object') return '';
  const violations = (d as { violations?: unknown }).violations;
  if (Array.isArray(violations)) return `violations: ${violations.join(' / ')}`;
  return Object.entries(d)
    .filter(([k]) => k !== 'seed')
    .map(([k, v]) => `${k}: ${v}`)
    .join(' · ');
};
