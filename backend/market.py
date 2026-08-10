"""시장 현황(지수) 조회 — PB가 상담 전에 먼저 보는 "오늘 시장".

종목 시세(krx_quote)와 같은 공공데이터포털 계열이지만 **서비스가 다르다**(지수시세정보).
서비스별로 활용신청이 따로 필요해서, 신청 전 키로 부르면 403이 온다.

그 경우 **조용히 빈 값으로 넘기지 않는다** — 사유를 함께 돌려줘서 화면이 "미연결"이라고
말할 수 있게 한다(HANDOFF §2: 실화면은 목업으로 폴백하지 않는다). 지수가 없는 브리프와
지수를 못 불러온 브리프는 PB에게 전혀 다른 정보다.

# ✅ 실호출 검증됨(2026-07-27, 활용신청 승인 후): 200 OK이고 응답 필드명
# (idxNm/clpr/vs/fltRt/basDt)이 공공데이터포털 명세와 일치한다 — 코드 수정 없이 켜졌다.
# 코스피·코스닥 둘 다 정상(예: 코스피 6,690.62 / basDt 20260724).
# 필드명이 달라지면 KeyError로 즉시 드러나게 두었다 — None으로 채우지 않는다.
# 활용신청: 공공데이터포털 > "금융위원회_지수시세정보" > 활용신청(개발계정 자동승인).
"""

import os
from datetime import datetime, timedelta

import requests
from dotenv import load_dotenv

from backend.bizdate import biz_today

load_dotenv()

ENDPOINT = (
    "https://apis.data.go.kr/1160100/service/GetMarketIndexInfoService/getStockMarketIndex"
)

# 거시 띠에서 **이 서비스가 대는 몫**. 환율·금리는 여기 없어 별도 소스를 쓴다 —
# 한국은행 ECOS(`backend/ecos.py`, 2026-08-07 연결). 두 모듈은 서로를 모르고
# 반환 규약만 같으며, 합치는 곳은 `main.build_brief` 하나다.
INDEX_NAMES = ("코스피", "코스닥")

# 조회 창. **`rank_recent_move`의 창이기도 하다**(2026-08-07 확대) — 10일이던 값을 30일로
# 늘렸다. 달력일이라 10일이면 영업일이 7개 안팎이고, 그러면 `MIN_WINDOW = 8`을 못 넘겨
# 판정이 **항상 None**이었다(브리핑이 거시 전용이 되면서 이 판정이 카드의 주력이 됐다).
# ⚠️ `numOfRows`(30)와 함께 봐야 한다 — 30일 창의 영업일은 20개 남짓이라 한 페이지에 들어온다.
#    창을 더 늘리려면 numOfRows도 같이 올릴 것: 안 올리면 조용히 앞부분만 세게 된다.
LOOKBACK_DAYS = 30

UNAVAILABLE_HINT = (
    "KRX 지수시세정보 미연결 — 공공데이터포털에서 '금융위원회_지수시세정보' 활용신청 후 켜집니다."
)


class MarketDataUnavailable(RuntimeError):
    """지수를 못 가져온 이유를 사람이 읽을 문장으로 들고 다닌다."""


