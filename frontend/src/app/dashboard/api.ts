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

export const streamUrl = (stockCode: string) =>
  `${BASE}/api/research/stream?stock_code=${encodeURIComponent(stockCode)}`;

export const chatStreamUrl = (q: string, session?: string | null) =>
  `${BASE}/api/chat/stream?q=${encodeURIComponent(q)}` +
  (session ? `&session=${encodeURIComponent(session)}` : '');

/** FastAPI의 에러 본문에서 사람이 읽을 메시지를 꺼낸다. 게이트 차단은 violations를 준다. */
export function errorMessage(body: unknown, fallback = '처리에 실패했습니다.'): string {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string') return detail;
  const d = detail as { message?: string; violations?: string[] } | undefined;
  if (d?.violations?.length) return `컴플라이언스 게이트 차단 — ${d.violations.join(' / ')}`;
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

/** "20260713" → "2026-07-13" (이미 하이픈이 있으면 그대로) */
export const fmtDate = (s: string | null | undefined) =>
  (s ?? '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');

export const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

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
