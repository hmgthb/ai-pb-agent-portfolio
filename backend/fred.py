"""FRED(미국 세인트루이스 연은) — 나스닥·S&P500·미국채30년. 거시 띠의 **세 번째 공급자**.

`market.py`(KRX 지수, 공공데이터포털)·`ecos.py`(한국은행)와 제공자가 다르고, 세 모듈은
서로를 모른다 — 반환 규약만 같고(`(지표 목록, 미연결 사유)`) 합치는 곳은 `main.build_brief`
하나다. 2026-08-09에 띠가 미국 지표 위주로 바뀌면서 생겼다.

## 왜 ECOS가 아니라 여기인가

ECOS에는 이 셋이 **없다**(2026-08-09 `StatisticTableList` 전수 확인 — 일별 통계표는
기준금리·시장금리(국내)·주식시장(KOSPI/KOSDAQ)·환율·뉴스심리지수뿐이고, 국제 통계는
`902Y*` 계열로 전부 월/분기다). 해외 지수와 미국채는 별도 소스가 필요하다.

## ✅ 실호출로 확인한 것 (2026-08-09)

지어내지 않았다 — 아래는 전부 응답을 받아 본 값이다.

| 지표 | 시리즈 ID | 주기 | 확인된 값(예) |
|---|---|---|---|
| 나스닥 | `NASDAQCOM` | D | 2026-08-07 = 26690.620 (나스닥 종합지수) |
| S&P500 | `SP500` | D | 2026-08-07 = 7757.64 |
| 미국채30년 | `DGS30` | D | 2026-08-06 = 5.22 (%, 재무부 CMT 30년) |

- 응답: `observation_date,<SERIES_ID>` 헤더 + `YYYY-MM-DD,값` 행. `Content-Type: application/csv`.
- **휴장일은 값이 빈칸으로 온다**(예 2026-07-03 미 독립기념일) — 행 자체는 있다.
  그 행을 0으로 채우면 "그날 지수가 0이었다"가 되므로 **뺀다**(`ecos._values`와 같은 판단).
- ⚠️ **시리즈를 여러 개 한 요청에 담지 말 것.** `id=A,B,C,D`처럼 넷을 붙였더니 CSV가 아니라
  **ZIP 바이너리**가 왔다(실측). 하나씩 부른다 — 지표가 셋뿐이라 비용도 문제되지 않는다.

## ⚠️ 인증키

**없다.** 이 CSV 경로(`graph/fredgraph.csv`)는 키 없이 열린다 — 그래서 `market`·`ecos`와 달리
"키 미설정" 미연결 사유가 없다. 대신 네트워크·응답 실패는 같은 방식으로 사유를 돌려준다.
(키가 필요한 쪽은 `api.stlouisfed.org`의 정식 API다. 지금 쓰는 것이 셋 다 커버해서 넣지 않았다.)

## ⚠️ 기준일이 한국 지표와 하루 어긋난다

미국장은 한국 시간으로 밤에 닫는다. 아침 브리프에서 나스닥·S&P500의 `as_of`는 대체로
원/달러·국고채10년보다 하루 **뒤**이거나(전날 미국장이 이미 닫혔으면) 하루 **앞**이다.
`DGS30`은 재무부 공표라 지수보다 또 하루 늦게 붙는 날이 있다(실측 2026-08-07: 지수는 08-07,
DGS30은 08-06). **뭉개지 않는다** — 화면(`page.tsx` `mktAsOf`)이 가장 많은 지표가 공유하는
날짜만 줄 끝에 적고 벗어나는 지표는 제 날짜를 달게 되어 있다. 그 규칙이 바로 이 상황을
위한 것이다.
"""

from datetime import timedelta

import requests

from backend.bizdate import biz_today
from backend.market import (
    MarketDataUnavailable,
    daily_moves,
    rank_recent_move,
    trend_of,
)

ENDPOINT = "https://fred.stlouisfed.org/graph/fredgraph.csv"

