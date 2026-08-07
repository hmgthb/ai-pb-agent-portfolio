"""브리프 1건을 실데이터로 만들어 DB에 넣는다 — 화면 작업·검증용 시드.

⚠️ **이 스크립트는 이제 `POST /api/briefs/run`과 같은 일을 한다**(2026-08-07). 브리핑이
거시 전용이 되면서 파이프라인에서 LLM이 통째로 빠졌기 때문이다 — 예전에는 진짜 F2가 O를
거쳐 a1·a4에게 위임했고, 크레딧 없이 화면을 보려고 여기서 MCP 도구를 직접 불러 **파이프라인을
베껴 갖고 있었다.** 베낀 쪽이 없어졌으니 규칙이 갈릴 자리도 없어졌다(`main.build_brief`).

그래서 남은 쓸모는 하나다: **웹 서버 없이 DB에 브리프를 한 건 넣고 싶을 때.**
그 밖에는 `POST /api/briefs/run`을 때리는 게 낫다(같은 함수를 부른다).

실행: DATABASE_URL=postgresql://app:app@localhost:5432/app \
      backend/.venv/bin/python -m backend.scripts.seed_brief
"""

import asyncio

from backend import db
from backend.main import build_brief


async def main() -> None:
    await db.init_pool()
    result = await build_brief()
    await db.close_pool()

    market = result["market"]
    if market["note"]:
        print(f"지수: {market['note']}")
    for ix in market["indices"]:
        print(f"  {ix['index_name']} {ix['close']} ({ix['change_pct']}%) · {ix['as_of']}")
    for b in result["lead"]["bullets"]:
        print(f"  · {b['text']}")

    print(f"\n브리프 #{result['id']} 저장 완료")
    violations = result["violations"]
    print("게이트:", "통과" if not violations else f"위반 {violations}")


if __name__ == "__main__":
    asyncio.run(main())
