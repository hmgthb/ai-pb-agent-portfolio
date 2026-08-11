'use client';

/** 브리핑 「고객 관련 종목」 줄의 **보유 고객**(2026-08-10 · 2026-08-11 개편).
 *
 *  **브리핑 문장을 누르면 창이 열리고**, 그 종목을 들고 있는 담당 고객을
 *  **줄이는 쪽 / 담는 쪽** 둘로 갈라 낸다. 이 파일의 기본 export는 그 아래 한 줄
 *  (보유 N명 · 등락)이고, **누르는 자리가 아니다**.
 *
 *  **왜 인라인 펼치기를 걷어냈나**(2026-08-11). 예전에는 배지를 누르면 같은 자리에서
 *  목록이 펴졌는데, 브리핑 카드 안에서 펴지다 보니 5명까지만 보이고 나머지는 `… N명 더`로
 *  잘렸다 — 21명 중 5명이다. PB가 이 목록에서 하려는 일은 "누구부터 연락할지 고르기"라
 *  잘린 목록으로는 그 일이 안 된다. 창으로 빼면서 **자르지 않는다**.
 *
 *  **왜 여는 자리가 문장인가**(2026-08-11). 처음에는 수치 배지가 여는 버튼이었는데,
 *  PB가 읽고 반응하는 것은 "확인이 필요해 보입니다"라는 문장이지 `-19.2%`가 아니다 —
 *  읽는 곳과 누르는 곳이 갈려 있었다. 배지는 다시 **읽기만 하는 줄**로 돌아갔다.
 *
 *  ⚠️ **이름은 브리프에서 오지 않는다.** 백엔드가 실어 보내는 건 종목코드와 집계뿐이고
 *     (`brief.stock_headline_bullet`의 `stock`), 이름·보유 비중·사정은 여기서
 *     `/api/customers`(PB가 이미 보는 목록)와 **종목코드로 조인**해 붙인다. 그래서
 *     `briefs` 테이블에도 프롬프트에도 고객 식별정보가 남지 않는다(가드레일 1).
 *     ⚠️ 되돌려서 이름을 백엔드 payload에 담지 말 것 — 그 순간 저장소에 PII가 들어간다.
 *  ⚠️ 가르는 일도 **규칙이 한다**(`watchRows`). 어느 고객을 줄이고 어느 고객을 담을지
 *     모델에게 물으면 데이터에 없는 근거가 섞인다 — `f1.rebalance_options`·
 *     `brief.watch_candidates`와 같은 처방이고, 화면은 규칙이 고른 결과를 적기만 한다.
 *  ⚠️ 급한지 아닌지의 어휘(`urgent`)는 **백엔드가 실어 보낸 것**을 쓴다
 *     (`lead.urgent_horizons`). 여기서 목록을 따로 들면 브리핑이 급하다고 센 인원수와
 *     화면이 위에 올린 고객이 갈린다.
 */

import { useState } from 'react';
import { fmtKRW } from './api';
import { allocEntries, ALLOC_COLORS, Donut } from './charts';
import { type Customer, type WatchStock } from './types';

/** `scenario.summary`를 **줄로 가른다**.
 *
 *  저장값이 `f"{원형 라벨} — {목표}"`로 조립돼 있어서(`scripts/seed_scenarios.py`) 그대로
 *  찍으면 화면에 긴 줄표가 남는다. 여기서 하는 일은 **다시 쓰는 것이 아니라 자리를 나누는
 *  것**이다 — 낱말은 그대로고, 두 조각을 두 줄에 세운다. 이어 붙일 접속 부호를 새로 고르면
 *  그건 화면이 만든 말이 된다.
 *  ⚠️ 구분자가 seed 쪽에서 바뀌면 여기도 같이 본다(못 가르면 한 줄로 그대로 나온다 —
 *     조용히 틀리지는 않는다). */
