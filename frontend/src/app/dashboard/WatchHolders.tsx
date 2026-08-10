'use client';

/** 브리핑 「고객 관련 종목」 줄의 **보유 고객 펼치기**(2026-08-10).
 *
 *  접으면 종목의 사실(보유 N명 · 등락)만, 펴면 **누가 왜 걸리는지**를 이름과 함께 낸다.
 *
 *  ⚠️ **이름은 브리프에서 오지 않는다.** 백엔드가 실어 보내는 건 종목코드와 집계뿐이고
 *     (`brief.stock_headline_bullet`의 `stock`), 이름·보유 비중·사정은 여기서
 *     `/api/customers`(PB가 이미 보는 목록)와 **종목코드로 조인**해 붙인다. 그래서
 *     `briefs` 테이블에도 프롬프트에도 고객 식별정보가 남지 않는다(가드레일 1).
 *     ⚠️ 되돌려서 이름을 백엔드 payload에 담지 말 것 — 그 순간 저장소에 PII가 들어간다.
 *  ⚠️ **기한이 급한 순**으로 세운다. 이 줄이 애초에 답하는 질문이 "누구 얘기를 먼저
 *     꺼낼까"라서다 — 보유 비중이 큰 순이 아니다.
 *  ⚠️ 급한지 아닌지의 어휘(`urgent`)는 **백엔드가 실어 보낸 것**을 쓴다
 *     (`lead.urgent_horizons`). 여기서 목록을 따로 들면 브리핑이 급하다고 센 인원수와
 *     화면이 위에 올린 고객이 갈린다.
 */

import { useState } from 'react';
import { type Customer, type WatchStock } from './types';

/** 펼쳤을 때 한 번에 보이는 인원. 나머지는 `… N명 더`로 접는다 —
 *  21명을 다 늘어놓으면 브리핑 카드가 목록이 된다(요약이 목록이 되는 것을 막는 규칙). */
const VISIBLE = 5;

type Row = {
  id: number;
  name: string;
  /** 그 고객의 **보유주식 내** 비중. 없으면 null(지어내지 않는다). */
  pct: number | null;
  horizon: string | null;
  urgent: boolean;
  /** 투자성향 ≠ 자금성향일 때만 채워진다 — 같으면 적을 것이 없다. */
  risk: { registered: string; effective: string } | null;
};

export function watchRows(
  stock: WatchStock,
  customers: Customer[],
  urgent: string[],
  risks: string[],
): Row[] {
  const urgentSet = new Set(urgent);
  const rows: Row[] = [];
  for (const c of customers) {
    const h = (c.holdings ?? []).find((x) => x.code === stock.code);
    if (!h) continue;
    const sc = c.scenario;
    const horizon = sc?.horizon ?? null;
    const gap =
      sc && sc.registered_risk !== sc.effective_risk
        ? {
            registered: risks[sc.registered_risk] ?? '',
            effective: risks[sc.effective_risk] ?? '',
          }
        : null;
    rows.push({
      id: c.id,
      name: c.name,
      pct: h.pct_of_equity,
      horizon,
      urgent: horizon !== null && urgentSet.has(horizon),
      risk: gap,
    });
  }
  /* 기한 급한 순 → 성향 격차 있는 순 → 비중 큰 순 → id.
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

export default function WatchHolders({
  stock,
  customers,
  urgentHorizons,
  risks,
  onOpenCustomer,
}: {
  stock: WatchStock;
  customers: Customer[];
  urgentHorizons: string[];
  /** `RISK` 라벨 배열 — 성향 인덱스를 이름으로 바꾼다(화면이 다시 정하지 않는다). */
  risks: string[];
  /** 이름을 누르면 그 고객 카드로 간다. 없으면 이름은 글자로만 선다. */
  onOpenCustomer?: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const rows = watchRows(stock, customers, urgentHorizons, risks);
  const shown = open ? rows.slice(0, VISIBLE) : [];
  const rest = rows.length - shown.length;

  /* 접힌 줄에 적는 건 **종목의 사실**뿐이다. `기한 임박 N명`·`자금성향 보수적 N명`은
     펼친 목록이 이름과 함께 그대로 말하므로 여기서 되풀이하지 않는다. */
  const summary = [
    `보유 ${stock.holders}명`,
    stock.days != null && stock.pct != null
      ? `${stock.days}일 ${stock.pct > 0 ? '+' : ''}${stock.pct.toFixed(1)}%`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="watch-holders">
      <button
        className="watch-toggle"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        /* ⚠️ 인원수를 라벨에 넣는다 — 아이콘만으로는 스크린리더에 "버튼"만 읽힌다. */
        aria-label={
          open
            ? `보유 고객 ${rows.length}명 접기`
            : `보유 고객 ${rows.length}명 펴기`
        }
        title={open ? '접기' : '누가 보유했는지 봅니다'}
      >
        <span>{summary}</span>
        <span className="watch-caret" aria-hidden="true">
          {open ? '⌃' : '⌄'}
        </span>
      </button>
      {open && (
        <ul className="watch-list">
          {shown.map((r) => (
            <li key={r.id}>
              {onOpenCustomer ? (
                <button
                  className="watch-name linklike"
                  onClick={() => onOpenCustomer(r.id)}
                  title={`${r.name} 고객 카드 열기`}
                >
                  {r.name}
                </button>
              ) : (
                <span className="watch-name">{r.name}</span>
              )}
              {r.pct != null && (
                <span className="watch-pct">{r.pct.toFixed(1)}%</span>
              )}
              {r.horizon && (
                <span className={`watch-tag${r.urgent ? ' is-urgent' : ''}`}>
                  기한 {r.horizon}
                </span>
              )}
              {r.risk && (
                <span className="watch-tag">
                  자금성향 {r.risk.effective}
                  <span className="watch-dim"> (투자성향 {r.risk.registered})</span>
                </span>
              )}
            </li>
          ))}
          {rest > 0 && (
            /* ⚠️ **잘린 인원을 말한다.** 조용히 자르면 5명만 보유한 것처럼 읽힌다
                  (0건을 나열하지 않는 것과 반대 방향의 같은 규칙 — 없는 걸 만들지도,
                  있는 걸 감추지도 않는다). */
            <li className="watch-rest">… {rest}명 더</li>
          )}
        </ul>
      )}
    </div>
  );
}
