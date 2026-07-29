"""고객 50명의 보유 종목(holdings)을 새 유니버스로 갈아끼우는 UPDATE SQL을 만든다.

**왜 지우고 다시 만들지 않는가** — `restore_pb_sessions.sql`이 `customer_id` 1~44를
하드코딩하고 있고, 앱에는 `pb_sessions` 생성 경로가 아예 없다(HANDOFF §2). 고객을 새 id로
다시 만들면 고객 문의 큐를 되살릴 방법이 영구히 사라진다. 그래서 **id·이름·나이·계좌·성향·
잔고·수익률·자산배분은 건드리지 않고** `holdings`와 `flag_reasons`만 갱신한다.

**바꾸지 않는 것이 규칙을 지킨다:**
  - `alloc`을 그대로 두므로 mismatch 플래그가 변하지 않는다.
  - `return_pct`를 그대로 두므로 loss 플래그가 변하지 않는다.
  - 각 고객의 **보유 금액 배열을 그대로 재사용**하므로 집중도 비율(conc %)도 변하지 않는다.
    바뀌는 건 그 자리에 앉는 **종목명**뿐이다.

**왜 종목만 바꾸는가** — 시드가 2021년식 대형주 나열이라 방산·조선·원전·2차전지 셀·바이오
대장이 통째로 빠져 있었다. 카카오(시총 15.8조)를 17명이 들고 있는데 LG에너지솔루션(73.5조)·
삼성바이오로직스(71.7조)는 유니버스에 없었다. 전 종목 DART 법인 존재 + KRX 시세 조회를
확인했다(2026-07-29).

출력은 SQL이고 DB에 직접 쓰지 않는다 — 되돌릴 수 없는 조작은 사람이 실행한다.

실행:
    docker compose exec -T backend python /repo/backend/scripts/reseed_holdings.py > /tmp/reseed.sql
"""

import asyncio
import json
import os
import sys

import asyncpg
import dotenv

# 위험성향 라벨 — f1.RISK_LABELS와 **같은 순서여야 한다**(어긋나면 플래그 문구가 거짓말한다).
RISK_LABELS = ["안정형", "안정추구형", "위험중립형", "적극투자형", "공격투자형"]

# 새 유니버스 12종목과 **목표 보유 고객 수**. 합이 현재 보유 슬롯 총수(163)와 같아야 한다.
#
# 상위 3종목이 브리핑 유니버스가 된다(`main.pb_watchlist` → 보유 고객 수 상위 N,
# `BRIEF_MAX_STOCKS=3`). 삼성전자(23)·SK하이닉스(21)·한화에어로스페이스(18)로 정했고,
# 4위(14)와 벌어져 있어 동수 tie-break에 걸리지 않는다.
#
# ⚠️ 순서가 곧 우선순위다(할당이 남은 쿼터가 많은 것부터 집는다). 종목을 갈아끼울 때는
#    `f1.ALIASES`와 `main.FALLBACK_WATCHLIST`도 같이 본다.
UNIVERSE: list[tuple[str, str, int]] = [
    ("005930", "삼성전자", 23),
    ("000660", "SK하이닉스", 21),
    ("012450", "한화에어로스페이스", 18),
    ("207940", "삼성바이오로직스", 14),
    ("373220", "LG에너지솔루션", 13),
    ("105560", "KB금융", 13),
    ("005380", "현대차", 12),
    ("329180", "HD현대중공업", 11),
    ("034020", "두산에너빌리티", 11),
    ("000270", "기아", 10),
    ("035420", "NAVER", 9),
    ("267260", "HD현대일렉트릭", 8),
]


def fmt_pct(v: float) -> str:
    """수익률 표기. 정수면 소수점을 떼는 게 기존 시드 문구와 같다("-7% 손실")."""
    return str(int(v)) if float(v).is_integer() else str(v)


def flag_reasons(risk: int, equity_pct: int, ret: float, holdings: list[dict]) -> list[dict]:
    """위험 플래그 규칙 3종. 기존 시드 15명의 저장값에서 역산해 임계값을 맞췄다.

    ⚠️ 이 함수는 **시드 생성 전용**이다. 런타임은 규칙을 다시 계산하지 않고 저장된
       `flag_reasons`를 그대로 인용한다(`f1.portfolio_facts`) — 같은 규칙을 두 곳에서
       구현하면 화면의 ⚑와 답변의 서술이 언젠가 갈라진다.

    배열 순서는 mismatch → conc → loss다(기존 시드 id=26·21·30에서 확인).
    """
    out = []
    # ① 성향 대비 주식 과다: 안정형(0)·안정추구형(1)인데 국내주식 > 40%
    if risk <= 1 and equity_pct > 40:
        out.append({
            "key": "mismatch",
            "text": f"{RISK_LABELS[risk]} 성향 대비 주식 비중 {equity_pct}%",
        })
    # ② 단일종목 집중: 보유주식 합계 대비 최대 종목 ≥ 65%
    total = sum(h["amt"] for h in holdings)
    if total:
        top = max(holdings, key=lambda h: h["amt"])
        pct = round(top["amt"] / total * 100)
        if pct >= 65:
            out.append({"key": "conc", "text": f"보유주식 내 {top['name']} 집중 {pct}%"})
    # ③ 손실: 연초 대비 -5% 이하
    if ret <= -5:
        out.append({"key": "loss", "text": f"연초 대비 {fmt_pct(ret)}% 손실"})
    return out