function situationLines(summary: string | null): string[] {
  return (summary ?? '')
    .split(' — ')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 도넛에 붙일 툴팁이 없다는 뜻. 고객 카드는 `useTip()`의 `bind`를 넘겨 조각마다 값을
 *  띄우는데, 여기서는 **바로 옆 범례가 같은 수를 이미 적고 있어서** 띄울 것이 없다
 *  (모달 위에 뜨는 떠 있는 층을 하나 더 만들 이유도 없다). */
const NO_TIP = () => ({});

/** 이 고객을 어느 쪽에 세울 것인가 — **둘뿐이고 겹치지 않는다**(합이 보유 인원과 같다).
 *
 *  `trim`(줄이는 쪽): 기한이 급하거나, 자금성향이 등록된 투자성향보다 보수적인 고객.
 *      둘 다 **저장된 사실**이다(`scenario.horizon` · `registered_risk`/`effective_risk`) —
 *      여기서 위험을 새로 판정하지 않는다.
 *  `add`(담는 쪽): 그 둘 중 어느 것에도 걸리지 않는 고객. 기한에 여유가 있고 견딜 여력이
 *      등록된 성향만큼(또는 그보다 더) 남아 있다는 뜻이다.
 *
 *  ⚠️ **제3의 값을 만들지 말 것.** "판단 보류" 같은 칸을 두면 그 칸이 곧 쓰레기통이 되고,
 *     화면은 21명 중 몇 명을 보여 주고 있는지 스스로 설명하지 못한다. */
export type WatchSide = 'trim' | 'add';

export type Row = {
  id: number;
  /** 고객 표의 `#`와 **같은 수**. 전체 고객 목록에서의 자리(1부터)이지 `id`가 아니다 —
   *  표가 그 번호로 사람을 부르므로 여기서 다른 기준으로 세면 이 창의 3번과 표의 3번이
   *  다른 사람을 가리킨다(`page.tsx`의 `selectedNo`가 같은 이유로 목록 기준을 쓴다).
   *  ⚠️ 표에서 **검색 중이면** 그쪽 번호가 걸러진 목록 기준으로 다시 매겨져 어긋난다.
   *     이 창은 검색과 무관한 자리(브리핑)에서 열리므로 전체 목록 기준을 쓴다. */
  no: number;
  name: string;
  side: WatchSide;
  /** 그 고객의 **보유주식 내** 비중. 없으면 null(지어내지 않는다). */
  pct: number | null;
  horizon: string | null;
  urgent: boolean;
  /** 투자성향 ≠ 자금성향일 때만 채워진다 — 같으면 적을 것이 없다. */
  risk: { registered: string; effective: string; conservative: boolean } | null;
  /** 자금성향이 갈린 **저장된 사유**(`scenario.effective_risk_why`). 화면이 짓지 않는다. */
  why: string | null;
  /** 상황 한 줄(`scenario.summary`) — 규칙이 조립한 것이지 AI가 쓴 것이 아니다. */
  situation: string | null;
  /** 원본 고객. 펼친 패널이 포트폴리오를 그릴 때 쓴다 — 목록이 **접혀 있을 때는 이름만**
   *  쓰므로 여기 필드를 늘려 옮겨 담지 않는다(사본이 둘이면 언젠가 갈린다). */
  cust: Customer;
};

export function watchRows(
  stock: WatchStock,
  customers: Customer[],
  urgent: string[],
  risks: string[],
): Row[] {
  const urgentSet = new Set(urgent);
  const rows: Row[] = [];
  /* ⚠️ 순번은 **거르기 전** 목록에서 센다 — 여기 들어오는 `customers`가 PB의 전체 고객이고
     (`data.customers`), 표의 `#`도 그 자리다. 보유자만 골라 놓고 1부터 다시 매기면
     이 창의 3번과 고객 표의 3번이 다른 사람이 된다. */
  for (const [i, c] of customers.entries()) {
    const h = (c.holdings ?? []).find((x) => x.code === stock.code);
    if (!h) continue;
    const sc = c.scenario;
    const horizon = sc?.horizon ?? null;
    const isUrgent = horizon !== null && urgentSet.has(horizon);
    const gap =
      sc && sc.registered_risk !== sc.effective_risk
        ? {
            registered: risks[sc.registered_risk] ?? '',
            effective: risks[sc.effective_risk] ?? '',
            conservative: sc.effective_risk < sc.registered_risk,
          }
        : null;
    rows.push({
      id: c.id,
      no: i + 1,
      name: c.name,
      side: isUrgent || gap?.conservative ? 'trim' : 'add',
      pct: h.pct_of_equity,
      horizon,
      urgent: isUrgent,
      risk: gap,
      why: sc?.effective_risk_why ?? null,
      situation: sc?.summary ?? null,
      cust: c,
    });
  }
  /* 기한 급한 순 → 성향 격차 있는 순 → 비중 큰 순 → id.
     ⚠️ 두 쪽에 **같은 정렬**을 쓴다. 담는 쪽에서 "비중 낮은 순(담을 자리가 많은 순)"으로
        뒤집어 볼 수도 있지만, 그건 데이터가 아니라 화면이 만든 판단이라 하지 않는다 —
        비중이 큰 고객이 먼저 서는 건 어느 쪽에서든 "얘기 꺼낼 거리가 큰 순"이다.
     ⚠️ 마지막 id는 **동률에서 순서가 흔들리지 않게** 하는 자리다(같은 브리프를 두 번 열면
        같은 순서여야 한다 · 백엔드 `watch_candidates`가 종목코드를 쓰는 것과 같은 처방). */
  return rows.sort(
    (a, b) =>
      Number(b.urgent) - Number(a.urgent) ||
      Number(!!b.risk) - Number(!!a.risk) ||
      (b.pct ?? -1) - (a.pct ?? -1) ||
      a.id - b.id,
  );
}

/** 종목의 사실 한 줄(보유 인원 · 등락). **누르는 자리가 아니다** — 창은 위 문장이 연다.
 *
 *  ⚠️ **이 줄을 지우면 수치가 화면에서 사라진다.** 프롬프트가 모델에게 등락률·보유 인원을
 *     문장에 쓰지 말라고 금지하므로(backend `STOCK_HEADLINE_SYSTEM_PROMPT` — 입력에 아예
 *     없다) 브리핑 문장에는 절대 안 나오고, 화면에서 그 수치를 적는 곳이 여기뿐이다.
 *  ⚠️ 지연시세임은 **창이 밝힌다**(`WatchHoldersModal`의 메타 줄). 여기 한 줄에 또 적으면
 *     브리핑 카드가 지수 띠(이미 기준일을 적는다) 아래에서 같은 말을 두 번 하게 된다. */
export default function WatchHolders({ stock }: { stock: WatchStock }) {
  /* 적는 건 **종목의 사실**뿐이다. `기한 임박 N명`·`자금성향 보수적 N명`은 창이 이름과
     함께 그대로 말하므로 여기서 되풀이하지 않는다. */
  /* `-19.2% (14일) · 21명 보유` — 창 머리말과 **같은 순서·같은 표기**다(2026-08-11에
     맞췄다). 배지와 창이 같은 두 값을 다른 차례로 적으면, 눌러서 열었을 때 같은 사실을
     다시 읽어야 한다. 값이 먼저이고 재는 구간은 괄호로 뒤에 선다. */
  const summary = [
    stock.days != null && stock.pct != null
      ? `${stock.pct > 0 ? '+' : ''}${stock.pct.toFixed(1)}% (${stock.days}일)`
      : null,
    `${stock.holders}명 보유`,
  ]
    .filter(Boolean)
    .join(' · ');

  return <div className="watch-holders">{summary}</div>;
}

/** 두 쪽의 이름. 화면 문구를 한 곳에 두는 이유는 제목이 `watchRows`의 판정과 어긋나면
 *  목록이 자기를 잘못 설명하기 때문이다.
 *
 *  ⚠️ 제목 아래 **기준을 적던 한 줄(`hint`)은 걷어냈다**. 그래서 화면은 어느 고객이 왜
 *     이쪽에 섰는지를 **줄마다 붙는 꼬리표**로만 말한다(`기한 …` · `자금성향 …`) — 그
 *     꼬리표를 빼면 목록이 근거 없이 사람을 가르게 되므로 그건 남겨 둘 것. */
const SIDES: Record<WatchSide, { label: string }> = {
  trim: {
    label: '줄이는 쪽',
  },
  add: {
    label: '담는 쪽',
  },
};

/** 보유 고객 창 — 브리핑 배지를 누르면 열린다.
 *
 *  ⚠️ **자르지 않는다.** 인라인 펼치기를 걷어낸 이유가 그것이라(위 머리말) 여기서 다시
 *     상한을 두면 창을 만든 뜻이 없어진다. 길면 모달 본문이 스크롤한다.
 *  ⚠️ 0명인 쪽도 **제목은 낸다.** 접으면 "그 쪽이 없다"와 "그 쪽을 안 봤다"가 구분되지
 *     않는다 — 21명이 전부 한쪽에 몰린 것 자체가 PB가 알아야 할 사실이다. */
export function WatchHoldersModal({
  stock,
  text,
  customers,
  urgentHorizons,
  risks,
  notice,
  onClose,
}: {
  stock: WatchStock;
  /** 브리핑에 실린 그 종목 한 줄. 왜 이 창을 열었는지가 여기 있다(모델이 쓴 문장). */
  text?: string;
  customers: Customer[];
  urgentHorizons: string[];
  /** `RISK` 라벨 배열 — 성향 인덱스를 이름으로 바꾼다(화면이 다시 정하지 않는다). */
  risks: string[];
  /** F2 필수 고지(`compliance.NOTICES['F2']`) — **백엔드가 실어 보낸 것**을 그대로 쓴다.
   *  ⚠️ 문구를 여기 적어 두지 말 것. 이 창은 이름·상황·지연시세가 한자리에 서는 곳이라
   *     고지가 실제로 필요한데, 사본을 들면 코드와 화면이 갈린다. */
  notice?: string;
  /** ⚠️ 고객 카드로 가는 콜백은 **없앴다**(2026-08-11). 이름을 누르면 카드로 넘어가던 것을
   *  펼침으로 바꾸고, 펼친 뒤 남겨 뒀던 `고객 카드 열기` 줄마저 걷었다 — 그 줄이 가서 보여
   *  주던 것(계좌·성향·잔고·도넛·보유 표)이 이제 이 패널 안에 그대로 있어서다. */
  onClose: () => void;
}) {
  const rows = watchRows(stock, customers, urgentHorizons, risks);
  /* 펼친 고객들. **여럿을 동시에 펼 수 있다** — PB가 이 목록에서 하는 일이 "누구부터
     연락할지 고르기"라, 둘을 나란히 놓고 견주는 것이 실제 동작이다. 하나만 열리게 하면
     비교하려고 열 때마다 방금 본 것이 닫힌다. */
  const [open, setOpen] = useState<ReadonlySet<number>>(new Set());
  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  /* `-19.2% (14일)` — **값이 먼저, 재는 구간이 괄호로 뒤**다(2026-08-11).
     ⚠️ 브리핑 카드의 배지(`WatchHolders`)는 `14일 -19.2%` 순서 그대로다. 거기는 그 줄이
        종목의 사실을 나열하는 자리라 구간이 앞에 서도 읽히는데, 창의 머리말은 등락률
        하나를 크게 말하는 자리라 순서를 뒤집었다. */
  const move =
    stock.days != null && stock.pct != null
      ? `${stock.pct > 0 ? '+' : ''}${stock.pct.toFixed(1)}% (${stock.days}일)`
      : null;

  return (
    <>
      <div className="m-head">
        <h3>{stock.name}</h3>
        <span className="m-id">{stock.code}</span>
        <button className="m-close" onClick={onClose} aria-label="닫기">
          ×
        </button>
      </div>
      {/* 등락률과 보유 인원. 값을 앞에, 재는 구간을 괄호로 뒤에 둔다 — 읽는 사람이 찾는
          것은 `14일`이 아니라 `-19.2%`다.
          ⚠️ `(지연시세)` 표시를 뺐다(2026-08-11 · 제품 결정). F2에 걸린 필수 고지는
             `내부 참고용`과 `내부 계좌데이터`이고 지연시세 명시는 F1의 것이다
             (CLAUDE.md 「기능별 필수 고지문구」) — 그래서 게이트는 이 자리를 보지 않는다.
             다만 **이 수치가 실시간이 아니라는 말은 화면에서 사라졌다.** 되살리려면
             여기 한 조각이면 된다. */}
      <div className="m-meta">
        {[move, `${rows.length}명 보유`].filter(Boolean).join(' · ')}
      </div>
      <div className="m-body">
        {/* 브리핑 문장 — 여기 다시 싣는 이유: 창을 열면 브리핑 줄이 화면에서 가려진다.
            ⚠️ **`AI 요약` 배지를 걷어냈다**(2026-08-11 · 브리핑 카드와 같은 결정 · page.tsx의
               같은 자리 주석을 볼 것). 이 문장만 모델이 쓴 것이고 아래 목록은 전부 규칙과
               계좌데이터에서 오는데, 화면이 그 경계를 더는 말하지 않는다. */}
        {text && <p className="watch-lede">{text}</p>}
        {(['trim', 'add'] as WatchSide[]).map((side) => {
          const list = rows.filter((r) => r.side === side);
          return (
            <section className="watch-side" key={side}>
              <h4>
                {SIDES[side].label}
                <span className="watch-count">{list.length}명</span>
              </h4>
              {list.length === 0 ? (
                <p className="watch-empty">해당하는 고객이 없습니다.</p>
              ) : (
                <ul className="watch-rows">
                  {list.map((r) => (
                    <WatchRow
                      key={r.id}
                      row={r}
                      stock={stock}
                      risks={risks}
                      open={open.has(r.id)}
                      onToggle={() => toggle(r.id)}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
        {/* ⚠️ **판단은 PB가 한다.** 이 창은 규칙이 가른 후보를 보여 줄 뿐이고, 실제로
            줄일지 담을지와 고객에게 하는 말은 PB가 정한다(가드레일 4). */}
        {notice && <div className="wm">{notice}</div>}
      </div>
    </>
  );
}

/** 목록 한 줄 — **접혀 있으면 이름뿐**이고, 누르면 선정 사유와 포트폴리오가 펴진다.
 *
 *  **왜 접어 두나**(2026-08-11). 21명이 각자 사정·비중·꼬리표를 달고 서면 그건 목록이
 *  아니라 보고서다. PB가 이 창에서 먼저 하는 일은 **누구인지 훑는 것**이고, 근거를 읽는
 *  것은 그다음이다 — 그래서 첫 화면은 이름만이고 근거는 한 번 더 눌러야 나온다.
 *
 *  ⚠️ **이름 클릭이 곧 펼침이다.** 예전에는 이름을 누르면 고객 카드로 넘어갔는데, 그러면
 *     창을 연 맥락(어느 종목의 어느 쪽에 선 사람인가)이 화면에서 사라진다. 카드로 가는
 *     길은 펼친 뒤 맨 아래 한 줄로 남겼다 — 없애지 말 것.
 *  ⚠️ 펼친 내용은 전부 **저장된 값**이다(`scenario` · 계좌 보유데이터). 화면이 요약하거나
 *     다시 쓰지 않는다 — 그 순간 근거가 화면 것이 되고, 고객 카드와 갈릴 수 있다. */
function WatchRow({
  row: r,
  stock,
  risks,
  open,
  onToggle,
}: {
  row: Row;
  stock: WatchStock;
  risks: string[];
  open: boolean;
  onToggle: () => void;
}) {
  const c = r.cust;
  const panelId = `watch-panel-${stock.code}-${r.id}`;
  return (
    <li>
      <button
        className="watch-name-toggle"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
      >
        <span className="watch-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="watch-rowno">{r.no}</span>
        <span className="watch-name">{r.name}</span>
      </button>
      {open && (
        <div className="watch-panel" id={panelId}>
          {/* ── 포트폴리오 — **고객 카드와 같은 것**을 그대로 세운다(2026-08-11). 계좌·나이·
                 성향 줄, 잔고·수익률, 도넛과 범례, 보유 표까지 클래스가 같아서(`.acct`·
                 `.row .kv`·`.donut-wrap`·`.holdings`) 규칙이 한 벌이다 — 카드 쪽 모양을
                 고치면 여기도 같이 바뀐다. 같은 값을 두 모양으로 그리지 않기 위해서다.
                 ⚠️ 여기서 수치를 다시 계산하지 않는다. 비중(`pct_of_equity`)의 분모는
                    백엔드가 단일 출처이고(`f1.portfolio_facts`), 화면은 찍기만 한다. */}
          <div className="acct">
            {c.acct} · {c.age}세 · {risks[c.risk] ?? ''}
            {/* 자금성향은 **다를 때만** 낸다(`r.risk`는 다를 때만 채워진다) — 고객 카드와
                같은 규칙이다. 같은데도 적으면 매 줄에 같은 말이 두 번 서고, 정작 다를 때의
                표시가 그 사이에 묻힌다. */}
            {r.risk && (
              <span className="risk-eff" title={r.why ?? '자금성향'}>
                → {r.risk.effective}
              </span>
            )}
          </div>
          {/* 위험 플래그 — **저장된 판정**을 인용할 뿐 새로 내리지 않는다(가드레일).
              ⚠️ 자리는 **계좌 줄 바로 아래**다(2026-08-11). 한때 보유 표 아래에 있었는데,
                 거기서는 이 사람이 플래그가 걸린 사람이라는 걸 도넛과 표를 다 지나서야
                 알게 된다 — 잔고·수익률을 읽는 동안 알고 있어야 할 사실이다.
                 고객 카드와도 같은 순서다(거기서도 이름·계좌 줄 다음이 사유 줄이다).
              ⚠️ ⚑ 글리프는 달지 않는다 — 카드에서는 바로 위 이름 옆 배지가 마커라
                 사유 줄에 기호를 되풀이하지 않는데, 그 규약을 여기서도 지킨다. */}
          {c.flag && c.flagReasons.length > 0 && (
            <div className="flag-reasons">
              {c.flagReasons.map((x) => x.text).join(' · ')}
            </div>
          )}
          <div className="row">
            <div className="kv">
              <div className="k">잔고</div>
              <div className="v">₩{fmtKRW(c.balance)}</div>
            </div>
            <div className="kv">
              <div className="k">수익률 (연초 대비)</div>
              <div className={`v delta ${c.ret >= 0 ? 'up' : 'down'}`}>
                {c.ret >= 0 ? '+' : ''}
                {c.ret.toFixed(1)}%
              </div>
            </div>
          </div>
          <div className="donut-wrap">
            {/* 순서·색은 도넛과 범례가 **같은 출처**에서 가져온다(charts.tsx) — 여기에
                색 배열을 다시 적으면 둘이 조용히 어긋난다. */}
            <Donut alloc={c.alloc} bind={NO_TIP} />
            <div className="legend">
              {allocEntries(c.alloc).map(([k, v], i) => (
                <div className="li" key={k}>
                  <span
                    className="sw"
                    style={{ background: ALLOC_COLORS[i % ALLOC_COLORS.length] }}
                  />
                  {k}
                  <span className="pct">{v}%</span>
                </div>
              ))}
            </div>
          </div>
          <table className="holdings" aria-label="보유 종목">
            <thead>
              <tr>
                <th>종목</th>
                <th className="num">평가금액</th>
                {/* 열 이름이 고객 카드와 같다 — `50.9%`가 무엇의 비중인지는 이 머리글만
                    말한다(잔고 대비가 아니라 보유주식 내). */}
                <th className="num">주식 내</th>
              </tr>
            </thead>
            <tbody>
              {c.holdings.map((h) => (
                /* 이 창을 연 종목에 표시를 준다 — 표에서 그 줄을 눈으로 찾는 일이
                   이 패널을 여는 이유의 절반이다.
                   ⚠️ 종목 이름은 **누르는 자리가 아니다.** 고객 카드에서는 발행분 노트
                      PDF를 여는 버튼인데, 여기서 그러면 창 위에 창이 열린다. */
                <tr
                  key={h.code}
                  className={h.code === stock.code ? 'is-it' : ''}
                >
                  <td>
                    <strong>{h.name}</strong>{' '}
                    <span style={{ color: 'var(--muted)' }}>{h.code}</span>
                  </td>
                  <td className="num">₩{fmtKRW(h.amt)}</td>
                  {/* 비중이 없으면 빈칸이 아니라 `—`. 빈칸은 "0%"로도 "아직 안 셌다"로도
                      읽힌다(고객 카드와 같은 규칙). */}
                  <td className="num pct-eq">
                    {h.pct_of_equity == null ? '—' : `${h.pct_of_equity}%`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* ── 이 사람이 왜 이쪽에 섰는가. 포트폴리오를 먼저 보고 나서 읽는 순서라
                 아래에 둔다. 꼬리표(규칙이 본 값)가 먼저, 저장된 문장이 그다음.
                 ⚠️ `선정 사유` 제목은 걷어냈다(2026-08-11). 이 패널이 사는 곳이 이미
                    `줄이는 쪽`/`담는 쪽` 제목 아래라, 여기 적히는 것이 선정 사유라는 건
                    자리가 이미 말한다 — 제목이 한 겹 더 서면 창 안에 구역이 또 생긴다.
                    구분은 위 여백이 한다(`.watch-panel .holdings + *`). */}
          {/* 항목마다 불릿을 단다 — **저장된 문장들이 나란히 선 목록**이라 줄만 나눠 두면
              한 문단이 접혀 있는 것처럼 읽힌다. `ul`인 것이 그대로 그 말이다(모양 이전에
              구조가 목록이다 · 낭독기도 "목록 4개 항목"으로 읽는다). */}
          <ul className="watch-reasons">
            {/* **무엇의 기한인지 적는다**(2026-08-11). `기한 6개월 이내`는 무엇이 6개월인지
                말하지 않았다 — 원본 필드가 `scenario.horizon`("자금이 필요한 시점")이라
                그 뜻을 그대로 옮긴다. 화면이 새로 판단해 붙인 말이 아니다.
                급한지 아닌지는 **굵기**가 말한다(`is-urgent` · `lead.urgent_horizons`).
                ⚠️ 성향 꼬리표는 여기서 뺐다 — 바로 위 계좌 줄이 이미
                   `공격투자형 → 위험중립형`으로 같은 말을 하고 있어서, 두 번 적으면
                   어느 쪽이 지금 값인지가 오히려 흐려진다.
                   **딸려 나간 것**: 기한이 급하지 않은데 성향 격차로 줄이는 쪽에 선 사람은
                   이 자리에 이유가 적히지 않는다. 그 사람의 근거는 계좌 줄의 `→` 하나다. */}
            {r.horizon && (
              <li className={r.urgent ? 'is-urgent' : ''}>
                자금 필요 시점 {r.horizon}
              </li>
            )}
            {/* 상황과 사유는 **저장된 문장들**이라 항목을 나눈다. 이어 붙이지 않는 이유는
                그렇게 만든 한 문장이 어느 쪽에도 없는 화면의 말이 되기 때문이다. */}
            {situationLines(r.situation).map((s) => (
              <li key={s}>{s}</li>
            ))}
            {r.why && <li>{r.why}</li>}
          </ul>
        </div>
      )}
    </li>
  );
}
