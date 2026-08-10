"""노트(검토→심의→발행) 상태와 감사로그를 담는 Postgres 접근 계층.

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
    status TEXT NOT NULL DEFAULT 'review',
    content_md TEXT NOT NULL,
    sentences_json JSONB NOT NULL,
    violations_json JSONB NOT NULL DEFAULT '[]',
    reviewer TEXT,
    deliberator TEXT,
    publisher TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 초안(draft) 단계를 없앴다(2026-08-03). 노트는 **만들어지는 순간 검토중**이다.
-- 예전에는 PB가 `사실 확인`을 눌러야 초안→검토중으로 갔는데, 그 버튼이 하는 일이 상태를
-- 한 칸 옮기는 것뿐이라 화면에 클릭 한 번을 더 세우기만 했다 — 문장 판정(승인·제거)도
-- 확인·보류도 전부 검토중에서 한다. 사람이 실제로 판단하는 지점은 그대로다.
-- ⚠️ `CREATE TABLE IF NOT EXISTS`는 이미 있는 테이블의 DEFAULT를 안 바꾼다 — 따로 고친다.
--    남아 있던 초안도 같이 옮긴다(이 단계가 없어졌으므로 그대로 두면 열어도 버튼이 없다).
ALTER TABLE notes ALTER COLUMN status SET DEFAULT 'review';
UPDATE notes SET status = 'review' WHERE status = 'draft';

-- 누가 만든 노트인가. PB도 F3로 노트를 만들 수 있는데(생성은 PB, 발행은 관리자) 생성자가
-- 없으면 **만든 사람이 자기 노트를 처리 대기에서 찾을 수 없다**. 나중에 붙은 컬럼이라
-- 멱등 ALTER로 더한다 — 이전에 만들어진 노트는 NULL(생성자 미상)이고, 지어내지 않는다.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS created_by TEXT;

-- 미인용 문장 확인 기록. 각주를 붙일 수 없는 문장(해석·고지·데이터 설명)이 게이트를 잠그면
-- 사람이 열 방법이 없어서, 관리자가 사유를 적어 확인한 문장을 여기 남긴다.
-- [{"index": 3, "reason": "해석·전망", "actor": "정준법", "ts": "...", "text": "앞 60자"}]
-- text를 같이 두는 이유: 재파싱(scripts/reparse_notes.py)으로 문장 배열이 바뀌면 인덱스가
-- 다른 문장을 가리킬 수 있다 — 발행 때 원문과 대조해 안 맞으면 그 확인은 무효로 본다.
ALTER TABLE notes ADD COLUMN IF NOT EXISTS acks_json JSONB NOT NULL DEFAULT '[]';

-- PB의 문장 판정. 각주가 없는 문장(UNSOURCED·해석)을 **심의로 올리기 전에** PB가 훑으면서
-- 빼야 할 것(remove)과 그대로 둘 것(approve)을 표시한다. acks_json과 모양은 같지만
-- **다른 사람의 다른 판단**이라 컬럼을 나눈다: 확인(ack)은 관리자가 심의 단계에서 게이트를
-- 여는 조작이고, 이건 PB가 검토 단계에서 남기는 표시라 게이트를 열지 않는다.
-- [{"index": 3, "mark": "remove", "actor": "PB", "ts": "...", "text": "앞 60자"}]
-- text를 같이 두는 이유도 acks_json과 같다(재파싱 후 인덱스 어긋남 대조).
ALTER TABLE notes ADD COLUMN IF NOT EXISTS pb_marks_json JSONB NOT NULL DEFAULT '[]';

-- 금지 표현 예외(waiver). 관리자가 **사유를 직접 적어** 그 문장의 단정 표현
-- 위반을 통과시킨 기록이다(2026-08-06). 확인(ack)·판정(mark)과 같은 모양이지만 **여는 것이
-- 다르다**: ack은 미인용 규칙만, 이건 금지 표현 규칙만 연다. 서로 대신하지 못한다.
-- [{"index": 10, "phrase": "목표주가", "reason": "제3자 목표주가의 사실 보도", ...}]
-- ⚠️ reason이 **자유 입력인 유일한 사유 칸**이다(반려·보류·확인은 고정값). 통과시키는 근거는
--    건마다 달라서 고정값으로 못 적는다는 판단이고, 그 대신 집계는 포기했다.
-- text를 같이 두는 이유는 acks_json과 같다(재파싱 후 인덱스 어긋남 대조).
ALTER TABLE notes ADD COLUMN IF NOT EXISTS waivers_json JSONB NOT NULL DEFAULT '[]';

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

-- 브리핑의 리드(A)와 조용한 날 한 줄(C). 시장 현황과 같은 이유로 멱등 ALTER다.
-- {"lead": {...}|null, "quiet": "..."|null} 형태이며, 둘 다 없을 수 있다(빈 객체).
-- ⚠️ **본문(content_md·sentences)과 따로 두는 것이 설계다.** 리드는 새 사실이 아니라
--    이미 본문에 있는 줄을 가리키는 것이라, 본문에 또 적으면 같은 사실이 두 번 세어져
--    출처 부착률의 분모가 흔들린다(brief.pick_lead 주석).
ALTER TABLE briefs ADD COLUMN IF NOT EXISTS lead_json JSONB NOT NULL DEFAULT '{}';

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

-- 고객의 **상황**(2026-08-07). 계좌 숫자만으로는 안 보이는 것들이 여기 산다: 계좌 밖 자산,
-- 제약(정책·예정 지출), 정리 순서, 최종 목표, 그리고 **투자성향과 다를 수 있는 자금성향**.
-- 투자성향이 공격투자형이어도 반년 뒤 보증금을 치러야 하면 지금 자금성향은 안정형이다 —
-- 그 간극이 상담에서 가장 먼저 확인할 것인데 지금까지 화면 어디에도 없었다.
--
-- ⚠️ **금액을 원 단위로 담지 않는다.** 계좌 밖 자산도 구간(`redact.BALANCE_BANDS`의 어휘)으로만
--    적는다. 이 칸은 F1에서 외부 모델로 나갈 후보라, **저장 시점에 이미 비식별화**돼 있는 편이
--    나중에 가리는 것보다 안전하다(가릴 것이 없으면 못 가려서 새는 일도 없다).
-- ⚠️ **고객 이름을 문장 안에 넣지 않는다** — `compliance.egress_guard`가 담당 고객명을 대조해
--    차단한다. 시나리오를 프롬프트에 실으면 그 검사에 걸려 답변이 통째로 막힌다(막히는 게 맞다).
-- ⚠️ 자유 산문이 아니라 **구조**다(요약 한 줄 + 목록들). 산문으로 두면 규칙이 비식별화할 수
--    없고, 그건 이 저장소에 아직 없는 것이다(HANDOFF §7 — 자유 텍스트 비식별화기).
ALTER TABLE pb_customers ADD COLUMN IF NOT EXISTS scenario JSONB NOT NULL DEFAULT '{}';

-- 상담 히스토리 — 지나간 접점의 기록(2026-08-07). `Next Best Action` 채팅이 "히스토리를
-- 기반으로 투자성향을 분석"하는 근거다. PB가 담당 고객이 많아 각각의 경위를 기억할 수 없다는
-- 것이 이 칸이 있는 이유이고, 그래서 **분석이 아니라 사실만** 담는다.
-- ⚠️ `pb_sessions`(고객 문의 큐)와 **다른 것**이다 — 그쪽은 아직 답하지 않은 문의(처리 대상),
--    이쪽은 지나간 기록(읽을거리)이다. 섞으면 큐가 흐려진다.
-- ⚠️ `scenario`와 같은 규칙: 금액 없음 · 이름 없음 · 판정 없음. `안정형으로 보임` 같은 결론을
--    여기 적으면 모델이 그걸 베껴 쓰고 근거는 사라진다.
ALTER TABLE pb_customers ADD COLUMN IF NOT EXISTS history JSONB NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS pb_sessions (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES pb_customers(id),
    status TEXT NOT NULL,
    topic TEXT NOT NULL,
    question TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 상담 준비 메모(F1). 노트와 달리 **승인 흐름이 없다** — PB가 자기 상담을 위해 인쇄한 것이고
-- 고객에게 나가는 문서가 아니다(그래서 status·reviewer 같은 칸이 없다).
-- 한동안은 아예 저장하지 않고 그 자리에서 만들어 돌려주기만 했는데(2026-08-06), 그러면
-- **어제 만든 메모를 다시 열 방법이 없어서** 인쇄한 것을 남기기로 했다.
-- ⚠️ `customer_json`은 **인쇄 당시의 고객 사실**(이름·나이·성향·잔고·자산배분·보유)이다.
--    다시 열 때 지금 값으로 그리면 어제 날짜 문서에 오늘 잔고가 실린다 — 그래서 스냅샷을
--    같이 담고, `created_at`을 문서 시각으로 되먹여 **그때 인쇄한 것과 같은 PDF**를 만든다.
--    ⚠️ **계좌번호는 담지 않는다**(PDF도 안 쓴다) — 이 표가 계좌번호의 두 번째 사본이 될
--       이유가 없다. 필요하면 pb_customers가 원본이다.
CREATE TABLE IF NOT EXISTS prep_notes (
    id SERIAL PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES pb_customers(id),
    items_json JSONB NOT NULL,
    customer_json JSONB NOT NULL,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prep_notes_customer_idx ON prep_notes (customer_id, id DESC);
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


async def set_note_waiver(
    note_id: int, index: int, phrase: str, reason: str | None, actor: str, text: str
) -> list[dict]:
    """금지 표현 예외를 남기거나(reason) 지운다(reason=None). 갱신된 전체 목록을 준다.

    `set_note_ack`과 모양이 같다 — 한 문장에 하나, 되돌린 이력은 감사로그에.
    ⚠️ `phrase`를 같이 남긴다: **무엇을 통과시켰는지**가 사유만큼 중요하고, 나중에 금지
       목록이 늘어나면 "그때 그 표현에 대한 예외"였음이 기록으로 남아야 한다.
    """
    row = await pool().fetchrow("SELECT waivers_json FROM notes WHERE id = $1", note_id)
    waivers = [w for w in json.loads(row["waivers_json"]) if w.get("index") != index]
    if reason is not None:
        waivers.append(
            {
                "index": index,
                "phrase": phrase,
                "reason": reason,
                "actor": actor,
                "ts": datetime.now(timezone.utc).isoformat(),
                "text": text[:60],
            }
        )
    waivers.sort(key=lambda w: w["index"])
    await pool().execute(
        "UPDATE notes SET waivers_json = $2::jsonb, updated_at = now() WHERE id = $1",
        note_id,
        json.dumps(waivers, ensure_ascii=False),
    )
    return waivers


async def set_note_mark(
    note_id: int, index: int, mark: str | None, actor: str, text: str
) -> list[dict]:
    """PB의 문장 판정을 남기거나(mark) 지운다(mark=None). 갱신된 전체 목록을 준다.

    `set_note_ack`과 같은 모양이다 — 한 문장에 하나만 남고, 되돌린 이력은 감사로그에 있다.
    두 함수를 합치지 않는 건 컬럼이 다르기 때문이고, 컬럼이 다른 이유는 위 스키마 주석에 있다.
    """
    row = await pool().fetchrow("SELECT pb_marks_json FROM notes WHERE id = $1", note_id)
    marks = [m for m in json.loads(row["pb_marks_json"]) if m.get("index") != index]
    if mark is not None:
        marks.append(
            {
                "index": index,
                "mark": mark,
                "actor": actor,
                "ts": datetime.now(timezone.utc).isoformat(),
                "text": text[:60],
            }
        )
    marks.sort(key=lambda m: m["index"])
    await pool().execute(
        "UPDATE notes SET pb_marks_json = $2::jsonb, updated_at = now() WHERE id = $1",
        note_id,
        json.dumps(marks, ensure_ascii=False),
    )
    return marks


async def advance_status(
    note_id: int,
    status: str,
    actor: str | None,
    violations: list[str] | None = None,
    *,
    record_actor: bool = True,
) -> None:
    """검토/심의/발행 단계 전이. violations가 주어지면(발행 시점 게이트 재평가) 같이 갱신한다.

    `record_actor=False`는 **되돌리는 전이**용이다(관리자 반려 → 검토중, PB 폐기 → 보류됨).
    앞으로 갈 때만 "이 단계를 누가 맡았나"를 노트에 새긴다 — 반려로 검토중에 돌아왔다고
    `reviewer`를 관리자 이름으로 덮어쓰면 **사실을 확인한 PB가 노트에서 사라진다.**
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
    lead: dict | None = None,
) -> int:
    row = await pool().fetchrow(
        """INSERT INTO briefs
             (brief_date, content_md, items_json, sentences_json, violations_json,
              market_json, lead_json)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb)
           RETURNING id""",
        brief_date,
        content_md,
        json.dumps(items, ensure_ascii=False),
        json.dumps(sentences, ensure_ascii=False),
        json.dumps(violations, ensure_ascii=False),
        json.dumps(market or {}, ensure_ascii=False),
        json.dumps(lead or {}, ensure_ascii=False),
    )
    return row["id"]


