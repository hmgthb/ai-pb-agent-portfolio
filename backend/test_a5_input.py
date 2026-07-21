"""A5 직접 실행 경로의 입력 조립 자체 점검 (크레딧·네트워크 불필요).

실행: backend/.venv/bin/python -m backend.test_a5_input

a5는 위임이 아니라 backend의 2차 query()로 돈다(HANDOFF §1). 그래서 a5가 각주로 쓸
URL·접수번호가 여기서 그대로 실려 나가는지가 곧 출처 무결성이다 — O가 텍스트로 옮겨
적던 경로를 없앤 이유가 이것이다.
"""

from backend.main import _a5_input, _agent_prompt, _resolve_corp_name

FINANCIALS = {
    "corp_name": "삼성전자",
    "stock_code": "005930",
    "bsns_year": "2024",
    "fs_div": "CFS",
    "figures": {
        "매출액": {"당기": "300870903000000", "전기": "258935494000000"},
        "영업이익": {"당기": "32725961000000", "전기": "6566976000000"},
    },
}
NEWS = [
    {
        "title": "삼성전자, 로봇사업조직 신설",
        "description": "미래 성장동력 사업화를 추진한다.",
        "link": "https://www.yna.co.kr/view/AKR20260721046100003",
        "pub_date": "Tue, 21 Jul 2026 09:00:00 +0900",
    }
]
DART_SOURCES = {
    "20250311001085": {
        "viewer_url": "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20250311001085",
        "rcept_dt": "20250311",
    }
}


def test_agent_prompt_strips_frontmatter():
    """프론트매터(name·model·주석)가 system_prompt에 새어 들어가면 안 된다."""
    prompt = _agent_prompt("a5")
    assert prompt.startswith("너는 A5"), prompt[:80]
    assert "model: opus" not in prompt
    assert "description:" not in prompt
    # 지침 본문은 살아 있어야 한다
    assert "각주" in prompt


def test_sources_survive_verbatim():
    """각주 태그의 원천 — rcpNo 숫자와 뉴스 링크가 손대지 않은 채 실려야 한다."""
    text = _a5_input("삼성전자", "005930", FINANCIALS, NEWS, DART_SOURCES)
    assert "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20250311001085" in text
    assert "https://www.yna.co.kr/view/AKR20260721046100003" in text
    assert "20250311" in text


def test_figures_are_readable_but_unconverted():
    """천단위 구분만 넣고 '조원' 같은 단위 환산은 하지 않는다 — 환산은 a5가 원문 기준으로
    판단할 몫이고, backend가 반올림하면 노트 수치와 공시 원문이 어긋난다."""
    text = _a5_input("삼성전자", "005930", FINANCIALS, NEWS, DART_SOURCES)
    assert "300,870,903,000,000원" in text
    assert "조원" not in text


def test_partial_data_does_not_crash():
    """공시만 있고 뉴스가 없는 날(또는 그 반대)에도 조립은 성공해야 한다."""
    only_news = _a5_input("삼성전자", "005930", None, NEWS, {})
    assert "A4" in only_news and "A2" not in only_news
    only_fin = _a5_input("삼성전자", "005930", FINANCIALS, [], DART_SOURCES)
    assert "A2" in only_fin and "A4" not in only_fin


def test_missing_amount_is_not_fabricated():
    """수치가 비어 오면 0으로 채우지 말고 원문 그대로 둔다."""
    broken = {"bsns_year": "2024", "fs_div": "CFS", "figures": {"매출액": {"당기": "-", "전기": ""}}}
    text = _a5_input("삼성전자", "005930", broken, [], {})
    assert "당기 -원" in text
    assert "0원" not in text


def test_corp_name_prefers_dart_over_prose():
    """a1의 산문은 비동기 위임 탓에 라이브에서 대체로 비어 온다 — 실제로 그 폴백 때문에
    법인명 자리에 종목코드('005930')가 저장된 노트가 있었다."""
    assert _resolve_corp_name(FINANCIALS, None, "005930") == "삼성전자"
    assert _resolve_corp_name(FINANCIALS, "종목코드 005930 = 없는회사", "005930") == "삼성전자"


def test_corp_name_falls_back_without_fabricating():
    assert _resolve_corp_name(None, "종목코드 005930 = **삼성전자**", "005930") == "삼성전자"
    # 어느 쪽도 없으면 종목코드 — 그럴듯한 이름을 지어내면 안 된다
    assert _resolve_corp_name(None, None, "005930") == "005930"
    assert _resolve_corp_name({"figures": {}}, None, "005930") == "005930"


def test_untrusted_data_is_labeled():
    """가드레일 5 — 넘기는 데이터가 신뢰할 수 없는 입력임을 명시해야 한다."""
    text = _a5_input("삼성전자", "005930", FINANCIALS, NEWS, DART_SOURCES)
    assert "신뢰하지 않는 데이터" in text


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
