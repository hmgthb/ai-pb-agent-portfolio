"""노트(초안→검토→심의→발행) 상태와 감사로그를 담는 Postgres 접근 계층.

# ponytail: 스키마 변경이 잦아지기 전까지는 마이그레이션 도구 없이 멱등(idempotent) DDL
# 한 덩어리로 충분하다 — Alembic 등은 스키마 churn이 실제로 생기면 그때 도입.
"""

import json
import os
from datetime import datetime, timezone

import asyncpg

# 아래 집계 쿼리의 "오늘"은 UTC가 아니라 사용자의 영업일이다 — 정본은 backend/bizdate.py.
from backend.bizdate import biz_date_sql as _biz_date

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

-- 누가 만든 노트인가. PB도 F3로 노트를 만들 수 있는데(생성은 PB, 발행은 준법) 생성자가
-- 없으면 **만든 사람이 자기 노트를 처리 대기에서 찾을 수 없다**. 나중에 붙은 컬럼이라
-- 멱등 ALTER로 더한다 — 이전에 만들어진 노트는 NULL(생성자 미상)이고, 지어내지 않는다.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS created_by TEXT;

-- 미인용 문장 확인 기록. 각주를 붙일 수 없는 문장(해석·고지·데이터 설명)이 게이트를 잠그면
-- 사람이 열 방법이 없어서, 준법이 사유를 적어 확인한 문장을 여기 남긴다.
-- [{"index": 3, "reason": "해석·전망", "actor": "정준법", "ts": "...", "text": "앞 60자"}]
-- text를 같이 두는 이유: 재파싱(scripts/reparse_notes.py)으로 문장 배열이 바뀌면 인덱스가
-- 다른 문장을 가리킬 수 있다 — 발행 때 원문과 대조해 안 맞으면 그 확인은 무효로 본다.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS acks_json JSONB NOT NULL DEFAULT '[]';

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

-- F2 상담 전 브리핑. 노트(검토→심의→발행)와 달리 내부 참고용이라 승인 흐름이 없고,
-- 배치 실행마다 한 행씩 쌓인다.
CREATE TABLE IF NOT EXISTS briefs (
    id SERIAL PRIMARY KEY,
    brief_date DATE NOT NULL,
    content_md TEXT NOT NULL,
    items_json JSONB NOT NULL,
    sentences_json JSONB NOT NULL,
    violations_json JSONB NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 대시보드(관리자/PB 콘솔)용. 고객·상담은 대고객 AI PB 프로토타입의 목업 데이터이며
-- 시드는 backend/scripts/seed_pb.py가 넣는다 — 여기서는 스키마만 보장한다.
-- 시장 현황(지수)은 브리프보다 나중에 붙었다 — 이미 쌓인 행이 있어도 되도록 멱등 ALTER로
-- 더한다. {"indices": [...], "note": "미연결 사유"} 형태이며, 못 가져왔으면 사유가 남는다.
ALTER TABLE briefs ADD COLUMN IF NOT EXISTS market_json JSONB NOT NULL DEFAULT '{}';

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
    # 폐기(보류됨)에는 담당자 칸이 없다 — notes에 컬럼이 없고, 만들 이유도 없다.
    # 누가 언제 왜 버렸는지는 감사로그가 남긴다(append-only라 그쪽이 정본이다).
    "rejected": None,
}

# 더 처리할 게 없는 상태 — 큐·대기 집계에서 뺀다. 발행(끝까지 감)과 폐기(중간에 버림)는
# 도착 경로가 반대지만 "처리 대기 목록에 남으면 안 된다"는 점에서 같다.
# ⚠️ 여기 넣은 상태는 `/api/notes` 색인에는 **그대로 남는다** — 읽을 것의 목록과
#    처리할 일의 목록은 다르다(HANDOFF §2).
NOTE_TERMINAL = ("published", "rejected")


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
    created_by: str | None = None,
) -> int:
    """`created_by`는 화면이 알려준 실행자다 — 없으면 NULL로 두고 추측하지 않는다."""
    row = await pool().fetchrow(
        """INSERT INTO notes
               (stock_code, corp_name, content_md, sentences_json, violations_json, created_by)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6) RETURNING id""",
        stock_code,
        corp_name,
        content_md,
        json.dumps(sentences, ensure_ascii=False),
        json.dumps(violations, ensure_ascii=False),
        created_by,
    )
    return row["id"]


