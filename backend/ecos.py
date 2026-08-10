"""한국은행 ECOS 오픈API — 환율·국고채금리. 브리핑 거시 띠의 **두 번째 공급자**.

`market.py`(지수·종목시세, 공공데이터포털)와 **제공자가 다르다.** 인증 방식(키가 URL 경로에
들어간다)도 응답 모양도 달라서 모듈을 나눴다 — 합치는 곳은 `main.build_brief` 하나다.
`market.py` 상단이 오래 "환율·금리는 이 서비스에 없어 별도 소스가 필요하다"고 적어 두었던
그 별도 소스가 여기다.

## ✅ 실호출로 확인한 것 (2026-08-07, ECOS 공개 `sample` 키)

지어내지 않았다 — 아래는 전부 응답을 받아 본 값이다.

| 지표 | 통계표(STAT) | 항목(ITEM) | 주기 | 확인된 이름 |
|---|---|---|---|---|
| 원/달러 | `731Y001` | `0000001` | D | 원/미국달러(매매기준율) |
| 국고채3년 | `817Y002` | `010200000` | D | 국고채(3년) · 단위 `연%` |
| 국고채10년 | `817Y002` | `010210000` | D | 국고채(10년) · 단위 `연%` (2026-08-09 `StatisticItemList`로 확인, 관측 20001218~) |

- 응답: `{"StatisticSearch": {"list_total_count": N, "row": [{TIME, DATA_VALUE, UNIT_NAME, …}]}}`
- 오류: `{"RESULT": {"CODE": "ERROR-…"|"INFO-…", "MESSAGE": "…"}}` — **HTTP는 200이다.**
  그래서 상태코드만 보면 실패가 성공처럼 보인다(HANDOFF §2의 도구 결과 함정과 같은 모양).
- **두 시리즈 다 주말을 건너뛴다** — 실측 `20260730·31 → 20260803`(0801 토·0802 일 없음).
  그래서 `market.fetch_index`(KRX 지수)와 **기준일이 같은 날 정렬된다**. 화면 띠가 날짜를
  줄 끝에 한 번만 적을 수 있는 근거이고, 이게 깨지면 지표마다 날짜가 붙는다.

## 왜 기준금리(`722Y001`/`0101000`)를 안 넣었나

코드는 확인했다(실호출 OK). 넣지 않은 이유가 둘이다:
① 그 시리즈만 **주말에도 값이 있다** — 월요일 아침에 혼자 기준일이 달라져서, 띠 전체가
   지표마다 날짜를 달게 된다(위 정렬이 깨진다).
② 계단 함수라 등락·평소 대비 규칙이 의미를 못 만든다. 필요해지면 "어제와 값이 다르면 한 줄"
   같은 **별개 규칙**으로 붙일 것이지, 아래 `move` 계산에 태우지 마라.

## ⚠️ 키

`ECOS_API_KEY`가 없으면 **조용히 비우지 않고 사유를 돌려준다**(`market`과 같은 규약) —
화면이 "미연결"이라고 말한다. 발급은 ecos.bok.or.kr 회원가입 후 즉시.
공개 `sample` 키는 **호출당 10건 제한**이라 창을 못 채운다 — 검증용이지 운영용이 아니다.
"""

import os
from datetime import timedelta

import requests
from dotenv import load_dotenv

from backend.bizdate import biz_today
from backend.market import (
    MarketDataUnavailable,
    daily_moves,
    rank_recent_move,
    trend_of,
)

# `daily_moves`는 여기서 정의하지 않고 `market`에서 가져온다(2026-08-09에 옮겼다) —
# 같은 계산을 `fred.py`도 쓰기 때문이다. `ecos.daily_moves`로 부르던 곳은 그대로 동작한다.
__all__ = ["daily_moves", "fetch_series", "fetch_series_snapshot"]

load_dotenv()

ENDPOINT = "https://ecos.bok.or.kr/api/StatisticSearch"

