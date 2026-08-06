"""브리프 1건을 실데이터로 만들어 DB에 넣는다 — 화면 작업·검증용 시드.

⚠️ 이건 F2 파이프라인이 **아니다**. 진짜 F2(`POST /api/briefs/run`)는 O가 a1·a4에게
위임해서 수집하고, 그게 "새 에이전트 0개로 기능이 덧셈으로 붙는다"는 증거다.
여기서는 에이전트(LLM)를 거치지 않고 MCP 도구를 직접 호출한다 — API 크레딧 없이도
대시보드 브리프 카드를 실데이터로 확인하기 위해서다.

데이터 자체는 전부 진짜다(DART 공시·KRX 지연시세). 조립·게이트·저장 경로도 F2와 같다.
다른 것은 "누가 수집했는가" 하나뿐이라, 크레딧이 생기면 이 스크립트는 필요 없다.

실행: DATABASE_URL=postgresql://app:app@localhost:5432/app \
      backend/.venv/bin/python -m backend.scripts.seed_brief
"""

import asyncio
import json
import sys

from backend import bizdate, brief, db, market
from backend.main import (
    MAX_DISCLOSURES_PER_STOCK,
    MAX_NEWS_PER_STOCK,
    holdings_index,
    pb_watchlist,
)
from backend.mcp_servers.dart_server import dart_search
from backend.mcp_servers.krx_server import krx_quote
from backend.mcp_servers.news_server import news_search


def collect(stock_codes: list[str], holders: dict[str, int]) -> list[dict]:
    items = []
    for code in stock_codes:
        quote = krx_quote(code)
        corp_name = quote["corp_name"]
        items.append(
            {
                "stock_code": code,
                "corp_name": corp_name,
                "holders": holders.get(code, 0),
                "quote": brief.annotate_quote(quote),
                "disclosures": brief.pick_disclosures(
                    dart_search(code, days=7), MAX_DISCLOSURES_PER_STOCK
                ),
                "news": brief.pick_news(
                    news_search(corp_name, display=10), corp_name, MAX_NEWS_PER_STOCK
                ),
            }
        )
        print(
            f"  {corp_name}({code}): 시세 1 · 공시 {len(items[-1]['disclosures'])} · "
            f"뉴스 {len(items[-1]['news'])}"
        )
    return items


async def main() -> None:
    # 종목 선정은 F2와 같은 규칙을 쓴다 — 고객 보유 상위 N(= pb_watchlist). 그래서 DB가
    # 먼저 필요하다.
    await db.init_pool()
    codes = sys.argv[1:] or await pb_watchlist()
    holders, _ = await holdings_index()
    print(f"수집 중 (에이전트 없이 MCP 직접 호출): {', '.join(codes)}")
    items = collect(codes, holders)

    indices, market_note = market.fetch_market_snapshot()
    if market_note:
        print(f"  지수: {market_note}")

    # 어제 대비 새로 생긴 것 — F2 파이프라인과 같은 규칙·같은 기준(오늘 이전 날짜의 브리프).
    today = bizdate.biz_today()
    prev = await db.brief_before(today)
    items = brief.mark_new(items, brief.seen_keys(json.loads(prev["items_json"])) if prev else None)

    content_md, sentences = brief.assemble(items, indices)
    violations = brief.check(content_md, sentences)

    brief_id = await db.create_brief(
        today, content_md, items, sentences, violations,
        {"indices": indices, "note": market_note},
        # ⚠️ 종목 한 줄 요약(LLM)은 붙지 않는다 — 이 스크립트는 크레딧 없이 도는 시드이고,
        #    그래서 종목 줄은 규칙 문장으로만 나온다(F2 본 파이프라인과 다른 유일한 점).
        {"bullets": brief.digest(items, compared=prev is not None,
                                 market_note=market_note)},
    )
    await db.append_audit(
        "brief_created", None, None,
        {"brief_id": brief_id, "stock_codes": codes, "violations": violations, "seed": True},
    )
    await db.close_pool()

    print(f"\n브리프 #{brief_id} 저장 완료 · 문장 {len(sentences)}개")
    print("게이트:", "통과" if not violations else f"위반 {violations}")


if __name__ == "__main__":
    asyncio.run(main())