def fetch_index(index_name: str) -> dict:
    """지수명(예: "코스피")의 최근 영업일 종가·등락률. 종목 시세와 마찬가지로 지연 데이터다."""
    api_key = os.environ.get("KRX_API_KEY")
    if not api_key:
        raise MarketDataUnavailable("KRX_API_KEY가 설정되지 않았습니다.")

    # 조회 창은 한국 거래일 기준 — UTC로 자르면 KST 09:00 전에 종료일이 하루 밀린다.
    today = biz_today()
    try:
        resp = requests.get(
            ENDPOINT,
            params={
                "serviceKey": api_key,
                "resultType": "json",
                "numOfRows": 30,
                "pageNo": 1,
                "idxNm": index_name,
                "beginBasDt": (today - timedelta(days=LOOKBACK_DAYS)).strftime("%Y%m%d"),
                "endBasDt": today.strftime("%Y%m%d"),
            },
            timeout=30,
        )
    except requests.RequestException as e:
        raise MarketDataUnavailable(f"지수 조회 요청 실패: {e}") from e

    if resp.status_code == 403:
        raise MarketDataUnavailable(UNAVAILABLE_HINT)
    if resp.status_code != 200:
        raise MarketDataUnavailable(f"지수 조회 응답 {resp.status_code}: {resp.text[:120]}")

    try:
        body = resp.json()["response"]["body"]
    except ValueError as e:  # JSON이 아니면 대개 포털이 돌려준 오류 페이지다
        raise MarketDataUnavailable(f"지수 응답을 해석하지 못했습니다: {resp.text[:120]}") from e

    rows = (body.get("items") or {}).get("item") or []
    if isinstance(rows, dict):  # 1건이면 리스트가 아니라 dict로 온다(krx_quote와 같음)
        rows = [rows]
    # 부분일치로 다른 지수가 섞일 수 있어 이름이 정확히 맞는 것만 남긴다.
    rows = [r for r in rows if r.get("idxNm") == index_name]
    if not rows:
        raise MarketDataUnavailable(
            f"{index_name}의 최근 {LOOKBACK_DAYS}일 지수를 찾지 못했습니다(휴장 확인)."
        )

    latest = max(rows, key=lambda r: r["basDt"])
    return {
        "index_name": latest["idxNm"],
        "as_of": latest["basDt"],  # 기준일자 = 출처 시점
        "close": latest["clpr"],
        "level_unit": "",  # 지수는 수준에 단위가 없다(포인트를 적지 않는다)
        "change": latest.get("vs"),
        "change_pct": latest["fltRt"],
        # ── 거시 지표 공통 계약(2026-08-07) ──────────────────────────────────
        # 지수·환율(ecos)·금리(ecos)가 **한 띠에 나란히** 서면서, 판정과 표시가 지표마다
        # 다른 키를 보면 안 되게 됐다. 그래서 "오늘 얼마나 움직였나"는 어느 지표든
        # `move` + `move_unit` 하나로 읽는다(`brief.direction_of`·`_index_line`·화면).
        # ⚠️ 위 `change_pct`는 **KRX가 준 원본**이라 그대로 남긴다 — 파생값(`move`)이
        #    원본을 덮어쓰지 않게 한다. 둘이 갈릴 일은 없다(여기서 복사한다).
        # ⚠️ `basis`가 문구를 가른다: 지수는 지연시세, ECOS는 공표치다. 게이트의 지연시세
        #    규칙이 문장 단위라 이 값이 곧 그 문장의 표기가 된다.
        "move": latest["fltRt"],
        "move_unit": "%",
        "basis": "지연시세",
        # 오늘 등락이 평소와 견줘 어느 정도인가 — **추가 조회가 없다**(2026-08-07). 위 요청이
        # 이미 창 전체를 받아 놓고 마지막 한 줄만 쓰고 버리고 있었다. 종목 시세(`krx_quote`)가
        # 하던 것과 같은 판정을 같은 함수로 지수에도 붙인다 — 규칙이 두 벌이 되면 안 된다.
        # 평범하거나 창이 짧으면 None이고, 그때 화면은 아무 말도 하지 않는다.
        "recent": rank_recent_move(daily_pcts(rows), as_pct(latest["fltRt"])),
        "is_delayed": True,
        "source": "공공데이터포털 금융위원회 지수시세정보 (일별 종가 기준, 실시간 아님)",
    }


def fetch_market_snapshot() -> tuple[list[dict], str | None]:
    """(지수 목록, 미연결 사유). 사유가 있으면 화면이 그대로 사람에게 보여준다.

    한 지수만 실패해도 나머지는 살린다 — 부분 결과가 없는 것보다 낫고, 사유는 남긴다.
    """
    indices: list[dict] = []
    # 사유가 같으면 지수마다 반복하지 않는다 — 미신청 키면 전 지수가 같은 문장을 내는데,
    # 그대로 이으면 화면 한 줄이 같은 말로 두 번 채워진다(실제로 그렇게 보였다).
    failures: dict[str, list[str]] = {}
    for name in INDEX_NAMES:
        try:
            indices.append(fetch_index(name))
        except MarketDataUnavailable as e:
            failures.setdefault(str(e), []).append(name)

    parts = [
        msg if len(names) == len(INDEX_NAMES) else f"{'·'.join(names)}: {msg}"
        for msg, names in failures.items()
    ]
    note = "; ".join(parts) or None
    if indices:
        return indices, note
    return [], note or "지수를 가져오지 못했습니다."