# 지표 정의. **여기 적힌 코드는 위 표대로 실호출로 확인된 것만이다** — 새 지표를 넣을 때도
# `StatisticItemList`로 항목코드를 먼저 확인할 것(추측한 코드는 INFO-200 "데이터 없음"으로
# 조용히 빈 값이 된다).
#
# move_unit — 오늘 움직임을 무엇으로 세는가. **환율과 금리는 관례가 다르다**:
#   환율은 전일 대비 **%**, 금리는 전일 대비 **bp**(=0.01%p)다. 금리를 %로 적으면
#   3.742 → 3.669가 "-1.95%"가 되는데, 채권에서 그렇게 말하지 않는다(-7.3bp다).
SERIES = (
    {
        "name": "원/달러",
        "stat": "731Y001",
        "item": "0000001",
        "move_unit": "%",
        "move_decimals": 2,
        # 이름이 이미 원화 표시라 수준 뒤에 단위를 또 붙이지 않는다("원/달러 1,548.4원").
        "level_unit": "",
    },
    {
        # 2026-08-09: 3년(`010200000`) → 10년. 띠가 미국 위주로 바뀌면서(나스닥·S&P500·
        # 미국채30년) 한국 금리도 **장기물**이어야 미국채30년과 같은 축에서 읽힌다 —
        # 3년물과 30년물을 나란히 놓으면 만기가 다른 둘을 같은 줄에서 견주게 된다.
        # 3년 항목코드는 지우지 않고 여기 적어 둔다(되돌릴 때 다시 확인하지 않도록).
        "name": "국고채10년",
        "stat": "817Y002",
        "item": "010210000",
        "move_unit": "bp",
        "move_decimals": 1,
        "level_unit": "%",
    },
)

SOURCE = "한국은행 ECOS 오픈API (일별 공표치, 실시간 아님)"

# 조회 창. `market.LOOKBACK_DAYS`(30)보다 넉넉한 이유: 이 시리즈들은 주말을 건너뛰므로
# 달력 40일이라야 영업일 관측이 25~28개쯤 잡힌다 — `rank_recent_move`의 `MIN_WINDOW=8`을
# 여유 있게 넘겨야 판정이 켜진다(창이 짧으면 그 함수는 아무 말도 하지 않는다).
LOOKBACK_DAYS = 40
# 3개월 추세(`market.trend_of`)의 창 — `fred.TREND_DAYS`와 **같은 값이어야 한다**(다르면
# 두 지표의 "석 달"이 다른 길이가 된다). 조회는 이 넓은 창으로 한 번만 하고, 평소 대비
# 판정에는 뒤 `LOOKBACK_DAYS`만 잘라 쓴다.
TREND_DAYS = 92
# 한 번에 받을 행 수. 창보다 넉넉해야 하고, **줄이지 말 것** — 모자라면 창 앞부분만
# 세면서도 오류가 안 난다(조용히 틀리는 방향이다).
MAX_ROWS = 200

UNAVAILABLE_HINT = (
    "한국은행 ECOS 미연결 — ecos.bok.or.kr에서 인증키를 발급받아 ECOS_API_KEY에 넣으면 켜집니다."
)


# 사유 문장 한 줄로 다듬기. ECOS의 `MESSAGE`는 **여러 줄로 온다**(실측 — ERROR-301은 개행이
# 둘 들어 있다). 그대로 실으면 요약 불릿 하나가 화면에서 세 줄이 된다("불릿당 한 문장" 위반).
_REASON_CAP = 80


def _reason(text: str) -> str:
    """공급자가 준 사유 → 한 줄. 잘릴 때는 잘렸다고 표시한다(문장이 끊긴 것처럼 보이지 않게)."""
    one = " ".join(str(text or "").split())
    return one if len(one) <= _REASON_CAP else one[: _REASON_CAP - 1] + "…"


def _values(rows: list[dict]) -> list[tuple[str, float]]:
    """응답 행 → 날짜 오름차순 `(YYYYMMDD, 값)`. 못 읽는 행은 **뺀다**.

    ⚠️ 0으로 채우지 않는다(`market.as_pct`와 같은 판단) — 환율 0원은 값이 아니라 사고다.
    """
    out = []
    for r in rows:
        try:
            out.append((str(r["TIME"]), float(r["DATA_VALUE"])))
        except (KeyError, TypeError, ValueError):
            continue
    return sorted(out, key=lambda p: p[0])


