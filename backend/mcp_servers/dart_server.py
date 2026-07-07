"""DART OpenAPI를 감싼 MCP 서버.

search / fetch / parse 3개 도구로 나눠서 stdio로 노출한다.
- dart_search: 종목코드로 최근 공시 목록 검색
- dart_fetch:  특정 공시(rcept_no)의 원문 링크 + 첨부파일 목록 조회
- dart_parse:  재무제표에서 매출액·영업이익 등 핵심 수치 추출
"""

import io
import os
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from typing import Literal

import requests
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

load_dotenv()

API_KEY = os.environ["DART_API_KEY"]
mcp = FastMCP("dart")

TARGET_ACCOUNTS = ["매출액", "영업이익"]
# 손익계산서는 회사마다 IS(손익계산서)/CIS(포괄손익계산서)로 신고 방식이 다르고,
# 계정명도 "영업이익(손실)"처럼 접미사가 붙는 경우가 있어 접두어 매칭이 필요하다.
INCOME_STATEMENT_DIVS = ("IS", "CIS")


def _get_corp_code(stock_code: str) -> tuple[str, str]:
    resp = requests.get(
        "https://opendart.fss.or.kr/api/corpCode.xml",
        params={"crtfc_key": API_KEY},
        timeout=30,
    )
    resp.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        xml_bytes = zf.read("CORPCODE.xml")

    root = ET.fromstring(xml_bytes)
    for item in root.iter("list"):
        if item.findtext("stock_code", "").strip() == stock_code:
            return item.findtext("corp_code"), item.findtext("corp_name")
    raise ValueError(f"stock_code {stock_code} not found in corpCode.xml")


MAX_SEARCH_PAGES = 10  # page_count(100건)x10 = 최대 1000건 — 그 이상 필요하면 days를 줄여서 다시 검색


@mcp.tool()
def dart_search(
    stock_code: str,
    days: int = 90,
    pblntf_ty: Literal["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"] | None = None,
) -> list[dict]:
    """종목코드(6자리)로 공시 목록을 검색한다. 예: 삼성전자 -> "005930".

    사업보고서·분기보고서 등 정기공시의 출처를 찾을 때는 pblntf_ty="A"(정기공시)로
    좁혀서 검색해라 — 공시가 잦은 종목은 필터 없이는 페이지를 아무리 넘겨도
    옛 정기공시가 최근 공시들에 묻혀서 안 나올 수 있다.
    (A=정기공시 B=주요사항보고 C=발행공시 D=지분공시 E=기타공시 F=외부감사관련
     G=펀드공시 H=자산유동화 I=거래소공시 J=공정위공시)

    기간 내 전체 페이지를 모아서 반환한다.
    반환된 각 항목의 rcept_no를 dart_fetch에 넘기면 원문을 가져올 수 있다.
    """
    corp_code, corp_name = _get_corp_code(stock_code)

    end = date.today()
    start = end - timedelta(days=days)
    items: list[dict] = []
    page_no = 1

    while True:
        params = {
            "crtfc_key": API_KEY,
            "corp_code": corp_code,
            "bgn_de": start.strftime("%Y%m%d"),
            "end_de": end.strftime("%Y%m%d"),
            "page_count": 100,  # DART API 최대치
            "page_no": page_no,
        }
        if pblntf_ty:
            params["pblntf_ty"] = pblntf_ty
        resp = requests.get(
            "https://opendart.fss.or.kr/api/list.json",
            params=params,
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        if data["status"] == "013":  # 조회된 데이터 없음
            break
        if data["status"] != "000":
            raise RuntimeError(f"DART API error {data['status']}: {data['message']}")

        items.extend(data.get("list", []))
        if page_no >= data.get("total_page", 1) or page_no >= MAX_SEARCH_PAGES:
            break
        page_no += 1

    return [
        {
            "rcept_no": d["rcept_no"],
            "report_nm": d["report_nm"],
            "rcept_dt": d["rcept_dt"],
            "flr_nm": d["flr_nm"],
            "corp_name": corp_name,
            "corp_code": corp_code,
        }
        for d in items
    ]


@mcp.tool()
def dart_fetch(rcept_no: str) -> dict:
    """접수번호(rcept_no)로 공시 원문 뷰어 링크와 첨부 원본파일 목록을 가져온다.

    dart_search 결과의 rcept_no를 그대로 넣는다.
    """
    viewer_url = f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={rcept_no}"

    resp = requests.get(
        "https://opendart.fss.or.kr/api/document.xml",
        params={"crtfc_key": API_KEY, "rcept_no": rcept_no},
        timeout=30,
    )
    resp.raise_for_status()

    try:
        with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
            files = [{"name": n, "size_bytes": zf.getinfo(n).file_size} for n in zf.namelist()]
    except zipfile.BadZipFile:
        files = []

    return {"rcept_no": rcept_no, "viewer_url": viewer_url, "files": files}


@mcp.tool()
def dart_parse(
    stock_code: str,
    bsns_year: str,
    reprt_code: Literal["11011", "11012", "11013", "11014"] = "11011",
    fs_div: Literal["CFS", "OFS"] = "CFS",
) -> dict:
    """재무제표에서 매출액·영업이익(당기/전기)을 추출한다.

    reprt_code: 11011=사업보고서(연간) 11012=반기 11013=1분기 11014=3분기.
    fs_div: CFS=연결재무제표 OFS=개별재무제표.
    """
    corp_code, corp_name = _get_corp_code(stock_code)

    resp = requests.get(
        "https://opendart.fss.or.kr/api/fnlttSinglAcntAll.json",
        params={
            "crtfc_key": API_KEY,
            "corp_code": corp_code,
            "bsns_year": bsns_year,
            "reprt_code": reprt_code,
            "fs_div": fs_div,
        },
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    if data["status"] != "000":
        raise RuntimeError(f"DART API error {data['status']}: {data['message']}")

    figures: dict[str, dict[str, str]] = {}
    for item in data["list"]:
        if item["sj_div"] not in INCOME_STATEMENT_DIVS:
            continue
        matched = next((t for t in TARGET_ACCOUNTS if item["account_nm"].startswith(t)), None)
        if matched and matched not in figures:
            figures[matched] = {"당기": item["thstrm_amount"], "전기": item["frmtrm_amount"]}

    return {
        "corp_name": corp_name,
        "stock_code": stock_code,
        "bsns_year": bsns_year,
        "fs_div": fs_div,
        "figures": figures,
    }


if __name__ == "__main__":
    mcp.run(transport="stdio")