# ── 종목 시세 배치 조회 (제안 기능용, 2026-08-04) ────────────────────────────
#
# **왜 배치인가.** 제안 후보의 근거로 "최근 등락"을 붙이려면 50종목의 시세가 필요한데,
# `mcp_servers/krx_server.py`의 `krx_quote`는 **종목 하나씩** 부른다(likeSrtnCd). 50번
# 부르면 응답이 분 단위로 늘어난다.
#
# 같은 엔드포인트가 `basDt`(기준일자)만 주면 **그 날짜의 전 종목**을 돌려준다 — 실측
# 2,872건(2026-08-04, basDt=20260731). 그래서 두 날짜를 각각 한 번씩(페이지 포함 몇 번)
# 부르는 것으로 50종목 등락이 다 나온다.
#
# ⚠️ 이 모듈의 위쪽(지수)과 **서비스가 다르다** — 종목시세정보는 krx_server와 같은 서비스다.
#    활용신청도 따로이므로 엔드포인트 상수를 공유하지 않는다.
# ⚠️ 지연시세(일별 종가)다. 인용할 때 반드시 그 사실을 함께 밝힌다(compliance 게이트가 검사).
STOCK_ENDPOINT = (
    "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo"
)

# 등락 계산 구간. 영업일이 아니라 달력일이라 연휴가 끼면 실제 영업일 수는 줄어든다 —
# 그래서 결과에 `days`(실제 영업일 간격이 아니라 **비교한 두 기준일**)를 함께 담는다.
CHANGE_WINDOW_DAYS = 14
# 기준일 후보를 며칠까지 뒤로 밀며 찾을지. 주말·연휴에 basDt가 비어 오는 걸 넘기기 위한 것.
_BASDT_PROBE_DAYS = 10


def _fetch_by_basdt(api_key: str, bas_dt: str) -> dict[str, dict]:
    """기준일자 하루치 전 종목 → {종목코드: {close, name}}. 없으면 빈 dict."""
    out: dict[str, dict] = {}
    page = 1
    while True:
        resp = requests.get(
            STOCK_ENDPOINT,
            params={
                "serviceKey": api_key,
                "resultType": "json",
                "numOfRows": 1000,
                "pageNo": page,
                "basDt": bas_dt,
            },
            timeout=60,
        )
        resp.raise_for_status()
        body = resp.json()["response"]["body"]
        rows = (body.get("items") or {}).get("item") or []
        if isinstance(rows, dict):
            rows = [rows]
        for r in rows:
            out[r["srtnCd"]] = {"close": float(r["clpr"]), "name": r["itmsNm"]}
        if not rows or len(out) >= int(body.get("totalCount") or 0):
            break
        page += 1
    return out


def _latest_basdt(api_key: str, start) -> tuple[str, dict[str, dict]]:
    """start에서 하루씩 뒤로 밀며 **데이터가 있는 기준일**을 찾는다.

    주말·연휴에는 basDt가 비어서 오는데, 그걸 "시세 없음"으로 처리하면 월요일 아침마다
    제안 근거가 통째로 사라진다. 며칠까지 뒤로 볼지는 `_BASDT_PROBE_DAYS`가 정한다.
    """
    for back in range(_BASDT_PROBE_DAYS):
        d = (start - timedelta(days=back)).strftime("%Y%m%d")
        rows = _fetch_by_basdt(api_key, d)
        if rows:
            return d, rows
    raise MarketDataUnavailable(
        f"최근 {_BASDT_PROBE_DAYS}일 안에 시세가 있는 기준일을 찾지 못했습니다."
    )


def fetch_change_batch(codes: list[str]) -> tuple[dict[str, dict], str | None]:
    """(코드 → {pct, days, from, to, close}, 실패 사유). 두 기준일의 종가로 등락을 계산한다.

    **등락률을 코드가 계산한다** — 모델에게 두 종가를 주고 나눗셈을 시키지 않는다
    (`f1.portfolio_facts`와 같은 원칙). 반환값의 `pct`는 소수 첫째 자리에서 반올림된
    완성된 수치이고, 모델은 그대로 인용만 한다.

    실패해도 예외를 올리지 않고 (빈 dict, 사유)를 준다 — 시세가 없다고 제안 자체가
    사라지면 안 되고, 없는 건 없다고 화면이 말해야 한다(`fetch_market_snapshot`과 같은 규약).
    """
    api_key = os.environ.get("KRX_API_KEY")
    if not api_key:
        return {}, "KRX_API_KEY가 설정되지 않았습니다."
    try:
        to_dt, to_rows = _latest_basdt(api_key, biz_today())
        from_start = datetime.strptime(to_dt, "%Y%m%d").date() - timedelta(
            days=CHANGE_WINDOW_DAYS
        )
        from_dt, from_rows = _latest_basdt(api_key, from_start)
    except MarketDataUnavailable as e:
        return {}, str(e)
    except requests.RequestException as e:
        return {}, f"KRX 종목시세 조회 실패: {type(e).__name__}"

    out: dict[str, dict] = {}
    for code in codes:
        now, before = to_rows.get(code), from_rows.get(code)
        # 한쪽만 있으면 등락을 만들 수 없다 — 지어내지 않고 그 종목만 뺀다.
        if not now or not before or not before["close"]:
            continue
        out[code] = {
            "pct": round((now["close"] - before["close"]) / before["close"] * 100, 1),
            "close": now["close"],
            "days": CHANGE_WINDOW_DAYS,
            "from": from_dt,
            "to": to_dt,
        }
    missing = [c for c in codes if c not in out]
    note = f"{len(missing)}종목은 두 기준일 시세가 모두 있지 않아 제외했습니다." if missing else None
    return out, note


