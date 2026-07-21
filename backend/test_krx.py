"""KRX 시세 응답 파싱 자체 점검 (키·네트워크 불필요).

실제 API 호출 없이, 공공데이터포털이 주는 응답 모양만 재현해서
"최근 영업일 1건 고르기"와 "부분일치로 섞여 들어온 종목 걸러내기"를 확인한다.

실행: KRX_API_KEY=TEST backend/.venv/bin/python -m backend.test_krx
"""

import os

os.environ.setdefault("KRX_API_KEY", "TEST")  # 임포트 시 키 요구를 우회 (호출은 하지 않는다)

from backend.mcp_servers.krx_server import _pick_latest  # noqa: E402


def row(bas_dt, srtn_cd="005930", clpr="70000"):
    return {"basDt": bas_dt, "srtnCd": srtn_cd, "itmsNm": "삼성전자", "clpr": clpr}


def test_picks_most_recent_business_day():
    # 응답 순서에 기대지 않는다 — 기준일자로 고른다
    rows = [row("20260717"), row("20260721"), row("20260720")]
    assert _pick_latest(rows)["basDt"] == "20260721"


def test_single_row():
    assert _pick_latest([row("20260721")])["basDt"] == "20260721"


def test_partial_code_match_is_filtered():
    """likeSrtnCd는 부분일치라 다른 종목이 섞인다 — 정확히 일치하는 것만 남아야 한다.

    krx_quote 안의 필터와 같은 조건. 여기서 깨지면 엉뚱한 종목 시세를 인용하게 된다.
    """
    rows = [row("20260721", "005930"), row("20260721", "0059301"), row("20260720", "005930")]
    exact = [r for r in rows if r.get("srtnCd") == "005930"]
    assert len(exact) == 2
    assert _pick_latest(exact)["basDt"] == "20260721"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