# 지표 정의. **여기 적힌 시리즈 ID는 위 표대로 실호출로 확인된 것만이다.**
#
# basis — 이 값 하나가 문구를 가른다(`brief._index_line`·화면 배지). 지수는 일별 종가라
#   `지연시세`이고, 미국채 수익률은 재무부가 공표하는 CMT라 시세가 아니라 `공표`다.
#   ⚠️ 지수에 `공표`를 달지 말 것 — 컴플라이언스 게이트의 지연시세 고지가 그 문장에서 빠진다.
# move_unit — `ecos.SERIES`와 같은 관례다: 지수는 전일 대비 %, 금리는 bp(=0.01%p).
#   5.22 → 5.19를 "-0.57%"로 적으면 채권에서 쓰지 않는 말이 된다(-3.0bp다).
SERIES = (
    {
        "name": "나스닥",
        "series_id": "NASDAQCOM",
        "move_unit": "%",
        "move_decimals": 2,
        # 지수는 수준에 단위가 없다(포인트를 적지 않는다 · `market.fetch_index`와 같다).
        "level_unit": "",
        "basis": "지연시세",
        "source": "FRED 세인트루이스 연은 NASDAQCOM (나스닥 종합지수 일별 종가, 실시간 아님)",
    },
    {
        "name": "S&P500",
        "series_id": "SP500",
        "move_unit": "%",
        "move_decimals": 2,
        "level_unit": "",
        "basis": "지연시세",
        "source": "FRED 세인트루이스 연은 SP500 (S&P 500 일별 종가, 실시간 아님)",
    },
    {
        "name": "미국채30년",
        "series_id": "DGS30",
        "move_unit": "bp",
        "move_decimals": 1,
        "level_unit": "%",
        "basis": "공표",
        "source": "FRED 세인트루이스 연은 DGS30 (미 재무부 국채 30년 CMT 일별 공표치, 실시간 아님)",
    },
)

# 평소 대비 판정(`rank_recent_move`)의 창. `ecos.LOOKBACK_DAYS`와 **같은 40일로 맞춘다** —
# 그 함수가 내는 문구가 "N거래일 중 가장 큰 하락"이라, 지표마다 창이 다르면 같은 띠 안에서
# N이 달라진다. 미국 휴장일(빈 행)이 빠져도 40일이면 관측이 25~28개라 `MIN_WINDOW=8`을
# 여유 있게 넘긴다.
LOOKBACK_DAYS = 40
# 3개월 추세(`market.trend_of`)의 창 — 브리핑 첫 줄이 답하는 축이다(2026-08-10).
# ⚠️ **조회는 이 넓은 창으로 한 번만 하고**, 평소 대비 판정에는 뒤 `LOOKBACK_DAYS`만 잘라
#    쓴다. 요청을 둘로 늘리지 않으면서 "N거래일 중"의 N도 그대로 지키는 방법이다.
# ⚠️ `ecos.TREND_DAYS`와 같은 값이어야 한다 — 다르면 두 지표의 "석 달"이 다른 길이가 된다.
TREND_DAYS = 92


def _observations(text: str) -> list[tuple[str, str]]:
    """CSV 본문 → 날짜 오름차순 `(YYYYMMDD, 값 **원본 문자열**)`. 못 읽는 행은 **뺀다**.

    ⚠️ **값을 float으로 바꿔서 들고 다니지 않는다.** 화면에 찍는 수준(`close`)은 출처가 준
       자릿수를 그대로 지켜야 하는데(`brief.fmt_level`), float을 거치면 그 자릿수가
       포매팅 규칙에 좌우된다 — 실제로 `f"{x:g}"`가 나스닥 `26690.620`을 유효숫자 6자리로
       깎아 **`26690.6`을 화면에 내보냈다**(2026-08-09 실측). 계산이 필요한 쪽만 아래
       `_values`로 float을 만든다.
    ⚠️ 날짜를 `YYYYMMDD`로 바꿔서 내보낸다. FRED만 ISO(`2026-08-07`)로 주는데, 띠의 다른
       지표(KRX·ECOS)와 저장된 브리프가 전부 `YYYYMMDD`다 — 여기서 맞추지 않으면
       `compare_macro`가 **기준일을 이름으로 견주지 못하고**(문자열이 달라 항상 "다른 날"),
       화면의 대표 기준일 집계(`mktAsOf`)도 같은 날을 둘로 센다.
    ⚠️ 휴장일은 값이 빈칸으로 온다 — 0으로 채우지 않는다(`ecos._values`와 같은 판단).
    """
    out: list[tuple[str, str]] = []
    for line in text.splitlines()[1:]:  # 첫 줄은 헤더(observation_date,<ID>)
        date, _, value = line.partition(",")
        date, value = date.strip().replace("-", ""), value.strip()
        try:
            float(value)  # 읽히는지만 본다 — 들고 가는 것은 원본 문자열이다
        except ValueError:  # 빈칸(휴장) · 헤더 잔여 · 깨진 줄
            continue
        out.append((date, value))
    return sorted(out, key=lambda p: p[0])


def _values(obs: list[tuple[str, str]]) -> list[tuple[str, float]]:
    """`_observations` 결과 → 계산용 `(YYYYMMDD, float)`. `market.daily_moves`가 먹는 모양이다."""
    return [(t, float(v)) for t, v in obs]