# ── 오늘 움직임이 평소 대비 어느 정도인가 (2026-08-06) ──────────────────────────
#
# **추가 조회가 없다.** `krx_quote`도 `fetch_index`도 이미 한 번의 요청으로 수십 일치를
# 받아 놓고 마지막 한 줄만 쓰고 버리고 있었다 — 이 함수는 그 버려지던 행들을 쓴다.
#
# 왜 필요한가: 브리프 카드가 `▼4.31%`라고만 적으면 그게 큰 움직임인지 평범한지를 읽는
# 사람이 알 수 없다. 브리핑은 절대값이 아니라 **비교**다.
#
# ⚠️ **같은 방향끼리만 견준다.** 하락을 상승과 섞어 절대값으로 줄 세우면 "가장 큰 하락"이
#    실은 상승장 한복판의 작은 하락일 수 있다.
# ⚠️ 창이 짧으면 **아무 말도 하지 않는다**(None). 신규상장·긴 연휴로 5거래일치만 잡혔는데
#    "5거래일 중 가장 큰 하락"이라고 적으면 없는 무게를 실어 주는 것이다.
NOTABLE_RANK = 3  # 상위 몇 위까지 "평소와 다르다"고 말할지
MIN_WINDOW = 8  # 이보다 짧은 창에서는 판단하지 않는다


def as_pct(raw) -> float | None:
    """등락률 문자열(`"-4.31"`) → float. 못 읽으면 None — **0으로 채우지 않는다**
    (0은 '보합'이라는 뜻이 되어 버린다)."""
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def daily_pcts(rows: list[dict]) -> list[float]:
    """KRX 응답 행들 → 일별 등락률. 못 읽은 행은 **빼고** 넘긴다 — 창 크기(`of`)도 같이
    줄어들어 "N거래일 중"의 N이 실제로 본 날수와 어긋나지 않는다.

    ⚠️ 이 함수가 krx_server가 아니라 여기 있는 이유: 그쪽은 `mcp` 패키지가 있어야 import되어
       순수 함수인데도 테스트가 안 돈다. 판정(`rank_recent_move`)과 같은 자리에 둔다."""
    return [p for p in (as_pct(r.get("fltRt")) for r in rows) if p is not None]


def daily_moves(values: list[tuple[str, float]], move_unit: str) -> list[float]:
    """연속한 두 관측의 차 → 일별 움직임. 단위는 `move_unit`이 정한다(순수 함수).

    `%`는 비율 변화, `bp`는 절대 차이 ×100(=0.01%p 단위). 관측이 2개 미만이면 빈 리스트다.
    ⚠️ 직전 값이 0이면 비율을 만들 수 없다 — 그 구간만 건너뛴다(0으로 나누지 않는다).

    ⚠️ **여기 있는 이유**(2026-08-09): 원래 `ecos.py` 안에 있었는데, 거시 띠 공급자가 셋이
       되면서(`market`·`ecos`·`fred`) 같은 계산이 두 벌 이상 생길 자리가 됐다. `rank_recent_move`
       를 이 파일에 둔 것과 같은 판단이다 — 판정 규칙은 한 곳이고, 부르는 쪽이 여럿이다.
       `ecos.daily_moves`는 여기서 재수출된 같은 함수다(사본이 아니다).
    ⚠️ 위 `daily_pcts`와 헷갈리지 말 것: 그쪽은 공급자가 **등락률을 이미 준** 경우(KRX)이고,
       이쪽은 **수준만 주는** 경우(ECOS·FRED)라 차를 직접 낸다.
    """
    moves = []
    for (_, before), (_, now) in zip(values, values[1:]):
        if move_unit == "bp":
            moves.append((now - before) * 100)
        elif before:
            moves.append((now - before) / before * 100)
    return moves


