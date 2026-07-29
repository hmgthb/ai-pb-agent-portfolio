"""고객 문의(`pb_sessions`) 시드를 만든다 — 유실된 시드 소스를 되살린 것.

**왜 필요한가** — 앱에는 `pb_sessions`를 만드는 코드가 **없다**(`db.py`가 가진 건 SELECT 둘과
`set_session_status`뿐이고, `INSERT INTO pb_sessions`는 파이썬 어디에도 없다). 고객 문의는
제품에서 **외부에서 유입되는 것**이라(고객 앱·콜센터) PB 대시보드에 생성 화면이 없는 게 맞다.
문제는 개발·데모 환경엔 그 외부가 없어서, 큐를 채울 방법이 덤프 파일 하나뿐이었다는 것이다
(`restore_pb_sessions.sql`). 이 스크립트가 그 의존을 없앤다.

**덤프보다 나은 점 셋:**
  ① 시각을 `now() - interval`로 쓴다 → **언제 돌려도 큐가 방금 들어온 문의로 선다.**
     덤프는 절대시각(07-17~07-20)이 박혀 있어 `shift_pb_sessions_time.sql`을 뒤에 한 번 더
     돌려야 했다. 이 스크립트에는 그 2단계가 없다.
  ② `id`를 안 박는다 → SERIAL이 매기므로 **비우고 다시 넣어도 PK 충돌이 없다.**
  ③ 문의 주제가 **그 고객이 실제로 들고 있는 종목**에서 나온다. 덤프는 종목명이 보유와 무관해
     "삼성전자 문의"를 연 고객이 삼성전자를 안 들고 있는 일이 있었다.

**만들지 않는 상태: `active`.** 앱이 만들 수도(승인→`done`·반려→`rejected`) 읽을 수도 없다 —
큐는 `pending`만 담고(`main.dashboard_queue`), `summary.sessions_pending`도 `pending`만 센다.
덤프에는 12건이나 있지만 화면에 한 번도 나타나지 않는 죽은 행이다.

출력은 SQL이고 DB에 직접 쓰지 않는다 — 되돌릴 수 없는 조작은 사람이 실행한다
(`reseed_holdings.py`와 같은 원칙).

실행:
    docker compose exec -T backend python /repo/backend/scripts/seed_pb_sessions.py > /tmp/seed.sql
    docker exec -i ai-pb-agent-postgres-1 psql -U app -d app < /tmp/seed.sql

옵션:
    --pending N   큐에 세울 문의 수 (기본 4)
    --done N      이미 처리한 이력 수 (기본 8)
    --append      맨 앞의 TRUNCATE를 빼고 덧붙이기만 한다
"""

import argparse
import asyncio
import json
import os

import asyncpg
import dotenv

# 담당 PB — main.PB_NAME과 같은 값이어야 한다(그 PB의 고객에게만 문의를 붙인다).
PB_NAME = os.environ.get("PB_NAME", "PB")

# 종목이 걸린 문의. `{stock}`에 **그 고객이 실제로 들고 있는 종목**이 들어간다.
# 질문은 고객이 쓴 말이다 — PB가 답할 거리를 주되, 답 자체를 담지 않는다.
STOCK_TOPICS: list[tuple[str, str]] = [
    ("{stock} 실적 관련 문의", "{stock} 이번 실적이 좋았다던데, 지금이라도 더 담아도 될까요?"),
    ("{stock} 비중 조정 문의", "{stock} 비중이 좀 큰 것 같은데 줄이는 게 나을까요?"),
    ("{stock} 공시 관련 문의", "{stock} 공시가 났다고 들었는데 제 계좌에 영향이 있나요?"),
    ("{stock} 주가 급락 문의", "{stock}이 어제 많이 빠졌던데 무슨 일이 있었나요?"),
]

# 종목과 무관한 문의. 계좌·상품 이야기라 보유 종목을 안 본다.
GENERAL_TOPICS: list[tuple[str, str]] = [
    ("포트폴리오 리밸런싱 문의", "전체적으로 한 번 정리할 때가 된 것 같은데 봐주실 수 있나요?"),
    ("퇴직연금 운용 상담", "퇴직연금 계좌를 좀 더 적극적으로 운용하고 싶은데 방법이 있을까요?"),
    ("채권 비중 확대 상담", "금리가 내려간다는데 채권 비중을 늘리는 게 맞을까요?"),
    ("ISA 계좌 활용 문의", "ISA 계좌를 아직 안 만들었는데 지금이라도 여는 게 나을까요?"),
]


