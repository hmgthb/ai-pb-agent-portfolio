"""DART OpenAPI 첫 호출 확인 스크립트.

1. corpCode.xml을 받아 종목코드(stock_code) -> corp_code 매핑을 만든다.
2. 삼성전자(005930)의 corp_code를 찾는다.
3. 최근 공시 목록을 조회해 출력한다.
"""

import io
import os
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, timedelta

import requests
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.environ["DART_API_KEY"]
TARGET_STOCK_CODE = "005930"  # 삼성전자


def get_corp_code(stock_code: str) -> tuple[str, str]:
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


def get_recent_disclosures(corp_code: str) -> list[dict]:
    end = date.today()
    start = end - timedelta(days=90)
    resp = requests.get(
        "https://opendart.fss.or.kr/api/list.json",
        params={
            "crtfc_key": API_KEY,
            "corp_code": corp_code,
            "bgn_de": start.strftime("%Y%m%d"),
            "end_de": end.strftime("%Y%m%d"),
            "page_count": 10,
        },
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    if data["status"] != "000":
        raise RuntimeError(f"DART API error {data['status']}: {data['message']}")
    return data.get("list", [])


if __name__ == "__main__":
    corp_code, corp_name = get_corp_code(TARGET_STOCK_CODE)
    print(f"corp_code 매핑: {TARGET_STOCK_CODE} ({corp_name}) -> {corp_code}")

    disclosures = get_recent_disclosures(corp_code)
    print(f"\n최근 90일 공시 {len(disclosures)}건:")
    for d in disclosures:
        print(f"- [{d['rcept_dt']}] {d['report_nm']} ({d['flr_nm']})")

    if not disclosures:
        print("(공시 없음 — 기간을 늘려 확인 필요)")
        sys.exit(0)