# ── 3개월 추세 (2026-08-10) ──────────────────────────────────────────────────
#
# 브리핑 첫 줄이 답할 질문이 바뀌었다: "어제 대비 방향이 바뀐 것"에서 **"최근 석 달 동안
# 가장 크게 움직인 것"**으로. 하루치 방향 전환은 노이즈가 섞이는데, 상담에서 꺼낼 이야기는
# 그것보다 긴 축이라는 판단이다.
#
# **왜 그냥 변화폭으로 줄 세우지 않나.** 다섯 지표의 단위가 다르다 — 나스닥·S&P500·원/달러는
# `%`이고 국고채10년·미국채30년은 `bp`다. `+12%`와 `+40bp` 중 무엇이 큰가는 물음 자체가
# 성립하지 않는다. 그래서 **그 지표 자신의 일간 변동으로 나눈다**(z):
#
#     z = 석 달 누적 변화 ÷ (일간 변동 표준편차 × √관측수)
#
# 단위가 상쇄되므로 다섯을 같은 축에서 견줄 수 있고, 뜻도 분명하다 — "이 지표가 평소 흔들리는
# 폭에 비해 몇 배로 움직였나". 절대 변화폭(`change`)도 함께 돌려주므로 문장은 그걸 인용한다.
#
# ⚠️ **표준편차가 0이면 z를 만들지 않는다**(None). 관측이 전부 같은 값이면 나눌 것이 없고,
#    거기서 무한대를 내면 그 지표가 늘 1등이 된다.
# ⚠️ 이 함수는 순수하다 — 조회는 공급자(`fred`·`ecos`)가 하고 판정은 여기서만 한다
#    (`rank_recent_move`를 이 파일에 둔 것과 같은 이유).
TREND_MIN_WINDOW = 20  # 이보다 짧은 창에서는 추세를 말하지 않는다(석 달을 물었는데 2주면 답이 아니다)


def trend_of(values: list[tuple[str, float]], move_unit: str) -> dict | None:
    """창 전체의 누적 변화와 그 크기 (순수·결정론적). 근거가 모자라면 **None**.

    values: `(YYYYMMDD, 값)` 오름차순 — 공급자가 주는 그대로.
    반환: `{from, from_level, to, to_level, change, unit, days, sigma, z}`
      - `change`: 창 처음 → 끝 누적 변화. 단위는 `move_unit`(`%` 또는 `bp`)이고
        **일별 움직임과 같은 관례**다(bp는 절대차 ×100, %는 비율).
      - `z`: 위 머리말의 정규화 값. 표준편차가 0이면 None.
    """
    if not values or len(values) < TREND_MIN_WINDOW:
        return None
    (first_at, first), (last_at, last) = values[0], values[-1]
    if move_unit == "bp":
        change = (last - first) * 100
    elif first:
        change = (last - first) / first * 100
    else:
        return None  # 0으로 나누지 않는다

    moves = daily_moves(values, move_unit)
    if len(moves) < 2:
        return None
    mean = sum(moves) / len(moves)
    var = sum((m - mean) ** 2 for m in moves) / (len(moves) - 1)
    sigma = var ** 0.5
    return {
        "from": first_at,
        "from_level": first,
        "to": last_at,
        "to_level": last,
        "change": change,
        "unit": move_unit,
        "days": len(values),
        "sigma": sigma,
        # √n으로 나누는 건 "누적 변화가 무작위 걸음이었다면 이만큼"이라는 기준선이다.
        "z": (change / (sigma * len(moves) ** 0.5)) if sigma else None,
    }


def rank_recent_move(pcts: list[float], latest: float | None) -> dict | None:
    """오늘 등락률이 최근 창에서 몇 번째로 큰 움직임인가 (순수·결정론적).

    pcts: 창 안의 일별 등락률 전부(오늘 포함). latest: 오늘 등락률.
    반환: {"of": 창 크기(거래일), "direction": "up"|"down"|"flat", "rank": 1~N 또는 None}
      - rank가 None이면 "평소 수준"이다(같은 방향 상위 `NOTABLE_RANK` 밖).
      - 창이 짧거나 보합이면 통째로 None — 말할 근거가 없으면 말하지 않는다.
    """
    if latest is None or latest == 0 or len(pcts) < MIN_WINDOW:
        return None
    direction = "up" if latest > 0 else "down"
    same = [p for p in pcts if (p > 0) == (latest > 0)]
    # 오늘보다 더 큰 움직임이 몇 번 있었나 + 1 = 순위. 동률이면 공동 순위가 되어
    # "가장 큰"이 둘이 될 수 있는데, 같은 폭이면 실제로 둘 다 가장 큰 것이 맞다.
    bigger = sum(1 for p in same if abs(p) > abs(latest))
    rank = bigger + 1
    return {
        "of": len(pcts),
        "direction": direction,
        "rank": rank if rank <= NOTABLE_RANK else None,
    }
