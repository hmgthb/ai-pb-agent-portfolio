/** W6 3시나리오 빈/에러 상태 화면 검증 — 크레딧 불필요.
 *
 *  실제 에이전트를 돌리는 대신 `/api/research/stream`만 가로채 시나리오별 SSE를
 *  그대로 재생한다. 나머지 API(대시보드·큐·고객)는 실백엔드를 그대로 쓴다.
 *
 *  실행: cd frontend && node scenario_check.mjs
 *  (백엔드 8000·프론트 3000이 떠 있어야 한다)
 */
import { chromium } from 'playwright';

const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const NEWS = [
  { title: '네이버, AI 팩토리 투자 확대', link: 'https://n.news.naver.com/a', pub_date: '2026-07-21T10:00:00' },
];
const FIN = {
  type: 'financials',
  agent: 'a2',
  corp_name: '테스트법인',
  bsns_year: '2024',
  fs_div: 'CFS',
  figures: { 매출액: { 당기: '10737700000000', 전기: '9670600000000' } },
};

const START =
  sse('progress', { agent: 'a1', step: 'delegated', status: 'started' }) +
  sse('progress', { agent: 'a2', step: 'delegated', status: 'started' }) +
  sse('progress', { agent: 'a4', step: 'delegated', status: 'started' });

const SCENARIOS = {
  // ① 공시 없음 — 조회는 정상, 결과가 0건. 뉴스만으로 노트는 나온다.
  'no-disclosure':
    START +
    sse('progress', { agent: 'a1', step: 'mcp__dart__dart_search', status: 'completed' }) +
    sse('card', { type: 'news', agent: 'a4', items: NEWS }) +
    sse('progress', { agent: 'a5', step: 'note_draft', status: 'started' }) +
    sse('note_token', { text: '최근 공시는 확보하지 못했다. ' }) +
    sse('progress', { agent: 'a5', step: 'note_draft', status: 'completed' }) +
    sse('note', { id: 99, status: 'draft', corp_name: '테스트법인', sentences: [], violations: [] }) +
    sse('done', {
      unsourced_agents: [],
      outcome: {
        note_created: true, has_financials: false, news_count: 1, disclosure_count: 0,
        failed_tools: [],
        reasons: [
          '최근 공시가 없습니다 — 조회는 정상 동작했고 결과가 0건입니다.',
          '재무 핵심수치를 확보하지 못했습니다.',
        ],
      },
    }),

  // ② 파싱 실패 — dart_parse가 죽었다. 뉴스가 있으므로 a5는 돌고 노트는 나온다
  //    (backend: `if financials or news_items`). 빠진 건 사유로 알린다.
  'parse-failed':
    START +
    sse('progress', { agent: 'a2', step: 'mcp__dart__dart_parse', status: 'failed' }) +
    sse('card', { type: 'news', agent: 'a4', items: NEWS }) +
    sse('progress', { agent: 'a5', step: 'note_draft', status: 'started' }) +
    sse('progress', { agent: 'a5', step: 'note_draft', status: 'completed' }) +
    sse('note', { id: 99, status: 'draft', corp_name: '테스트법인', sentences: [], violations: [] }) +
    sse('done', {
      unsourced_agents: ['a2'],
      outcome: {
        note_created: true, has_financials: false, news_count: 1, disclosure_count: 12,
        failed_tools: ['mcp__dart__dart_parse'],
        reasons: [
          '재무제표 파싱에 실패했습니다 — 연결재무제표(CFS)를 제출하지 않는 법인이거나 해당 사업연도 보고서가 아직 없을 수 있습니다.',
        ],
      },
    }),

  // ③ 뉴스 없음 — 재무는 정상이라 노트는 나온다.
  'no-news':
    START +
    sse('card', FIN) +
    sse('source', { agent: 'a1', rcept_no: '20250318000645', viewer_url: 'https://dart.fss.or.kr/x', rcept_dt: '20250318' }) +
    sse('progress', { agent: 'a5', step: 'note_draft', status: 'started' }) +
    sse('progress', { agent: 'a5', step: 'note_draft', status: 'completed' }) +
    sse('note', { id: 99, status: 'draft', corp_name: '테스트법인', sentences: [], violations: [] }) +
    sse('done', {
      unsourced_agents: [],
      outcome: {
        note_created: true, has_financials: true, news_count: 0, disclosure_count: 12,
        failed_tools: [],
        reasons: ['관련 뉴스가 없습니다 — 조회는 정상 동작했고 결과가 0건입니다.'],
      },
    }),

  // ④ 아무것도 못 구함 — a5를 아예 돌리지 않는다(가드레일 3). 노트가 없는 유일한 정상 경로.
  nothing:
    START +
    sse('progress', { agent: 'a2', step: 'mcp__dart__dart_parse', status: 'failed' }) +
    sse('done', {
      unsourced_agents: ['a1'],
      outcome: {
        note_created: false, has_financials: false, news_count: 0, disclosure_count: 0,
        failed_tools: ['mcp__dart__dart_parse'],
        reasons: [
          '최근 공시가 없습니다 — 조회는 정상 동작했고 결과가 0건입니다.',
          '재무제표 파싱에 실패했습니다 — 연결재무제표(CFS)를 제출하지 않는 법인이거나 해당 사업연도 보고서가 아직 없을 수 있습니다.',
          '관련 뉴스가 없습니다 — 조회는 정상 동작했고 결과가 0건입니다.',
          '재무·뉴스를 모두 확보하지 못해 노트를 작성하지 않았습니다 — 근거 없는 노트는 만들지 않습니다(가드레일 3).',
        ],
      },
    }),

  // ④ 실행 중 예외 — 스트림이 조용히 끊기지 않고 사유가 화면에 도달해야 한다.
  'run-error':
    START +
    sse('run_error', { message: '실행 중 오류가 발생했습니다 (RuntimeError). 백엔드 로그를 확인하세요.' }) +
    sse('done', { unsourced_agents: [], outcome: null }),
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });

