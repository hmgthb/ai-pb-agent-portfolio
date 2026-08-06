/** 만들어 둔 상담 준비 메모 목록 카드 검증 — 고객별 접기 · 저장본 PDF · 삭제(무장 → 실행).
 *
 *  다른 검사(`f1_modal_check`·`scenario_check`)와 달리 **아무것도 가로채지 않는다** —
 *  여기서 보는 것이 "서버에 남은 것을 다시 연다"라, 실제 라우트를 타야 의미가 있다.
 *  ⚠️ 그래서 **자기가 쓸 메모를 직접 만들고 끝나면 치운다**(남의 메모는 건드리지 않는다 —
 *     지우는 대상은 이 실행이 만든 id뿐이다). 크레딧은 안 든다: 메모 PDF는 LLM을 안 부른다.
 *
 *  실행: cd frontend && node prep_list_check.mjs   (백엔드 8000 · 프론트 3000)
 */
import { chromium } from 'playwright';

const API = 'http://localhost:8000';
const listIds = () =>
  fetch(`${API}/api/prep-notes`)
    .then((r) => r.json())
    .then((j) => j.map((x) => x.id));

const seed = async (customerId, n) => {
  const r = await fetch(`${API}/api/customers/${customerId}/prep-note/pdf?actor=PB`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ kind: 'memo', text: `목록 카드 검증용 ${n}` }] }),
  });
  if (!r.ok) throw new Error(`메모 생성 실패: ${r.status}`);
};

// 담당 고객 중 첫 사람에게 두 건. 한 고객에 여러 건이 쌓이는 것이 이 카드의 요점이다.
const customers = await fetch(`${API}/api/customers`).then((r) => r.json());
const target = customers[0];
const prior = await listIds();
await seed(target.id, 1);
await seed(target.id, 2);
const seeded = (await listIds()).filter((id) => !prior.includes(id));
if (seeded.length !== 2) throw new Error(`시드 2건이 아니다: ${JSON.stringify(seeded)}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:3000/dashboard', { waitUntil: 'networkidle' });

const fail = [];
const check = (ok, label) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) fail.push(label);
};

const card = page.locator('section[aria-labelledby="prep-title"]');
await card.waitFor({ timeout: 15000 });
await check(await card.isVisible(), '상담 준비 메모 카드가 고객 카드 아래에 선다');
await check(
  (await card.locator('.card-head .hint').innerText()).includes('건'),
  '카드 머리에 총 건수가 뜬다',
);

const grp = card.locator('details.prepgrp', {
  has: page.locator(`strong:text-is("${target.name}")`),
});
await check((await grp.count()) === 1, `고객으로 한 겹 묶인다 (${target.name})`);
await check(
  (await grp.locator('summary .cno').innerText()) === `#${target.id}`,
  '묶음 제목에 고객 번호가 붙는다',
);

// 방금 만든 메모라도 **접힌 채로** 선다 — 이 고객은 화면이 기본으로 고른 고객이기도 하다
// (예전에는 고른 고객의 묶음을 펼쳐 둬서, 메모를 만들 때마다 카드가 뛰어올랐다).
const opened = await grp.evaluate((el) => el.open);
await check(!opened, '새로 만든 메모의 묶음도 접힌 채로 선다');
await grp.locator('summary').click();
await page.waitForTimeout(150);
await check(
  (await grp.evaluate((el) => el.open)) !== opened,
  '묶음 제목을 누르면 접혔다 펴진다',
);
if (!(await grp.evaluate((el) => el.open))) await grp.locator('summary').click();
await check((await grp.locator('.qrow').count()) === 2, '펼치면 이 고객의 두 건이 보인다');
await card.screenshot({ path: '/tmp/prep-1-list.png' });

// PDF 뷰어 — 저장된 재료로 다시 그려 온다
await grp.locator('.qrow').first().locator('button:has-text("PDF")').click();
const modal = page.locator('.overlay .modal.pdfmodal');
await modal.waitFor({ timeout: 5000 });
const src = await modal.locator('iframe.pdfframe').getAttribute('src');
await check(/\/api\/prep-notes\/\d+\/pdf/.test(src ?? ''), '뷰어가 저장된 메모를 가리킨다');
const status = await page.evaluate(
  (u) => fetch(u).then((r) => `${r.status} ${r.headers.get('content-type')}`),
  src,
);
await check(status.startsWith('200') && status.includes('pdf'), `PDF가 실제로 온다 (${status})`);
await page.screenshot({ path: '/tmp/prep-2-modal.png' });
await modal.locator('.m-close').click();

// 삭제 — 되돌릴 수 없으므로 **두 번 눌러야** 실행된다
const row = grp.locator('.qrow').first();
await row.locator('.iconbtn').click();
await page.waitForTimeout(150);
await check(
  (await row.locator('button:has-text("삭제")').isVisible()) &&
    (await row.locator('button:has-text("취소")').isVisible()),
  '쓰레기통을 한 번 누르면 `삭제`·`취소`로 무장한다',
);
await check(
  (await listIds()).length === prior.length + 2,
  '무장만으로는 아무것도 지워지지 않는다',
);
await card.screenshot({ path: '/tmp/prep-3-armed.png' });
await row.locator('button:has-text("취소")').click();
await page.waitForTimeout(150);
await check(await row.locator('.iconbtn').isVisible(), '`취소`를 누르면 아이콘으로 돌아간다');

await row.locator('.iconbtn').click();
await row.locator('button:has-text("삭제")').click();
await page.waitForTimeout(1200);
const after = await listIds();
await check(
  after.length === prior.length + 1 && seeded.filter((id) => after.includes(id)).length === 1,
  `두 번째 누름이 **고른 한 건만** 지운다 (${JSON.stringify(after)})`,
);
await check((await grp.locator('.qrow').count()) === 1, '화면에서도 그 줄만 빠진다');

// 라이트에서도 같은 자리
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
await page.waitForTimeout(200);
await card.screenshot({ path: '/tmp/prep-4-light.png' });

// 뒷정리 — **이 실행이 만든 것만** 지운다
for (const id of seeded) {
  if (after.includes(id)) await fetch(`${API}/api/prep-notes/${id}?actor=PB`, { method: 'DELETE' });
}
const end = await listIds();
await check(
  JSON.stringify(end) === JSON.stringify(prior),
  `검사가 만든 것을 남기지 않는다 (${JSON.stringify(end)})`,
);

console.log(
  errors.length ? `\n콘솔 에러 ${errors.length}건:\n${errors.join('\n')}` : '\n콘솔 에러 0',
);
await browser.close();
process.exit(fail.length || errors.length ? 1 : 0);