def build(rows: list[dict], n_pending: int, n_done: int) -> list[dict]:
    """문의 목록을 만든다 — 난수 없이 결정론적이다(같은 입력 → 같은 출력).

    고객은 id 순으로 **건너뛰며** 고른다. 앞에서부터 연속으로 집으면 데모에서 큐가 특정
    고객 몇 명에게 몰려 보인다.

    종목 문의와 일반 문의를 번갈아 낸다 — 큐가 종목 이야기로만 차면 "이 화면은 종목 도구다"로
    읽히는데, 문의 모달이 답하는 건 계좌 이야기이기도 하다.
    """
    total = n_pending + n_done
    if total > len(rows):
        raise SystemExit(f"고객이 {len(rows)}명인데 문의를 {total}건 만들 수 없다")

    step = max(1, len(rows) // total)
    picked = [rows[(i * step) % len(rows)] for i in range(total)]

    out = []
    for i, cust in enumerate(picked):
        holdings = cust["holdings"]
        # 짝수는 종목 문의, 홀수는 일반 문의. 보유가 비면 일반으로 떨어진다.
        if i % 2 == 0 and holdings:
            topic, question = STOCK_TOPICS[(i // 2) % len(STOCK_TOPICS)]
            # 금액이 큰 종목을 고른다 — 고객이 실제로 신경 쓸 자리다.
            stock = max(holdings, key=lambda h: h["amt"])["name"]
            topic, question = topic.format(stock=stock), question.format(stock=stock)
        else:
            topic, question = GENERAL_TOPICS[(i // 2) % len(GENERAL_TOPICS)]

        pending = i < n_pending
        # 큐는 started_at DESC로 선다. pending을 촘촘히(40분 간격), 처리분을 그 뒤로
        # 넓게(하루 간격) 두면 "방금 들어온 것들 + 지난 이력"으로 읽힌다.
        started_min = i * 40 if pending else n_pending * 40 + (i - n_pending) * 1440
        out.append({
            "customer_id": cust["id"],
            "status": "pending" if pending else "done",
            "topic": topic,
            # 처리된 건의 질문 원문은 남기지 않는다(덤프도 그랬다) — 모달이 여는 건
            # pending뿐이라 화면에 쓰이지 않는다.
            "question": question if pending else None,
            "started_min": started_min,
            # pending은 아직 아무 일도 없었으므로 updated_at = started_at.
            # 처리분은 접수 뒤 얼마간 지나 결정된 것으로 둔다.
            "updated_min": started_min if pending else max(0, started_min - 120),
        })
    return out


async def load() -> list[dict]:
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    try:
        recs = await conn.fetch(
            "SELECT id, holdings FROM pb_customers WHERE pb = $1 ORDER BY id", PB_NAME
        )
    finally:
        await conn.close()
    return [
        {
            "id": r["id"],
            "holdings": (
                r["holdings"] if isinstance(r["holdings"], list) else json.loads(r["holdings"])
            ),
        }
        for r in recs
    ]


def sql_str(v: str | None) -> str:
    return "NULL" if v is None else "'" + v.replace("'", "''") + "'"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pending", type=int, default=4, help="큐에 세울 문의 수")
    ap.add_argument("--done", type=int, default=8, help="이미 처리한 이력 수")
    ap.add_argument("--append", action="store_true", help="TRUNCATE 없이 덧붙인다")
    args = ap.parse_args()

    dotenv.load_dotenv(dotenv_path="/repo/.env")
    rows = asyncio.run(load())
    if not rows:
        raise SystemExit(f"담당 고객이 없다(PB_NAME={PB_NAME!r}) — pb_customers를 먼저 채워라")

    items = build(rows, args.pending, args.done)

    print("-- 고객 문의 시드 (backend/scripts/seed_pb_sessions.py 생성)")
    print(f"-- 담당 PB={PB_NAME} · pending {args.pending}건(큐에 선다) · done {args.done}건(이력)")
    print("-- 시각이 now() 기준이라 **언제 돌려도 큐가 방금 들어온 문의로 선다**")
    print("--   (절대시각 덤프와 달리 shift_pb_sessions_time.sql이 필요 없다).")
    print("-- id를 안 박으므로 비우고 다시 넣어도 PK 충돌이 없다.")
    print("BEGIN;")
    if not args.append:
        print("TRUNCATE pb_sessions;  -- 기존 문의를 전부 버린다(--append로 끌 수 있다)")
    for it in items:
        print(
            "INSERT INTO pb_sessions"
            " (customer_id, status, topic, question, started_at, updated_at) VALUES ("
            f"{it['customer_id']}, '{it['status']}', {sql_str(it['topic'])},"
            f" {sql_str(it['question'])},"
            f" now() - interval '{it['started_min']} minutes',"
            f" now() - interval '{it['updated_min']} minutes');"
        )
    print("COMMIT;")


if __name__ == "__main__":
    main()
