"""session_store 통합 점검 — 실제 Redis에 붙어 저장·이어받기·TTL을 확인한다.

자체 점검 스위트(네트워크 불필요)와 달리 이건 Redis가 떠 있어야 한다.
실행: REDIS_URL=redis://localhost:6379/0 backend/.venv/bin/python -m backend.scripts.session_store_check
"""

import asyncio
import uuid

from backend import session_store


async def main() -> None:
    sid = f"test-{uuid.uuid4().hex[:8]}"

    # 빈 세션
    ctx = await session_store.get_context(sid)
    assert ctx == {"turns": [], "last_entity": None}, ctx

    # 종목 있는 턴 → last_entity 갱신
    await session_store.append_turn(sid, {
        "q": "삼성전자 실적?", "agent": "a2", "intent": "financials",
        "entity_code": "005930", "entity_name": "삼성전자",
    })
    ctx = await session_store.get_context(sid)
    assert ctx["last_entity"] == {"code": "005930", "name": "삼성전자"}, ctx
    assert len(ctx["turns"]) == 1

    # 종목 없는 후속 턴 → last_entity는 그대로 유지(이어받기 소스)
    await session_store.append_turn(sid, {
        "q": "관련 뉴스는?", "agent": "a4", "intent": "news",
        "entity_code": "005930", "entity_name": "삼성전자",  # 라우터가 이어받아 채운 값
    })
    ctx = await session_store.get_context(sid)
    assert ctx["last_entity"]["code"] == "005930"
    assert len(ctx["turns"]) == 2

    # 새 종목 턴 → last_entity 교체
    await session_store.append_turn(sid, {
        "q": "SK하이닉스는?", "agent": "a2", "intent": "financials",
        "entity_code": "000660", "entity_name": "SK하이닉스",
    })
    ctx = await session_store.get_context(sid)
    assert ctx["last_entity"] == {"code": "000660", "name": "SK하이닉스"}, ctx

    # 최근 턴 상한(_MAX_TURNS=8) — 12턴 넣어도 8개만 남는다
    for i in range(12):
        await session_store.append_turn(sid, {"q": f"q{i}", "agent": "a2", "intent": "financials",
                                              "entity_code": "005930", "entity_name": "삼성전자"})
    ctx = await session_store.get_context(sid)
    assert len(ctx["turns"]) == 8, len(ctx["turns"])

    # 없는 세션은 빈 맥락
    assert (await session_store.get_context("nope-nope"))["last_entity"] is None

    await session_store._redis().delete(session_store._KEY.format(sid=sid))
    await session_store.close()
    print("ok")


if __name__ == "__main__":
    asyncio.run(main())
