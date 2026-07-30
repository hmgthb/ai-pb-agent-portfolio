/** 전역 F1 모달 검증 — 대화 유지 · 닫기(×) · 새 대화 · 실행 표시등. 크레딧 0.
 *
 *  `/api/chat/stream`만 가로채 SSE를 재생한다(나머지 API는 실백엔드) — `scenario_check.mjs`와
 *  같은 방식이다.
 *
 *  ⚠️ 이 검사가 지키는 것은 **모달이 닫혀도 언마운트되지 않는다**는 성질이다. 언마운트로
 *     되돌아가면 화면은 멀쩡해 보이고(열면 빈 대화가 정상처럼 보인다) 잃는 것만 조용하다:
 *     대화가 사라지고, 답변이 오는 중이었으면 크레딧만 쓰고 버린다.
 *
 *  실행: cd frontend && node f1_modal_check.mjs   (백엔드 8000 · 프론트 3000)
 */
import { chromium } from 'playwright';

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const answerBody = (sid, text) =>
  sse('session', { session: sid }) +
  sse('routing', {
    entity_code: '005930',
    entity_name: '삼성전자',
    agent: 'a2',
    intent: 'earnings',
    need_clarify: false,
    inherited: false,
    reason: 'code+intent',
  }) +
  sse('answer_token', { text }) +
  sse('answer', {
    clarify: false,
    notice: 'ℹ 시세·주가는 지연시세(일별 종가) 기준이며, 본 답변은 투자권유가 아닙니다.',
    sentences: [
      {
        text,
        source: { type: 'dart', rcept_no: '20260722000123', viewer_url: 'https://dart.fss.or.kr/x', rcept_dt: '20260722' },
        is_heading: false,
        kind: 'claim',
      },
    ],
    violations: [],
  }) +
  sse('done', {});

const A1 = '2025년 별도 기준 매출액은 10.7조원이다.';
const A2 = '같은 기간 영업이익은 1.2조원이다.';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

let turn = 0;
let holdMs = 0;
const seenSessions = [];
await page.route('**/api/chat/stream*', async (route) => {
  const url = new URL(route.request().url());
  seenSessions.push(url.searchParams.get('session'));
  if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
  turn += 1;
  route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: answerBody('sid-fixed', turn === 1 ? A1 : A2),
  });
});

await page.goto('http://localhost:3000/dashboard', { waitUntil: 'networkidle' });

const fail = [];
const check = (ok, label) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) fail.push(label);
};

const modal = page.locator('.overlay:not([hidden]) .modal');

// ── 1. FAB로 열고 한 턴 보낸다
await page.click('button.fab');
await check(await modal.isVisible(), '모달이 열린다');
await check(
  await modal.locator('button.m-close').isVisible(),
  '머리말 오른쪽에 닫기(×)가 있다',
);
await check(
  (await modal.locator('button:has-text("새 대화")').count()) === 0,
  '대화가 없으면 `새 대화`를 내지 않는다',
);

await modal.locator('input.search').fill('삼성전자 최근 실적');
await modal.locator('button:has-text("보내기")').click();
await page.waitForSelector('.chat-answer', { timeout: 10000 });
await check((await modal.innerText()).includes(A1), '답변이 화면에 온다');
await check(
  await modal.locator('button:has-text("새 대화")').isVisible(),
  '대화가 생기면 `새 대화`가 나온다',
);
await modal.screenshot({ path: '/tmp/f1-1-answered.png' });

// ── 2. ×로 닫고 다시 열면 대화가 남아 있다
await modal.locator('button.m-close').click();
await check(
  (await page.locator('.overlay:not([hidden])').count()) === 0,
  '×를 누르면 닫힌다',
);
await page.click('button.fab');
await check(
  (await modal.innerText()).includes(A1),
  '다시 열면 대화가 남아 있다 (언마운트되지 않는다)',
);

// ── 3. 두 번째 턴이 같은 세션 id로 나간다 (멀티턴이 이어진다)
await modal.locator('input.search').fill('영업이익은?');
await modal.locator('button:has-text("보내기")').click();
await page.waitForFunction(
  (t) => document.body.innerText.includes(t),
  A2,
  { timeout: 10000 },
);
await check(
  seenSessions[0] === null && seenSessions[1] === 'sid-fixed',
  `닫았다 열어도 세션이 이어진다 (${JSON.stringify(seenSessions)})`,
);
await check(
  (await modal.locator('.chat-turn').count()) === 2,
  '말풍선이 두 턴 쌓인다',
);
// 감춰진 동안 스크롤이 안 먹는 문제 — 다시 열렸을 때 맨 아래여야 한다
const atBottom = await page.evaluate(() => {
  const el = document.querySelector('.overlay:not([hidden]) .chat-log');
  return el.scrollHeight - el.clientHeight - el.scrollTop < 4;
});
await check(atBottom, '대화 로그가 최신 답변까지 내려가 있다');
await modal.screenshot({ path: '/tmp/f1-2-two-turns.png' });

// ── 4. `새 대화` — 말풍선과 세션을 함께 버린다
await modal.locator('input.search').fill('남겨둘 질문');
await modal.locator('button:has-text("새 대화")').click();
await check(
  (await modal.locator('.chat-turn').count()) === 0 &&
    (await modal.locator('.chat-empty').isVisible()),
  '`새 대화`가 말풍선을 비운다',
);
await check(
  (await modal.locator('input.search').inputValue()) === '남겨둘 질문',
  '`새 대화`가 입력창은 비우지 않는다',
);
await modal.locator('button:has-text("보내기")').click();
await page.waitForSelector('.chat-answer', { timeout: 10000 });
await check(
  seenSessions[2] === null,
  `새 대화 뒤에는 세션 없이 나간다 (${JSON.stringify(seenSessions)})`,
);

// ── 5. 실행 중 닫으면 고정 버튼에 표시등이 뜬다
holdMs = 4000;
await modal.locator('button:has-text("새 대화")').click();
await modal.locator('input.search').fill('실행 중 닫기');
await modal.locator('button:has-text("보내기")').click();
await modal.locator('button.m-close').click();
await check(
  await page.locator('button.fab .fab-run').isVisible(),
  '실행 중 닫으면 고정 버튼에 ● 이 뜬다',
);
await check(
  (await page.locator('button.fab').getAttribute('aria-label')) ===
    '종목 즉답 열기 (답변 생성 중)',
  '고정 버튼 이름이 실행 중임을 말한다',
);
await page.screenshot({ path: '/tmp/f1-3-fab-running.png' });
// 스트림이 끝나면 표시등이 사라지고, 닫아 둔 동안 온 답변이 남는다
await page.waitForFunction(
  () => !document.querySelector('button.fab .fab-run'),
  { timeout: 15000 },
);
await page.click('button.fab');
await check(
  (await modal.locator('.chat-answer').count()) === 1,
  '닫아 둔 동안 도착한 답변이 살아 있다 (SSE가 안 끊긴다)',
);

// ── 6. 라이트에서도 같은 자리
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
await modal.screenshot({ path: '/tmp/f1-4-light.png' });

console.log(errors.length ? `\n콘솔 에러 ${errors.length}건:\n${errors.join('\n')}` : '\n콘솔 에러 0');
await browser.close();
process.exit(fail.length || errors.length ? 1 : 0);
