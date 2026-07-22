"""F1 대화상태 저장소 — Redis에 대화별 최근 턴을 담아 멀티턴을 가능케 한다.

왜 Redis인가: 대화 맥락은 **휘발성·짧은 수명**이라 Postgres(감사·발행 기록)와 성격이 다르다.
TTL로 자동 만료되고, 여러 백엔드 인스턴스가 세션을 공유할 수 있다. 인프라(redis)는 이미
docker-compose에 있고 REDIS_URL로 주입된다.

저장하는 것은 **라우팅에 필요한 최소 맥락**뿐이다 — 직전 종목(이어받기용)과 최근 턴 요약.
답변 본문·도구 결과는 담지 않는다(답변은 매 턴 현재 데이터로만 생성 — 가드레일 3, 턴을
넘나들며 지어내지 못하게).
"""

import json
import os

import redis.asyncio as redis

_REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/0")
_TTL_SECONDS = 60 * 60  # 대화 맥락은 1시간 뒤 만료 — 오래된 종목을 잘못 이어받지 않게
_MAX_TURNS = 8  # 최근 턴만 유지(무한 성장 방지)
_KEY = "f1:session:{sid}"

_client: redis.Redis | None = None


def _redis() -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.from_url(_REDIS_URL, decode_responses=True)
    return _client


async def get_context(session_id: str) -> dict:
    """{"turns": [...], "last_entity": {"code","name"}|None}. 없으면 빈 맥락."""
    raw = await _redis().get(_KEY.format(sid=session_id))
    if not raw:
        return {"turns": [], "last_entity": None}
    try:
        ctx = json.loads(raw)
    except json.JSONDecodeError:
        return {"turns": [], "last_entity": None}
    ctx.setdefault("turns", [])
    ctx.setdefault("last_entity", None)
    return ctx


async def append_turn(session_id: str, turn: dict) -> None:
    """턴 하나(질문·라우팅 결과)를 붙이고 last_entity를 갱신한다. TTL을 매번 연장한다.

    turn: {"q": ..., "agent": ..., "intent": ..., "entity_code": ..., "entity_name": ...}
    """
    ctx = await get_context(session_id)
    ctx["turns"] = (ctx["turns"] + [turn])[-_MAX_TURNS:]
    if turn.get("entity_code"):
        ctx["last_entity"] = {"code": turn["entity_code"], "name": turn.get("entity_name")}
    await _redis().set(
        _KEY.format(sid=session_id), json.dumps(ctx, ensure_ascii=False), ex=_TTL_SECONDS
    )


async def close() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