async def get_note(note_id: int) -> asyncpg.Record | None:
    return await pool().fetchrow("SELECT * FROM notes WHERE id = $1", note_id)


async def set_note_ack(
    note_id: int, index: int, reason: str | None, actor: str, text: str
) -> list[dict]:
    """미인용 문장 확인을 남기거나(reason) 지운다(reason=None). 갱신된 전체 목록을 준다.

    한 문장에 하나만 남는다 — 같은 인덱스를 다시 확인하면 사유·확인자가 덮어써진다.
    (되돌린 이력이 필요하면 감사로그를 본다. 이 컬럼은 '지금 상태'만 든다.)
    """
    row = await pool().fetchrow("SELECT acks_json FROM notes WHERE id = $1", note_id)
    acks = [a for a in json.loads(row["acks_json"]) if a.get("index") != index]
    if reason is not None:
        acks.append(
            {
                "index": index,
                "reason": reason,
                "actor": actor,
                "ts": datetime.now(timezone.utc).isoformat(),
                "text": text[:60],
            }
        )
    acks.sort(key=lambda a: a["index"])
    await pool().execute(
        "UPDATE notes SET acks_json = $2::jsonb, updated_at = now() WHERE id = $1",
        note_id,
        json.dumps(acks, ensure_ascii=False),
    )
    return acks


async def advance_status(
    note_id: int,
    status: str,
    actor: str | None,
    violations: list[str] | None = None,
    *,
    record_actor: bool = True,
) -> None:
    """검토/심의/발행 단계 전이. violations가 주어지면(발행 시점 게이트 재평가) 같이 갱신한다.

    `record_actor=False`는 **되돌리는 전이**용이다(준법 반려 → 검토중, PB 폐기 → 보류됨).
    앞으로 갈 때만 "이 단계를 누가 맡았나"를 노트에 새긴다 — 반려로 검토중에 돌아왔다고
    `reviewer`를 준법 이름으로 덮어쓰면 **사실을 확인한 PB가 노트에서 사라진다.**
    되돌린 사람이 누구인지는 감사로그가 남기고, 그게 정본이다.

    ⚠️ `STATUS_ACTOR_FIELD[status]`는 그대로 인덱싱한다(`.get()` 아님) — 정의되지 않은
       상태로 전이하려 하면 조용히 통과시키지 말고 KeyError로 죽는 편이 낫다.
    """
    field = STATUS_ACTOR_FIELD[status] if record_actor else None
    sets = ["status = $2", "updated_at = now()"]
    params: list = [note_id, status]
    if field:
        params.append(actor)
        sets.append(f"{field} = ${len(params)}")
    if violations is not None:
        params.append(json.dumps(violations, ensure_ascii=False))
        sets.append(f"violations_json = ${len(params)}::jsonb")
    await pool().execute(f"UPDATE notes SET {', '.join(sets)} WHERE id = $1", *params)


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


async def create_brief(
    brief_date,
    content_md: str,
    items: list[dict],
    sentences: list[dict],
    violations: list[str],
    market: dict | None = None,
) -> int:
    row = await pool().fetchrow(
        """INSERT INTO briefs
             (brief_date, content_md, items_json, sentences_json, violations_json, market_json)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb) RETURNING id""",
        brief_date,
        content_md,
        json.dumps(items, ensure_ascii=False),
        json.dumps(sentences, ensure_ascii=False),
        json.dumps(violations, ensure_ascii=False),
        json.dumps(market or {}, ensure_ascii=False),
    )
    return row["id"]


