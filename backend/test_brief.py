"""F2 브리프 조립·게이트 자체 점검 (크레딧·네트워크 불필요).

실행: backend/.venv/bin/python -m backend.test_brief
"""

from backend import brief
from backend.compliance import BRIEF_NOTICE, WATERMARK

QUOTE = {
    "stock_code": "005930", "corp_name": "삼성전자", "as_of": "20260720",
    "close": "244000", "change_pct": "-4.31",
    "source": "공공데이터포털 금융위원회 주식시세정보 (일별 종가 기준, 실시간 아님)",
}
DISC = {"report_nm": "주요사항보고서", "rcept_dt": "20260720", "rcept_no": "20260720000123",
        "viewer_url": "https://dart.fss.or.kr/x"}
NEWS = {"title": "메모리 업황 회복", "link": "https://n.news.naver.com/1", "pub_date": "2026-07-20"}

FULL = [{"stock_code": "005930", "corp_name": "삼성전자",
         "quote": QUOTE, "disclosures": [DISC], "news": [NEWS]}]


def test_every_line_has_a_source():
    """제목을 뺀 모든 줄에 출처가 붙어야 한다 — 붙지 않으면 게이트가 막는다."""
    md, sentences = brief.assemble(FULL)
    body = [s for s in sentences if not s["is_heading"]]
    assert body and all(s["source"] for s in body), body
    assert brief.check(md, sentences) == []


def test_uses_brief_notice_not_note_watermark():
    md, _ = brief.assemble(FULL)
    assert BRIEF_NOTICE in md and WATERMARK not in md


def test_delayed_quote_notice_is_satisfied():
    """시세를 실으면 지연시세 체크가 발동한다 — 문구에 '지연시세'가 있어 통과해야 한다."""
    md, sentences = brief.assemble(FULL)
    assert "지연시세" in md
    assert brief.check(md, sentences) == []

    # 지연 표기를 지우면 같은 내용이라도 게이트가 막아야 한다(체크가 실제로 살아 있는지 확인)
    stripped = md.replace("지연시세(실시간 아님)", "시세")
    assert any("지연시세" in v for v in brief.check(stripped, sentences))


def test_empty_result_is_stated_not_silent():
    """조회 0건이면 빈 카드가 아니라 그 사실이 본문에 적혀야 한다."""
    md, sentences = brief.assemble(
        [{"stock_code": "000660", "corp_name": "SK하이닉스", "quote": None, "disclosures": [], "news": []}]
    )
    assert "조회된 항목이 없습니다" in md
    # 이 줄은 출처가 없으므로 게이트가 막는다 — 없는 출처를 지어내지 않는다는 뜻
    assert any("출처 없는 문장" in v for v in brief.check(md, sentences))


def test_multiple_stocks_keep_their_own_sources():
    items = FULL + [{"stock_code": "000660", "corp_name": "SK하이닉스",
                     "quote": {**QUOTE, "stock_code": "000660", "corp_name": "SK하이닉스",
                               "close": "1764000", "change_pct": "-4.23"},
                     "disclosures": [], "news": []}]
    md, sentences = brief.assemble(items)
    assert "삼성전자(005930)" in md and "SK하이닉스(000660)" in md
    assert "1,764,000원" in md  # 천단위 구분 + 종목별 값이 섞이지 않았는지
    assert brief.check(md, sentences) == []


def test_material_disclosures_outrank_ownership():
    """지분공시가 아무리 많고 최신이어도 주요사항보고가 먼저 나와야 한다.

    실제 데이터에서 삼성전자 5일치 81건이 거의 전부 임원 소유상황보고였다 —
    이 순위가 깨지면 중요 공시가 브리프에서 묻힌다.
    """
    rows = [
        {"report_nm": "임원ㆍ주요주주특정증권등소유상황보고서", "rcept_dt": "20260721", "rcept_no": "1"},
        {"report_nm": "임원ㆍ주요주주특정증권등소유상황보고서", "rcept_dt": "20260721", "rcept_no": "2"},
        {"report_nm": "주요사항보고서(자기주식취득결정)", "rcept_dt": "20260719", "rcept_no": "3"},
        {"report_nm": "분기보고서", "rcept_dt": "20260718", "rcept_no": "4"},
    ]
    picked = brief.pick_disclosures(rows, 3)
    assert [r["rcept_no"] for r in picked] == ["3", "4", "1"], picked


def test_picked_disclosures_carry_a_link():
    """화면 카드가 items에서 직접 링크를 쓰므로, 선별 단계에서 링크가 붙어야 한다.
    (안 붙으면 브리프 카드의 공시 링크가 죽는다 — 실제로 발생했던 버그)"""
    picked = brief.pick_disclosures([{"report_nm": "분기보고서", "rcept_dt": "20260721", "rcept_no": "X1"}], 1)
    assert picked[0]["viewer_url"].endswith("rcpNo=X1")
    # 문장 출처와 카드가 같은 링크를 써야 한다
    _, sentences = brief.assemble(
        [{"stock_code": "005930", "corp_name": "삼성전자", "quote": None, "disclosures": picked, "news": []}]
    )
    assert sentences[1]["source"]["viewer_url"] == picked[0]["viewer_url"]


def test_same_rank_is_newest_first():
    rows = [
        {"report_nm": "분기보고서", "rcept_dt": "20260710", "rcept_no": "old"},
        {"report_nm": "사업보고서", "rcept_dt": "20260721", "rcept_no": "new"},
    ]
    assert [r["rcept_no"] for r in brief.pick_disclosures(rows, 2)] == ["new", "old"]


def test_ownership_still_shown_when_nothing_else():
    """조용한 날에도 브리프가 비지 않도록, 지분공시는 빼지 않고 뒤로 밀기만 한다."""
    rows = [{"report_nm": "임원ㆍ주요주주특정증권등소유상황보고서", "rcept_dt": "20260721", "rcept_no": "1"}]
    assert len(brief.pick_disclosures(rows, 5)) == 1


def test_market_section_leads_and_is_sourced():
    """지수는 브리핑 맨 위에 오고(PB가 시장을 먼저 본다), 문장마다 출처가 붙어야 한다."""
    indices = [
        {"index_name": "코스피", "close": "3105.22", "change_pct": "0.42",
         "as_of": "20260721", "source": "공공데이터포털 지수시세정보"},
    ]
    content_md, sentences = brief.assemble(FULL, indices)
    assert sentences[0]["text"] == "오늘 시장" and sentences[0]["is_heading"]
    assert "코스피" in sentences[1]["text"] and "지연시세" in sentences[1]["text"]
    assert sentences[1]["source"]["type"] == "krx"
    # 지수가 실려도 게이트를 통과해야 한다(고지·출처·지연 표기가 다 있으므로).
    assert brief.check(content_md, sentences) == []


def test_market_absent_adds_no_unsourced_line():
    """지수를 못 가져왔을 때 본문에 안내 문장을 넣으면 '출처 없는 문장'으로 게이트에 걸린다 —
    미연결 사유는 본문이 아니라 market_json으로 나가고 화면이 보여준다."""
    content_md, sentences = brief.assemble(
        [{"stock_code": "005930", "corp_name": "삼성전자", "quote": None,
          "disclosures": [{"report_nm": "분기보고서", "rcept_dt": "20260721", "rcept_no": "X1",
                           "viewer_url": "https://dart.fss.or.kr/x"}], "news": []}],
        [],
    )
    assert "오늘 시장" not in content_md
    assert brief.check(content_md, sentences) == []


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