async def latest_brief() -> asyncpg.Record | None:
    return await pool().fetchrow("SELECT * FROM briefs ORDER BY id DESC LIMIT 1")


async def brief_before(brief_date) -> asyncpg.Record | None:
    """그 날짜 **이전**의 가장 최근 브리프 — "어제 대비"의 비교 기준.

    지금 견주는 것은 `market_json`의 지수다(`brief.compare_macro`). 2026-08-07 전에는
    `items_json`의 공시·뉴스였다(`brief.seen_keys`) — **읽는 컬럼이 바뀌었을 뿐 규약은 같다.**

    ⚠️ **같은 날 회차는 기준이 될 수 없다.** 브리프는 재실행마다 한 행씩 쌓이는데, 직전
       행(`latest_brief`)을 기준으로 잡으면 오늘 두 번째 실행부터 **모든 것이 "어제와 같다"**가
       되어 강조가 통째로 꺼진다. 그래서 id가 아니라 **날짜로** 자른다.
    ⚠️ 없으면 None이고, 그때 화면은 **아무 말도 하지 않는다** — "비교할 어제가 없다"와
       "어제와 비교했더니 달라진 게 없다"는 다르다.
    ⚠️ 날짜로 잘라도 **기준일이 같을 수 있다**(주말·휴장에는 어제 브리프도 오늘 브리프도 같은
       종가를 싣는다). 그건 여기서 못 거르고 `compare_macro`가 `stale`로 가른다.
    """
    return await pool().fetchrow(
        """SELECT * FROM briefs WHERE brief_date < $1
           ORDER BY brief_date DESC, id DESC LIMIT 1""",
        brief_date,
    )