async def latest_brief() -> asyncpg.Record | None:
    return await pool().fetchrow("SELECT * FROM briefs ORDER BY id DESC LIMIT 1")


# --- 대시보드 조회 --------------------------------------------------------
# 모든 수치는 실제 테이블에서 집계한다. 데이터가 없으면 0을 반환하고 그럴듯한 값을
# 지어내지 않는다 (가드레일 3: 확인할 수 없는 수치를 임의로 채우지 않는다).


# pb 인자는 "이 PB의 담당 고객만"으로 좁히는 축이다 — 시드에는 3명의 PB가 들어 있지만
# 이 제품은 PB 1인용 대시보드이므로(main.PB_NAME) 남의 고객은 조회 단계에서 빠진다.
# None이면 전사 — 지금은 쓰는 곳이 없지만 집계·이관 같은 감독 용도를 위해 남겨 둔다.
async def list_customers(pb: str | None = None) -> list[asyncpg.Record]:
    if pb is None:
        return await pool().fetch("SELECT * FROM pb_customers ORDER BY id")
    return await pool().fetch(
        "SELECT * FROM pb_customers WHERE pb = $1 ORDER BY id", pb
    )


async def get_customer(customer_id: int) -> asyncpg.Record | None:
    return await pool().fetchrow("SELECT * FROM pb_customers WHERE id = $1", customer_id)


async def list_sessions(pb: str | None = None) -> list[asyncpg.Record]:
    if pb is None:
        return await pool().fetch(
            """SELECT s.*, c.name AS customer_name, c.pb, c.account_no
               FROM pb_sessions s JOIN pb_customers c ON c.id = s.customer_id
               ORDER BY s.started_at DESC"""
        )
    return await pool().fetch(
        """SELECT s.*, c.name AS customer_name, c.pb, c.account_no
           FROM pb_sessions s JOIN pb_customers c ON c.id = s.customer_id
           WHERE c.pb = $1
           ORDER BY s.started_at DESC""",
        pb,
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
        " reviewer, deliberator, publisher, created_by, created_at, updated_at"
        " FROM notes ORDER BY id DESC"
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


async def today_activity() -> asyncpg.Record:
    """오늘 에이전트가 실제로 한 일 — 훅이 남긴 감사로그에서만 센다.

    화면의 "AI가 오늘 한 일" 줄이 쓴다. 프론트에서 audit 목록을 세지 않는 이유는
    그 API가 최근 N건만 주기 때문이다(도구호출이 하루 수백 건이라 조용히 적게 세인다).
    """
    return await pool().fetchrow(
        f"""SELECT
             count(*) FILTER (WHERE event_type = 'tool_use_start') AS tool_calls,
             count(DISTINCT detail->>'agent_type')
               FILTER (WHERE event_type = 'tool_use_start'
                         AND detail->>'agent_type' IS NOT NULL) AS agents,
             count(*) FILTER (WHERE event_type = 'brief_created') AS briefs,
             count(*) FILTER (WHERE event_type = 'note_created') AS notes,
             count(*) FILTER (WHERE event_type = 'chat_answered') AS chats,
             max(ts) FILTER (WHERE event_type = 'tool_use_start') AS last_run
           FROM audit_log WHERE {_biz_date('ts')} = {_biz_date('now()')}"""
    )


async def gate_blocks_daily(days: int) -> list[asyncpg.Record]:
    """최근 N일 게이트 차단 건수(발행 시도가 막힌 날). 0건인 날도 행으로 채워 반환한다."""
    return await pool().fetch(
        f"""SELECT d::date AS day, count(a.id) AS blocks
           FROM generate_series({_biz_date('now()')} - ($1::int - 1),
                                {_biz_date('now()')}, '1 day') d
           LEFT JOIN audit_log a
             ON a.event_type = 'publish_blocked' AND {_biz_date('a.ts')} = d::date
           GROUP BY d ORDER BY d""",
        days,
    )
