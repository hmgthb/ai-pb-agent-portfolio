"""DART 재무제표 파싱 확인 스크립트.

raw XBRL(zip) 대신 DART가 이미 계정과목 단위로 파싱해주는
`fnlttSinglAcntAll` API를 쓴다 (실무에서 흔히 쓰는 방식 — taxonomy를
직접 해석하는 raw XBRL 파싱은 이 목적엔 불필요하게 복잡하다).
"""

import os

import requests
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.environ["DART_API_KEY"]
CORP_CODE = "00126380"  # 삼성전자 (dart_check.py에서 확인)
TARGET_ACCOUNTS = ["매출액", "영업이익"]


def get_financial_statement(corp_code: str, bsns_year: str, reprt_code: str, fs_div: str) -> list[dict]:
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
    return data["list"]


if __name__ == "__main__":
    bsns_year = "2024"
    reprt_code = "11011"  # 사업보고서(연간)

    items = get_financial_statement(CORP_CODE, bsns_year, reprt_code, fs_div="CFS")

    print(f"삼성전자 {bsns_year}년 사업보고서(연결) — 손익계산서 주요 항목\n")
    for item in items:
        if item["sj_div"] == "IS" and item["account_nm"] in TARGET_ACCOUNTS:
            print(
                f"- {item['account_nm']}: 당기 {item['thstrm_amount']} / "
                f"전기 {item['frmtrm_amount']} (단위: 원)"
            )