async def brief_date_of(brief_id: int):
    """그 브리프의 날짜. 없으면 None."""
    row = await pool().fetchrow("SELECT brief_date FROM briefs WHERE id = $1", brief_id)
    return row["brief_date"] if row else None


async def delete_briefs_on(brief_date) -> list[int]:
    """그 날짜의 브리프를 **전부** 지우고 지운 id를 돌려준다.

    한 행이 아니라 날짜 단위인 이유: 같은 날 재실행분이 회차로 쌓이는데(`create_brief`는
    행을 더할 뿐이다) 화면은 `latest_brief()` 하나만 그린다. 보이는 한 행만 지우면 직전
    회차가 올라와 **날짜 표기까지 같은 화면이 다시 서서** 아무 일도 안 일어난 것처럼 보인다.
    브리프는 날짜 단위 산출물이고 같은 날 재생성분은 같은 것의 회차다.

    ⚠️ 감사로그는 건드리지 않는다 — `brief_created`는 실제로 일어난 일이고, 원장은
       append-only다(HANDOFF §0-1). 지운 사실은 `brief_deleted`를 **더해서** 남긴다.
    """
    rows = await pool().fetch(
        "DELETE FROM briefs WHERE brief_date = $1 RETURNING id", brief_date
    )
    return [r["id"] for r in rows]


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


