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

-- 대시보드(관리자/PB 콘솔)용. 고객·상담은 대고객 AI PB 프로토타입의 목업 데이터이며
-- 시드는 backend/scripts/seed_pb.py가 넣는다 — 여기서는 스키마만 보장한다.
CREATE TABLE IF NOT EXISTS pb_customers (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    age INTEGER NOT NULL,
    account_no TEXT NOT NULL,
    pb TEXT NOT NULL,
    risk_profile INTEGER NOT NULL,
    balance BIGINT NOT NULL,
    return_pct DOUBLE PRECISION NOT NULL,
    holdings JSONB NOT NULL,
    alloc JSONB NOT NULL,
    diagnosis TEXT NOT NULL,
    flag_reasons JSONB NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS pb_sessions (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES pb_customers(id),
    status TEXT NOT NULL,
    topic TEXT NOT NULL,
    question TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
"""

# 상담 세션은 승인/반려로 한 번만 결정된다 — 이미 결정된 건의 재결정은 409로 막는다.
SESSION_PENDING = "pending"
SESSION_DECIDED = ("done", "rejected")

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


# --- 대시보드 조회 --------------------------------------------------------
# 모든 수치는 실제 테이블에서 집계한다. 데이터가 없으면 0을 반환하고 그럴듯한 값을
# 지어내지 않는다 (가드레일 3: 확인할 수 없는 수치를 임의로 채우지 않는다).


async def list_customers() -> list[asyncpg.Record]:
    return await pool().fetch("SELECT * FROM pb_customers ORDER BY id")


async def get_customer(customer_id: int) -> asyncpg.Record | None:
    return await pool().fetchrow("SELECT * FROM pb_customers WHERE id = $1", customer_id)


async def list_sessions() -> list[asyncpg.Record]:
    return await pool().fetch(
        """SELECT s.*, c.name AS customer_name, c.pb, c.account_no
           FROM pb_sessions s JOIN pb_customers c ON c.id = s.customer_id
           ORDER BY s.started_at DESC"""
    )


async def get_session(session_id: int) -> asyncpg.Record | None:
    return await pool().fetchrow("SELECT * FROM pb_sessions WHERE id = $1", session_id)


async def set_session_status(session_id: int, status: str) -> None:
    await pool().execute(
        "UPDATE pb_sessions SET status = $2, updated_at = now() WHERE id = $1",
        session_id,
        status,
    )


async def list_notes() -> list[asyncpg.Record]:
    return await pool().fetch(
        "SELECT id, stock_code, corp_name, status, sentences_json, violations_json,"
        " reviewer, deliberator, publisher, created_at, updated_at FROM notes ORDER BY id DESC"
    )


async def recent_audit(limit: int) -> list[asyncpg.Record]:
    return await pool().fetch(
        "SELECT * FROM audit_log ORDER BY id DESC LIMIT $1", limit
    )


async def agent_call_counts() -> list[asyncpg.Record]:
    """감사로그의 tool_use_start에서 에이전트별 도구호출 수를 센다 — 훅이 남긴 실제 흔적."""
    return await pool().fetch(
        """SELECT COALESCE(detail->>'agent_type', 'O') AS agent, count(*) AS calls
           FROM audit_log WHERE event_type = 'tool_use_start'
           GROUP BY 1 ORDER BY calls DESC"""
    )


async def gate_blocks_daily(days: int) -> list[asyncpg.Record]:
    """최근 N일 게이트 차단 건수(발행 시도가 막힌 날). 0건인 날도 행으로 채워 반환한다."""
    return await pool().fetch(
        """SELECT d::date AS day, count(a.id) AS blocks
           FROM generate_series(now()::date - ($1::int - 1), now()::date, '1 day') d
           LEFT JOIN audit_log a
             ON a.event_type = 'publish_blocked' AND a.ts::date = d::date
           GROUP BY d ORDER BY d""",
        days,
    )