const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

let failures = 0;
for (const [name, body] of Object.entries(SCENARIOS)) {
  await page.route('**/api/research/stream*', (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body }),
  );

  await page.goto('http://localhost:3000/dashboard', { waitUntil: 'networkidle' });
  // 노트 생성 카드는 PB의 「작성·검토」 탭에 있다(첫 화면은 「상담 준비」). 탭은 `hidden`
  // 토글이라 DOM에는 있지만 안 보이는 상태로 시작한다 — 안 누르면 fill이 그대로 멈춘다.
  await page.click('button:has-text("작성·검토")');
  await page.fill('#research-card input[aria-label="종목 코드"]', '035420');
  await page.click('#research-card button.primary');

  // done까지 처리되면 버튼이 다시 활성화된다
  await page.waitForFunction(
    () => !document.querySelector('#research-card button.primary')?.disabled,
    { timeout: 10000 },
  );

  const card = page.locator('#research-card');
  const text = await card.innerText();
  await card.screenshot({ path: `/tmp/w6-${name}.png` });

  // 시나리오별로 "화면이 실제로 그 사유를 말하는지" 확인
  const expect = {
    'no-disclosure': ['최근 공시가 없습니다', '확보하지 못한 데이터'],
    'parse-failed': ['재무제표 파싱에 실패', '확보하지 못한 데이터', '확보 못 함'],
    'no-news': ['관련 뉴스가 없습니다', '0건', '확보하지 못한 데이터'],
    nothing: ['노트를 만들지 못한 이유', '가드레일 3', '확보 못 함'],
    'run-error': ['실행 중 오류가 발생했습니다'],
  }[name];

  const missing = expect.filter((s) => !text.includes(s));
  if (missing.length) {
    failures++;
    console.log(`✗ ${name} — 화면에 없음: ${missing.join(', ')}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

console.log(errors.length ? `\n콘솔 에러 ${errors.length}건:\n${errors.join('\n')}` : '\n콘솔 에러 0');
await browser.close();
process.exit(failures || errors.length ? 1 : 0);