# 반출 가드(compliance.egress_guard)가 자유 텍스트에 섞인 고객 이름을 대조하는 데 쓴다.
# `list_customers`를 재사용하지 않는 이유: 저쪽은 holdings·alloc JSON까지 통째로 끌어와
# 50행이면 무거운데, 여기 필요한 건 이름 한 열이고 **채팅 요청마다** 돈다.
async def list_customer_names(pb: str | None = None) -> list[str]:
    if pb is None:
        rows = await pool().fetch("SELECT name FROM pb_customers")
    else:
        rows = await pool().fetch("SELECT name FROM pb_customers WHERE pb = $1", pb)
    return [r["name"] for r in rows]


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


async def list_customer_asks(customer_id: int, pb: str | None = None) -> list[asyncpg.Record]:
    """이 고객이 남긴 **아직 처리하지 않은 문의**(오래된 것부터 — 들어온 순서가 곧 맥락이다).

    `list_sessions`를 걸러 쓰지 않는 이유: 저쪽은 전체를 끌어와 화면 큐를 만드는 자리이고,
    여기는 한 고객의 문서를 만드는 자리라 필요한 것이 그 사람 것뿐이다.
    """
    sql = """SELECT s.id, s.topic, s.question, s.started_at
             FROM pb_sessions s JOIN pb_customers c ON c.id = s.customer_id
             WHERE s.customer_id = $1 AND s.status = $2{pb}
             ORDER BY s.started_at"""
    if pb is None:
        return await pool().fetch(sql.format(pb=""), customer_id, SESSION_PENDING)
    return await pool().fetch(sql.format(pb=" AND c.pb = $3"), customer_id, SESSION_PENDING, pb)


