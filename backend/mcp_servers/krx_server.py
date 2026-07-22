"""공공데이터포털 금융위원회 주식시세정보를 감싼 MCP 서버.

- krx_quote: 종목코드로 최근 영업일 종가·등락률·거래량 조회
- krx_index: 지수(코스피·코스닥)의 최근 영업일 종가·등락률 조회 — 상담 전 "오늘 시장" 한 줄

이 API가 주는 건 실시간이 아니라 **일별 종가 기준 시세**다 — 그래서 산출물에는 반드시
지연시세임을 밝혀야 하고(backend/compliance.py의 지연시세 체크), 기준일자(basDt)를
출처 시점으로 함께 노출한다.

# 확인 필요: 응답 필드명(clpr/fltRt/trqu 등)은 공공데이터포털 명세 기준으로 작성했고
# 실제 키로 호출해 검증하지 못했다(키 미발급). 첫 실호출 때 _pick_latest가 KeyError를
# 그대로 띄우도록 두었으니, 필드명이 다르면 즉시 드러난다 — 조용히 None으로 채우지 않는다.
"""

import os
from datetime import date, timedelta

import requests
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

from backend import market

load_dotenv()

API_KEY = os.environ["KRX_API_KEY"]
ENDPOINT = (
    "https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo"
)
mcp = FastMCP("krx")

# 연휴가 길어도 직전 영업일이 잡히도록 넉넉히 뒤로 본다.
LOOKBACK_DAYS = 14


def _pick_latest(items: list[dict]) -> dict:
    """조회 구간 안에서 기준일자가 가장 최근인 항목을 고른다."""
    return max(items, key=lambda i: i["basDt"])


@mcp.tool()
def krx_quote(stock_code: str) -> dict:
    """종목코드(6자리)의 최근 영업일 지연시세를 조회한다. 예: "005930".

    실시간 시세가 아니라 일별 종가 기준이다. 반환값의 as_of(기준일자)를 출처 시점으로
    쓰고, 인용 시 지연시세임을 반드시 함께 밝힌다.
    """
    today = date.today()
    resp = requests.get(
        ENDPOINT,
        params={
            "serviceKey": API_KEY,
            "resultType": "json",
            "numOfRows": 30,
            "pageNo": 1,
            "likeSrtnCd": stock_code,
            "beginBasDt": (today - timedelta(days=LOOKBACK_DAYS)).strftime("%Y%m%d"),
            "endBasDt": today.strftime("%Y%m%d"),
        },
        timeout=30,
    )
    resp.raise_for_status()

    body = resp.json()["response"]["body"]
    items = body.get("items") or {}
    rows = items.get("item") or []
    if isinstance(rows, dict):  # 결과가 1건이면 리스트가 아니라 dict로 온다
        rows = [rows]
    # 단축코드 부분일치(likeSrtnCd)라 다른 종목이 섞일 수 있어 정확히 일치하는 것만 남긴다.
    rows = [r for r in rows if r.get("srtnCd") == stock_code]
    if not rows:
        raise ValueError(
            f"종목코드 {stock_code}의 최근 {LOOKBACK_DAYS}일 시세를 찾지 못했습니다 "
            "(상장폐지·신규상장·휴장이 길었는지 확인하세요)."
        )

    latest = _pick_latest(rows)
    return {
        "stock_code": latest["srtnCd"],
        "corp_name": latest["itmsNm"],
        "market": latest.get("mrktCtg"),
        "as_of": latest["basDt"],  # 기준일자 = 출처 시점
        "close": latest["clpr"],
        "change": latest["vs"],
        "change_pct": latest["fltRt"],
        "volume": latest["trqu"],
        "is_delayed": True,
        "source": "공공데이터포털 금융위원회 주식시세정보 (일별 종가 기준, 실시간 아님)",
    }


@mcp.tool()
def krx_index(index_name: str = "코스피") -> dict:
    """지수(예: "코스피", "코스닥")의 최근 영업일 지연 지수를 조회한다.

    종목 시세와 마찬가지로 일별 종가 기준이다 — 인용 시 지연 데이터임을 함께 밝힌다.
    조회 로직은 backend/market.py에 있다(브리프 조립도 같은 함수를 쓴다 — 화면과 에이전트가
    다른 숫자를 보지 않게 하려면 출처가 하나여야 한다).
    """
    return market.fetch_index(index_name)


if __name__ == "__main__":
    mcp.run(transport="stdio")