def assign(rows: list[dict]) -> dict[int, list[dict]]:
    """고객별 새 보유 종목을 정한다 — 난수 없이 결정론적이다(같은 입력 → 같은 출력).

    남은 쿼터가 많은 종목부터 집되 한 고객이 같은 종목을 두 번 갖지 않게 한다. 쿼터가
    depleting되면서 자연히 순환하므로 목표 보유 고객 수를 정확히 맞춘다.

    **금액이 큰 자리에 인기 종목을 앉힌다** — 보유 고객 수가 동수일 때 `pb_watchlist`가
    보유금액 합계로 tie-break하므로, 둘이 같은 방향이어야 순위가 흔들리지 않는다.
    """
    quota = {code: n for code, _, n in UNIVERSE}
    order = {code: i for i, (code, _, _) in enumerate(UNIVERSE)}
    names = {code: nm for code, nm, _ in UNIVERSE}
    result: dict[int, list[dict]] = {}

    for row in rows:
        amts = sorted((h["amt"] for h in row["holdings"]), reverse=True)
        # 남은 쿼터 내림차순, 동수면 UNIVERSE 순서
        picks = sorted(quota, key=lambda c: (-quota[c], order[c]))[: len(amts)]
        if len(picks) < len(amts):  # 쿼터가 말라 12종목으로 부족한 경우(발생하지 않아야 한다)
            raise RuntimeError(f"고객 {row['id']}: 배정 가능한 종목이 부족하다")
        for c in picks:
            quota[c] -= 1
        # picks는 이미 인기 순, amts는 금액 내림차순 → 큰 금액에 인기 종목이 간다
        result[row["id"]] = [
            {"amt": a, "code": c, "name": names[c]} for c, a in zip(picks, amts)
        ]

    left = {c: q for c, q in quota.items() if q}
    if left:
        raise RuntimeError(f"쿼터가 남았다(목표 합계가 보유 슬롯 수와 다르다): {left}")
    return result


async def load() -> list[dict]:
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    try:
        recs = await conn.fetch(
            "SELECT id, risk_profile, return_pct, alloc, holdings"
            " FROM pb_customers ORDER BY id"
        )
    finally:
        await conn.close()
    return [
        {
            "id": r["id"],
            "risk": r["risk_profile"],
            "ret": r["return_pct"],
            # asyncpg는 jsonb를 문자열로 준다(코덱을 안 걸었을 때)
            "alloc": r["alloc"] if isinstance(r["alloc"], dict) else json.loads(r["alloc"]),
            "holdings": (
                r["holdings"] if isinstance(r["holdings"], list) else json.loads(r["holdings"])
            ),
        }
        for r in recs
    ]


def main() -> None:
    dotenv.load_dotenv(dotenv_path="/repo/.env")
    rows = asyncio.run(load())

    slots = sum(len(r["holdings"]) for r in rows)
    target = sum(n for _, _, n in UNIVERSE)
    if slots != target:
        sys.exit(f"보유 슬롯 {slots}개인데 목표 합계는 {target}개다 — UNIVERSE 쿼터를 맞춰라")

    new = assign(rows)

    print("-- 고객 보유 종목 재배정 (backend/scripts/reseed_holdings.py 생성)")
    print(f"-- 유니버스 12종목 · 보유 슬롯 {slots}개 · id/이름/계좌/잔고/배분은 건드리지 않는다")
    print("BEGIN;")
    for row in rows:
        holdings = new[row["id"]]
        flags = flag_reasons(
            row["risk"], int(row["alloc"]["국내주식"]), row["ret"], holdings
        )
        h_json = json.dumps(holdings, ensure_ascii=False).replace("'", "''")
        f_json = json.dumps(flags, ensure_ascii=False).replace("'", "''")
        print(
            f"UPDATE pb_customers SET holdings = '{h_json}'::jsonb,"
            f" flag_reasons = '{f_json}'::jsonb WHERE id = {row['id']};"
        )
    print("COMMIT;")


if __name__ == "__main__":
    main()
