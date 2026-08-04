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

# 상담 전 시장 한 줄에 필요한 최소 구성. 환율·금리는 이 서비스에 없어 별도 소스가 필요하다
# (로드맵 — 지금 없는 걸 있는 것처럼 채우지 않는다).
INDEX_NAMES = ("코스피", "코스닥")

LOOKBACK_DAYS = 10

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
        "change": latest.get("vs"),
        "change_pct": latest["fltRt"],
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
