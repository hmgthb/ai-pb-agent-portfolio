"""시장 현황(지수) 조회 — PB가 상담 전에 먼저 보는 "오늘 시장".

종목 시세(krx_quote)와 같은 공공데이터포털 계열이지만 **서비스가 다르다**(지수시세정보).
서비스별로 활용신청이 따로 필요해서, 신청 전 키로 부르면 403이 온다.

그 경우 **조용히 빈 값으로 넘기지 않는다** — 사유를 함께 돌려줘서 화면이 "미연결"이라고
말할 수 있게 한다(HANDOFF §2: 실화면은 목업으로 폴백하지 않는다). 지수가 없는 브리프와
지수를 못 불러온 브리프는 PB에게 전혀 다른 정보다.

# 확인 필요: 응답 필드명(idxNm/clpr/vs/fltRt/basDt)은 공공데이터포털 명세 기준으로
# 작성했고 **실호출로 검증하지 못했다**(2026-07-22 기준 이 키가 지수시세정보에 미신청 →
# 403 Forbidden). 필드명이 다르면 KeyError로 즉시 드러나게 두었다 — None으로 채우지 않는다.
# 활용신청: 공공데이터포털 > "금융위원회_지수시세정보" > 활용신청(개발계정 자동승인).
"""

import os
from datetime import date, timedelta

import requests
from dotenv import load_dotenv

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

    today = date.today()
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
    reasons: list[str] = []
    for name in INDEX_NAMES:
        try:
            indices.append(fetch_index(name))
        except MarketDataUnavailable as e:
            reasons.append(f"{name}: {e}")
    if indices:
        return indices, "; ".join(reasons) or None
    return [], "; ".join(reasons) or "지수를 가져오지 못했습니다."
