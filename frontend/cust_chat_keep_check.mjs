/** 고객 카드 `포트폴리오 질문` 검증 — 고객을 바꿔도 대화가 남는다 · 세션은 고객별 · 새 대화.
 *  크레딧 0(`/api/chat/stream`만 가로채 SSE를 재생한다 — `f1_modal_check.mjs`와 같은 방식).
 *
 *  ⚠️ 이 검사가 지키는 것은 **대화가 고객별로 보관된다**는 성질과, 그 대가로 깨지기 쉬운
 *     것 하나다: **세션 id가 고객을 넘어 흐르면 안 된다**(멀티턴 `last_entity`가 앞 고객의
 *     종목을 이어받아, 이 고객이 갖고 있지도 않은 종목을 답한다).
 *
 *  실행: cd frontend && node cust_chat_keep_check.mjs   (백엔드 8000 · 프론트 3000)
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
    notice:
      'ℹ 시세·주가는 지연시세(일별 종가) 기준이며, 본 답변은 투자권유가 아닙니다.',
    sentences: [
      {
        text,
        source: {
          type: 'dart',
          rcept_no: '20260722000123',
          viewer_url: 'https://dart.fss.or.kr/x',
          rcept_dt: '20260722',
        },
        is_heading: false,
        kind: 'claim',
      },
    ],
    violations: [],
  }) +
  sse('done', {});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

const answers = ['첫 고객 답변 A.', '둘째 고객 답변 B.', '돌아온 뒤 답변 C.'];
let turn = 0;
const calls = []; // {session, customer}
await page.route('**/api/chat/stream*', async (route) => {
  const url = new URL(route.request().url());
  calls.push({
    session: url.searchParams.get('session'),
    customer: url.searchParams.get('customer_id'),
  });
  const text = answers[turn] ?? `추가 답변 ${turn}.`;
  turn += 1;
  route.fulfill({
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: answerBody(`sid-${turn}`, text),
  });
});

await page.goto('http://localhost:3000/dashboard', { waitUntil: 'networkidle' });

const fail = [];
const check = (ok, label) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) fail.push(label);
};

// 고객 탭 · 목록
await page.click('button:has-text("고객 포트폴리오")').catch(() => {});
const rows = page.locator('.tbl-scroll tbody tr:not(.tsep)');
await rows.first().waitFor({ timeout: 10000 });
const card = page.locator('.cust-chat');
const chatInput = card.locator('input.search');
const send = card.locator('button:has-text("보내기")');

const pickRow = async (i) => {
  await rows.nth(i).click();
  await page.waitForTimeout(300);
};

// ── 1. 첫 고객에게 한 턴
await pickRow(0);
const name0 = await rows.nth(0).locator('strong').innerText();
await check(
  (await card.locator('button:has-text("새 대화")').count()) === 0,
  '대화가 없으면 `새 대화`를 내지 않는다',
);
await chatInput.fill('삼성전자 최근 실적');
await send.click();
await page.waitForSelector('.cust-chat .chat-answer', { timeout: 10000 });
await check(
  (await card.innerText()).includes(answers[0]),
  `첫 고객(${name0}) 답변이 화면에 온다`,
);
await check(
  await card.locator('button:has-text("새 대화")').isVisible(),
  '대화가 생기면 제목 줄에 `새 대화`가 선다',
);
await card.screenshot({ path: '/tmp/cc-1-first.png' });

// ── 2. 다른 고객으로 옮기면 **빈 대화**로 시작한다
await pickRow(1);
const name1 = await rows.nth(1).locator('strong').innerText();
await check(
  (await card.locator('.chat-turn').count()) === 0 &&
    (await card.locator('.chat-empty').isVisible()),
  `다른 고객(${name1})은 빈 대화로 시작한다 (앞 고객 대화가 번지지 않는다)`,
);
await chatInput.fill('보유 비중 알려줘');
await send.click();
await page.waitForFunction(
  (t) => document.querySelector('.cust-chat').innerText.includes(t),
  answers[1],
  { timeout: 10000 },
);
await check(
  calls[1].session === null && calls[1].customer !== calls[0].customer,
  `새 고객의 첫 질문은 세션 없이 나간다 (${JSON.stringify(calls)})`,
);

// ── 3. 앞 고객으로 돌아오면 대화가 되살아난다 (이 검사의 요점)
await pickRow(0);
await check(
  (await card.innerText()).includes(answers[0]) &&
    !(await card.innerText()).includes(answers[1]),
  '앞 고객으로 돌아오면 그 고객의 대화만 되살아난다',
);
await check(
  (await card.locator('.chat-turn').count()) === 1,
  '되살아난 말풍선 수가 맞는다',
);
const atBottom = await page.evaluate(() => {
  const el = document.querySelector('.cust-chat .chat-log');
  return el.scrollHeight - el.clientHeight - el.scrollTop < 4;
});
await check(atBottom, '대화 로그가 최신 답변까지 내려가 있다');
await card.screenshot({ path: '/tmp/cc-2-restored.png' });

// ── 4. 되살아난 대화의 후속 질문은 **자기 세션**을 이어받는다
await chatInput.fill('관련 뉴스는?');
await send.click();
await page.waitForFunction(
  (t) => document.querySelector('.cust-chat').innerText.includes(t),
  answers[2],
  { timeout: 10000 },
);
await check(
  calls[2].session === 'sid-1' && calls[2].customer === calls[0].customer,
  `돌아온 대화는 앞 고객의 세션을 이어간다 (${JSON.stringify(calls)})`,
);

// ── 5. `새 대화` — 말풍선·세션은 버리고 쓰던 질문은 남긴다
await chatInput.fill('남겨둘 질문');
await card.locator('button:has-text("새 대화")').click();
await page.waitForTimeout(200);
await check(
  (await card.locator('.chat-turn').count()) === 0 &&
    (await card.locator('.chat-empty').isVisible()),
  '`새 대화`가 말풍선을 비운다',
);
await check(
  (await chatInput.inputValue()) === '남겨둘 질문',
  '`새 대화`가 입력창은 비우지 않는다',
);
await check(
  (await card.locator('button:has-text("새 대화")').count()) === 0,
  '비운 뒤에는 `새 대화`가 사라진다',
);
await send.click();
await page.waitForSelector('.cust-chat .chat-answer', { timeout: 10000 });
await check(
  calls[3].session === null,
  `새 대화 뒤에는 세션 없이 나간다 (${JSON.stringify(calls.map((c) => c.session))})`,
);

// ── 6. 비운 것이 **그 고객에게만** 적용된다
await pickRow(1);
await check(
  (await card.innerText()).includes(answers[1]),
  '다른 고객의 대화는 비우기와 무관하게 남아 있다',
);
await card.screenshot({ path: '/tmp/cc-3-other-kept.png' });

console.log(
  errors.length
    ? `\n콘솔 에러 ${errors.length}건:\n${errors.join('\n')}`
    : '\n콘솔 에러 0',
);
await browser.close();
process.exit(fail.length || errors.length ? 1 : 0);