def fetch_series(spec: dict) -> dict:
    """지표 한 건의 최근 관측 + 평소 대비 판정. 실패하면 `MarketDataUnavailable`.

    **추가 조회가 없다** — 한 번의 요청으로 받은 창 전체를 써서 오늘 움직임과 그 순위를
    함께 만든다(`market.fetch_index`·`ecos.fetch_series`와 같은 방식).
    """
    today = biz_today()
    try:
        resp = requests.get(
            ENDPOINT,
            params={
                "id": spec["series_id"],
                "cosd": (today - timedelta(days=TREND_DAYS)).strftime("%Y-%m-%d"),
                "coed": today.strftime("%Y-%m-%d"),
            },
            timeout=30,
        )
    except requests.RequestException as e:
        raise MarketDataUnavailable(f"조회 요청 실패: {type(e).__name__}") from e
    if resp.status_code != 200:
        raise MarketDataUnavailable(f"조회 응답 {resp.status_code}")
    # ⚠️ CSV인지 확인한다. 시리즈를 잘못 묶으면 **ZIP이 200으로 온다**(머리말 참조) —
    #    그대로 파싱하면 오류 없이 관측 0건이 되어 "휴장"처럼 보인다(조용히 틀리는 방향).
    # ⚠️ 사유에 시리즈 ID를 넣지 않는다 — 지표마다 문장이 달라지면 `fetch_series_snapshot`의
    #    중복 제거가 안 먹어서, FRED가 통째로 죽은 날 화면 한 줄이 같은 말로 세 번 채워진다.
    #    어느 지표가 실패했는지는 그 함수가 이름을 앞에 붙여 적는다.
    if not resp.text.startswith("observation_date"):
        raise MarketDataUnavailable("CSV가 아닌 응답을 받았습니다.")

    obs = _observations(resp.text)
    if len(obs) < 2:
        raise MarketDataUnavailable(
            f"최근 {LOOKBACK_DAYS}일 관측이 2건 미만입니다(휴장·공표 지연 확인)."
        )

    values = _values(obs)
    # 평소 대비 판정은 **뒤 LOOKBACK_DAYS 구간만** 본다(위 TREND_DAYS 주석). 관측 수가 아니라
    # 날짜로 자른다 — 휴장이 몰린 달에 관측 수로 자르면 창의 실제 길이가 달라진다.
    cutoff = (biz_today() - timedelta(days=LOOKBACK_DAYS)).strftime("%Y%m%d")
    recent_values = [v for v in values if v[0] >= cutoff] or values
    moves = daily_moves(recent_values, spec["move_unit"])
    if not moves:
        raise MarketDataUnavailable(
            f"최근 {LOOKBACK_DAYS}일 관측이 2건 미만입니다(휴장·공표 지연 확인)."
        )
    as_of, level = obs[-1]
    latest = moves[-1]
    return {
        "index_name": spec["name"],
        "as_of": as_of,
        # 수준은 **출처가 준 문자열 그대로**다 — 숫자로 만들었다 되돌리지 않는다(`_observations`).
        "close": level,
        "level_unit": spec["level_unit"],
        "move": f"{latest:.{spec['move_decimals']}f}",
        "move_unit": spec["move_unit"],
        "basis": spec["basis"],
        "recent": rank_recent_move(moves, latest),
        # 창 전체(TREND_DAYS)로 낸 3개월 추세. 근거가 모자라면 None이고, 그때 그 지표는
        # 첫 줄 후보에서 빠진다(`brief.pick_trends`).
        "trend": trend_of(values, spec["move_unit"]),
        "source": spec["source"],
    }


def fetch_series_snapshot() -> tuple[list[dict], str | None]:
    """(지표 목록, 미연결 사유). `market.fetch_market_snapshot`과 **같은 규약**이다.

    한 지표만 실패해도 나머지는 살린다 — 부분 결과가 없는 것보다 낫고, 사유는 남긴다.
    사유가 같으면 지표마다 되풀이하지 않는다(FRED가 통째로 죽으면 셋이 같은 문장을 낸다).
    """
    out: list[dict] = []
    failures: dict[str, list[str]] = {}
    for spec in SERIES:
        try:
            out.append(fetch_series(spec))
        except MarketDataUnavailable as e:
            failures.setdefault(str(e), []).append(spec["name"])

    parts = [
        msg if len(names) == len(SERIES) else f"{'·'.join(names)}: {msg}"
        for msg, names in failures.items()
    ]
    return out, "; ".join(parts) or None