def fetch_series(spec: dict, *, rows_limit: int = MAX_ROWS) -> dict:
    """지표 한 건의 최근 관측 + 평소 대비 판정. 실패하면 `MarketDataUnavailable`.

    **추가 조회가 없다** — 한 번의 요청으로 받은 창 전체를 써서 오늘 움직임과 그 순위를
    함께 만든다(`market.fetch_index`와 같은 방식).

    rows_limit: 공개 `sample` 키(10건 제한)로 경로를 검증할 때만 낮춘다. 운영에서는 건드리지 말 것.
    """
    api_key = os.environ.get("ECOS_API_KEY")
    if not api_key:
        raise MarketDataUnavailable(UNAVAILABLE_HINT)

    today = biz_today()
    begin = (today - timedelta(days=TREND_DAYS)).strftime("%Y%m%d")
    end = today.strftime("%Y%m%d")

    def get(first: int, last: int) -> dict:
        url = "/".join(
            [
                ENDPOINT, api_key, "json", "kr", str(first), str(last),
                spec["stat"], "D", begin, end, spec["item"],
            ]
        )
        try:
            resp = requests.get(url, timeout=30)
        except requests.RequestException as e:
            raise MarketDataUnavailable(f"조회 요청 실패: {type(e).__name__}") from e
        if resp.status_code != 200:
            # ⚠️ 본문을 그대로 싣지 않는다 — 인증키가 URL에 있어서 오류 페이지가 되비칠 수 있다.
            raise MarketDataUnavailable(f"조회 응답 {resp.status_code}")
        try:
            body = resp.json()
        except ValueError as e:
            raise MarketDataUnavailable("응답을 해석하지 못했습니다.") from e
        # ⚠️ **오류도 HTTP 200으로 온다.** 여기서 안 걸러내면 아래 KeyError로 떨어지면서
        #    사람이 읽을 수 없는 사유가 화면에 뜬다.
        if "RESULT" in body:
            r = body["RESULT"]
            raise MarketDataUnavailable(f"{_reason(r.get('MESSAGE'))} ({r.get('CODE')})")
        return body.get("StatisticSearch") or {}

    data = get(1, rows_limit)
    rows = data.get("row") or []
    total = int(data.get("list_total_count") or 0)
    # ⚠️ **잘리면 창의 앞부분(가장 오래된 것)이 온다.** 브리핑에 필요한 건 뒤쪽(최근)이라,
    #    그대로 쓰면 몇 주 전 값을 오늘 값으로 싣게 된다 — 오류 없이 조용히 틀리는 종류다.
    #    그래서 잘린 게 보이면 **꼬리를 다시 받는다.** 운영(MAX_ROWS=200)에서는 창이 40일이라
    #    이 분기가 돌 일이 없고, 호출당 건수가 제한된 키(공개 `sample`=10건)에서만 돈다.
    if total > len(rows) > 0:
        rows = get(max(1, total - len(rows) + 1), total).get("row") or []

    values = _values(rows)
    if len(values) < 2:
        raise MarketDataUnavailable(
            f"최근 {LOOKBACK_DAYS}일 관측이 2건 미만입니다(휴장·공표 지연 확인)."
        )

    # 평소 대비 판정은 **뒤 LOOKBACK_DAYS 구간만** 본다(위 TREND_DAYS 주석).
    cutoff = (today - timedelta(days=LOOKBACK_DAYS)).strftime("%Y%m%d")
    recent_values = [v for v in values if v[0] >= cutoff] or values
    moves = daily_moves(recent_values, spec["move_unit"])
    if not moves:
        raise MarketDataUnavailable(
            f"최근 {LOOKBACK_DAYS}일 관측이 2건 미만입니다(휴장·공표 지연 확인)."
        )
    as_of, level = values[-1]
    latest = moves[-1]
    return {
        "index_name": spec["name"],
        "as_of": as_of,
        # 수준은 **원본 문자열 그대로의 정밀도**를 지킨다(국고채 3.669를 3.67로 깎지 않는다).
        "close": f"{level:g}",
        "level_unit": spec["level_unit"],
        "move": f"{latest:.{spec['move_decimals']}f}",
        "move_unit": spec["move_unit"],
        # 지연 데이터가 아니라 **공표치**다 — 화면·본문 문구가 이 값으로 갈린다(brief._index_line).
        "basis": "공표",
        "recent": rank_recent_move(moves, latest),
        # 창 전체(TREND_DAYS)로 낸 3개월 추세 — `fred.fetch_series`와 같은 규약이다.
        "trend": trend_of(values, spec["move_unit"]),
        "source": SOURCE,
    }


def fetch_series_snapshot(*, rows_limit: int = MAX_ROWS) -> tuple[list[dict], str | None]:
    """(지표 목록, 미연결 사유). `market.fetch_market_snapshot`과 **같은 규약**이다.

    한 지표만 실패해도 나머지는 살린다 — 부분 결과가 없는 것보다 낫고, 사유는 남긴다.
    사유가 같으면 지표마다 되풀이하지 않는다(키가 없으면 전 지표가 같은 문장을 낸다).
    """
    out: list[dict] = []
    failures: dict[str, list[str]] = {}
    for spec in SERIES:
        try:
            out.append(fetch_series(spec, rows_limit=rows_limit))
        except MarketDataUnavailable as e:
            failures.setdefault(str(e), []).append(spec["name"])

    parts = [
        msg if len(names) == len(SERIES) else f"{'·'.join(names)}: {msg}"
        for msg, names in failures.items()
    ]
    return out, "; ".join(parts) or None
