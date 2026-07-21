"""F2 브리프 — 도구 결과를 어느 종목에 귀속시키는지 자체 점검 (크레딧·네트워크 불필요).

실행: backend/.venv/bin/python -m backend.test_brief_attribution

배경: 원래 귀속은 위임문에서 "처음 나온 종목코드"를 집는 방식이었다. 2026-07-21 라이브
점검에서 이 방식이 실제로 틀린 사례는 발견되지 않았지만(브리프 결과는 DART 원본과 일치),
**틀려도 티가 안 나는** 종류라 도구 입력(stock_code)·법인명 대조로 바꾸고 여기에 고정한다.

⚠️ 이 점검을 하다가 SK하이닉스 공시 0건을 "유실"로 오진했었다. 파이프라인은 days=2로
조회하는데 7일 창과 비교했기 때문이다. **원본과 대조할 때는 파이프라인과 같은 조건으로
조회할 것.**
"""

from backend.main import _attribute_news, _code_from_delegation

CODES = ["005930", "000660", "005380"]

QUOTES = {
    "005930": {"stock_code": "005930", "corp_name": "삼성전자"},
    "000660": {"stock_code": "000660", "corp_name": "SK하이닉스"},
    "005380": {"stock_code": "005380", "corp_name": "현대차"},
}


def test_single_code_in_delegation():
    assert _code_from_delegation({"prompt": "000660의 최근 공시를 조회해줘"}, CODES) == "000660"


def test_ambiguous_delegation_is_dropped_not_guessed():
    """앞 종목이 함께 언급되면 예전 코드는 005930을 집었다(조용한 오귀속).
    모호하면 귀속하지 않는다: 남의 종목 브리프에 엉뚱한 공시를 싣느니 비는 게 낫다."""
    ambiguous = {"prompt": "005930과 마찬가지로 000660의 공시도 조회해줘"}
    assert _code_from_delegation(ambiguous, CODES) is None


def test_no_code_in_delegation():
    assert _code_from_delegation({"prompt": "뉴스를 정리해줘"}, CODES) is None


def test_news_attributed_by_corp_name():
    """a4는 법인명으로 검색하므로 검색어를 법인명과 대조하면 위임문 추측이 필요 없다."""
    pending = [
        ("SK하이닉스 실적", None, [{"title": "하이닉스 뉴스"}]),
        ("삼성전자 로봇", None, [{"title": "삼성 뉴스"}]),
    ]
    news = _attribute_news(pending, QUOTES, CODES)
    assert [n["title"] for n in news["000660"]] == ["하이닉스 뉴스"]
    assert [n["title"] for n in news["005930"]] == ["삼성 뉴스"]


def test_news_falls_back_to_delegation_when_name_unmatched():
    pending = [("반도체 업황", "000660", [{"title": "업황 뉴스"}])]
    news = _attribute_news(pending, QUOTES, CODES)
    assert [n["title"] for n in news["000660"]] == ["업황 뉴스"]


def test_unattributable_news_is_dropped():
    """법인명도 못 맞추고 위임문도 모호하면 버린다 (가드레일 3)."""
    pending = [("반도체 업황", None, [{"title": "떠도는 뉴스"}])]
    assert _attribute_news(pending, QUOTES, CODES) == {}


def test_corp_name_match_wins_over_delegation_fallback():
    """검색어가 법인명을 정확히 가리키면, 위임문 폴백이 다른 종목을 가리켜도 검색어가 이긴다."""
    pending = [("현대차 판매량", "005930", [{"title": "현대차 뉴스"}])]
    news = _attribute_news(pending, QUOTES, CODES)
    assert "005930" not in news
    assert [n["title"] for n in news["005380"]] == ["현대차 뉴스"]


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
