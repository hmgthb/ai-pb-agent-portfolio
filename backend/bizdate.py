"""영업일 경계 — "오늘"이 언제 시작하고 끝나는지의 **정본**.

컨테이너·Postgres는 UTC로 돈다. 그대로 `date.today()`나 `ts::date`를 쓰면 하루가 KST
09:00에 끊겨서, 사용자(PB)의 하루와 어긋난다:

- "AI가 오늘 한 일"이 아침 9시에 통째로 비고, 전날 오후 작업이 오늘로 잡힌다.
- 아침에 만든 브리프의 brief_date가 어제로 찍혀 화면이 "오늘 브리핑"으로 못 알아본다.
- DART/KRX 조회 창의 종료일이 하루 밀려 **그날 아침 접수분이 빠진다**.

이 프로젝트의 데이터(DART 공시·KRX 시세)와 사용자가 전부 한국 기준이므로 배포 위치와
무관하게 KST로 고정한다. 프론트도 같은 상수를 쓴다
(`frontend/src/app/dashboard/page.tsx`의 BIZ_TZ) — 두 곳이 어긋나면 같은 사건이
서버 집계와 화면 차트에서 다른 날짜 칸에 꽂힌다.

⚠️ **stdlib만 쓴다.** MCP 서버(`mcp_servers/krx_server.py`)가 sys.path 부트스트랩으로
이 모듈을 끌어간다 — 무거운 의존성을 넣으면 서버가 안 뜨고 그 서버의 도구 전체가 조용히
사라진다(HANDOFF §2). `dart_server.py`는 부트스트랩이 없어 같은 상수를 자체 복사로 들고
있다(그쪽 주석이 여기를 가리킨다).
"""

from datetime import date, datetime
from zoneinfo import ZoneInfo

BIZ_TZ_NAME = "Asia/Seoul"
BIZ_TZ = ZoneInfo(BIZ_TZ_NAME)


def biz_today() -> date:
    """영업 타임존 기준 오늘."""
    return datetime.now(BIZ_TZ).date()


def biz_date_sql(ts_expr: str) -> str:
    """TIMESTAMPTZ 식을 영업일 날짜로 자르는 SQL 조각.

    상수만 끼워 넣는다(사용자 입력 아님). Postgres 세션 타임존에 기대지 않고 식마다
    명시하는 이유는, 커넥션 설정이 바뀌어도 집계 기준이 조용히 따라 움직이지 않게 하려는 것.
    """
    return f"(({ts_expr}) AT TIME ZONE '{BIZ_TZ_NAME}')::date"