# --- 상담 준비 메모 -------------------------------------------------------
# 스코핑 축은 **고객의 담당 PB**다(`pb_customers.pb`). 메모에 pb를 따로 복사해 두지 않는
# 이유: 담당이 바뀌면 두 값이 갈리는데, 이 목록이 답해야 하는 건 "지금 내 고객의 메모"다.


async def insert_prep_note(
    customer_id: int, items: list[dict], customer: dict, actor: str
) -> asyncpg.Record:
    return await pool().fetchrow(
        """INSERT INTO prep_notes (customer_id, items_json, customer_json, created_by)
           VALUES ($1, $2::jsonb, $3::jsonb, $4) RETURNING id, created_at""",
        customer_id,
        json.dumps(items, ensure_ascii=False),
        json.dumps(customer, ensure_ascii=False),
        actor,
    )


async def list_prep_notes(pb: str | None = None) -> list[asyncpg.Record]:
    """목록용 — **본문(items_json)은 빼고** 센 것만 준다. 화면이 그리는 건 줄 하나이고,
    50명 × 여러 건의 문장을 통째로 실어 보낼 이유가 없다(본문은 PDF를 열 때 읽는다)."""
    sql = """SELECT p.id, p.customer_id, p.created_by, p.created_at,
                    c.name AS customer_name,
                    jsonb_array_length(p.items_json) AS items
             FROM prep_notes p JOIN pb_customers c ON c.id = p.customer_id
             {where}
             ORDER BY p.id DESC"""
    if pb is None:
        return await pool().fetch(sql.format(where=""))
    return await pool().fetch(sql.format(where="WHERE c.pb = $1"), pb)


async def delete_prep_note(prep_id: int) -> None:
    """한 건만 지운다. 스코핑(담당 고객인가)은 호출자가 이미 확인한 뒤다 — 여기서 pb를 다시
    받지 않는 이유는 `get_prep_note`가 그 판정의 단일 출처이기 때문이다."""
    await pool().execute("DELETE FROM prep_notes WHERE id = $1", prep_id)


async def get_prep_note(prep_id: int) -> asyncpg.Record | None:
    return await pool().fetchrow(
        """SELECT p.*, c.pb FROM prep_notes p JOIN pb_customers c ON c.id = p.customer_id
           WHERE p.id = $1""",
        prep_id,
    )


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
