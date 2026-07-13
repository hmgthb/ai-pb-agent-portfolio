"""노트(초안→검토→심의→발행) 상태와 감사로그를 담는 Postgres 접근 계층.

# ponytail: 스키마 변경이 잦아지기 전까지는 마이그레이션 도구 없이 멱등(idempotent) DDL
# 한 덩어리로 충분하다 — Alembic 등은 스키마 churn이 실제로 생기면 그때 도입.
"""

import json
import os

import asyncpg

_pool: asyncpg.Pool | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS notes (
    id SERIAL PRIMARY KEY,
    stock_code TEXT NOT NULL,
    corp_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    content_md TEXT NOT NULL,
    sentences_json JSONB NOT NULL,
    violations_json JSONB NOT NULL DEFAULT '[]',
    reviewer TEXT,
    deliberator TEXT,
    publisher TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- append-only: 애플리케이션 코드에서 UPDATE/DELETE 하지 않는다
-- (강제하는 DB 트리거·권한 분리는 MVP 스코프 밖 — 운영 전환 시 추가할 것).
CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    event_type TEXT NOT NULL,
    note_id INTEGER,
    actor TEXT,
    detail JSONB NOT NULL DEFAULT '{}'
);
"""

STATUS_ACTOR_FIELD = {
    "review": "reviewer",
    "deliberation": "deliberator",
    "published": "publisher",
}


async def init_pool() -> None:
    global _pool
    _pool = await asyncpg.create_pool(os.environ["DATABASE_URL"])
    async with _pool.acquire() as conn:
        await conn.execute(SCHEMA)


async def close_pool() -> None:
    if _pool is not None:
        await _pool.close()


def pool() -> asyncpg.Pool:
    assert _pool is not None, "DB pool이 초기화되지 않았습니다 (init_pool 먼저 호출)"
    return _pool


async def create_note(
    stock_code: str,
    corp_name: str,
    content_md: str,
    sentences: list[dict],
    violations: list[str],
) -> int:
    row = await pool().fetchrow(
        """INSERT INTO notes (stock_code, corp_name, content_md, sentences_json, violations_json)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb) RETURNING id""",
        stock_code,
        corp_name,
        content_md,
        json.dumps(sentences, ensure_ascii=False),
        json.dumps(violations, ensure_ascii=False),
    )
    return row["id"]


async def get_note(note_id: int) -> asyncpg.Record | None:
    return await pool().fetchrow("SELECT * FROM notes WHERE id = $1", note_id)


async def advance_status(
    note_id: int, status: str, actor: str | None, violations: list[str] | None = None
) -> None:
    """검토/심의/발행 단계 전이. violations가 주어지면(발행 시점 게이트 재평가) 같이 갱신한다."""
    actor_field = STATUS_ACTOR_FIELD[status]
    if violations is None:
        await pool().execute(
            f"UPDATE notes SET status = $2, {actor_field} = $3, updated_at = now() WHERE id = $1",
            note_id,
            status,
            actor,
        )
    else:
        await pool().execute(
            f"""UPDATE notes SET status = $2, {actor_field} = $3, violations_json = $4::jsonb,
                updated_at = now() WHERE id = $1""",
            note_id,
            status,
            actor,
            json.dumps(violations, ensure_ascii=False),
        )


async def append_audit(
    event_type: str, note_id: int | None, actor: str | None, detail: dict
) -> None:
    await pool().execute(
        "INSERT INTO audit_log (event_type, note_id, actor, detail) VALUES ($1, $2, $3, $4::jsonb)",
        event_type,
        note_id,
        actor,
        json.dumps(detail, ensure_ascii=False, default=str),
    )


async def get_audit_log(note_id: int) -> list[asyncpg.Record]:
    return await pool().fetch(
        "SELECT * FROM audit_log WHERE note_id = $1 ORDER BY id", note_id
    )
