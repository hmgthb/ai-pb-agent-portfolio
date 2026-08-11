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


def test_material_disclosures_outrank_insider_reports():
    """임원 보고가 아무리 많고 최신이어도 주요사항보고가 먼저 나와야 한다.

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
    assert [r["rcept_no"] for r in picked] == ["3", "4", "1", "2"], picked


def test_insider_reports_have_their_own_quota():
    """임원 보고는 limit을 먹지 않는다 — 조용한 날 카드를 그것이 다 채우던 원인(2026-08-06).

    limit(=2)은 그 밖의 것에만 걸리고, 임원 보고는 별도 몫으로 뒤에 붙는다.
    """
    rows = [{"report_nm": "임원ㆍ주요주주특정증권등소유상황보고서",
             "rcept_dt": "20260721", "rcept_no": f"own{i}"} for i in range(9)]
    rows += [{"report_nm": "분기보고서", "rcept_dt": "20260720", "rcept_no": "reg"}]
    picked = brief.pick_disclosures(rows, 2, insider_limit=3)
    assert [r["rcept_no"] for r in picked] == ["reg", "own0", "own1", "own2"], picked
    # 등급이 화면까지 실려야 한다 — 프론트가 이름 매칭을 다시 하면 규칙이 두 벌이 된다.
    assert [r["importance"] for r in picked] == ["periodic", "insider", "insider", "insider"]


def test_supply_contract_outranks_insider_report():
    """수주·배당 같은 상담거리가 `기타`로 떨어져 접히는 줄 바로 앞에 서던 것을 고쳤다."""
    rows = [
        {"report_nm": "임원ㆍ주요주주특정증권등소유상황보고서", "rcept_dt": "20260721", "rcept_no": "own"},
        {"report_nm": "단일판매ㆍ공급계약체결", "rcept_dt": "20260719", "rcept_no": "deal"},
    ]
    picked = brief.pick_disclosures(rows, 5)
    assert [r["importance"] for r in picked] == ["major", "insider"], picked


def test_five_percent_rule_is_not_folded_with_insider_reports():
    """5%룰 보고(`주식등의대량보유상황보고서`)는 접히면 안 된다 — 이름만 비슷하고 무게가 반대다.

    실화면에서 이게 접힌 줄로 내려가 있었다(2026-08-06). 누가 지분을 5% 이상 사거나 팔았다는
    신고이고 자주 나오지도 않는다 — PB가 상담에서 말할 거리다.
    """
    rows = [
        {"report_nm": "임원ㆍ주요주주특정증권등소유상황보고서", "rcept_dt": "20260805", "rcept_no": "own"},
        {"report_nm": "주식등의대량보유상황보고서(일반)", "rcept_dt": "20260805", "rcept_no": "5pct"},
        {"report_nm": "풍문또는보도에대한해명(미확정)", "rcept_dt": "20260805", "rcept_no": "rumor"},
    ]
    picked = brief.pick_disclosures(rows, 5)
    assert [r["rcept_no"] for r in picked] == ["5pct", "rumor", "own"], picked
    assert [r["importance"] for r in picked] == ["major", "major", "insider"], picked


def test_price_movement_inquiry_is_not_treated_as_material():
    """조회공시 중 **시황변동**은 맨 위가 아니다 — 답변이 대개 "중요한 정보 없음" 한 줄이라
    풍문·보도 해명과 같은 자리에 두면 위를 그게 차지한다(2026-08-06 좁힘).

    풍문 건은 이름의 `풍문`으로 이미 잡히므로, 넓은 `조회공시요구`는 필요 없고 해롭기만 하다.
    """
    rows = [
        {"report_nm": "조회공시요구(시황변동)에대한답변", "rcept_dt": "20260805", "rcept_no": "vol"},
        {"report_nm": "조회공시요구(풍문또는보도)에대한답변", "rcept_dt": "20260804", "rcept_no": "rumor"},
    ]
    picked = brief.pick_disclosures(rows, 5)
    assert [r["rcept_no"] for r in picked] == ["rumor", "vol"], picked
    assert [r["importance"] for r in picked] == ["major", "other"], picked


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


def test_insider_reports_still_shown_when_nothing_else():
    """조용한 날에도 브리프가 비지 않도록, 임원 보고는 빼지 않고 뒤로 밀기만 한다."""
    rows = [{"report_nm": "임원ㆍ주요주주특정증권등소유상황보고서", "rcept_dt": "20260721", "rcept_no": "1"}]
    assert len(brief.pick_disclosures(rows, 5)) == 1


def test_news_roundup_is_pushed_back_not_dropped():
    """종목 나열식 시황이 최신이라는 이유로 앞자리를 가져가면 안 된다 — 뒤로 밀되 빼지 않는다."""
    rows = [
        {"title": "[특징주] 삼성전자, 외국인 매수에 강세", "link": "u1", "pub_date": "2026-07-21"},
        {"title": "삼성전자, HBM4 양산 준비 마무리", "link": "u2", "pub_date": "2026-07-20"},
    ]
    picked = brief.pick_news(rows, "삼성전자", 3)
    assert [r["link"] for r in picked] == ["u2", "u1"], picked


def test_news_same_headline_from_many_outlets_counts_once():
    """같은 기사가 매체만 달리해 3건 오면 뉴스 칸이 그것 하나로 다 찬다."""
    rows = [
        {"title": "삼성전자 HBM4 양산 준비 마무리", "link": "a", "pub_date": "2026-07-21"},
        {"title": "삼성전자 HBM4 양산 준비 마무리", "link": "b", "pub_date": "2026-07-21"},
        {"title": "삼성전자, 미국 신공장 가동", "link": "c", "pub_date": "2026-07-19"},
    ]
    assert [r["link"] for r in brief.pick_news(rows, "삼성전자", 3)] == ["a", "c"]


def test_news_keeps_newest_first_within_same_rank():
    rows = [
        {"title": "삼성전자 A", "link": "old", "pub_date": "2026-07-18"},
        {"title": "삼성전자 B", "link": "new", "pub_date": "2026-07-21"},
    ]
    assert [r["link"] for r in brief.pick_news(rows, "삼성전자", 2)] == ["new", "old"]


# ── 브리핑의 문법 (A 리드 · B 평소 대비 · C 조용한 줄) ─────────────────────────

def test_recent_move_phrasing():
    """등수를 그대로 적지 않고 상위 셋만 이름을 갖는다. **평범하면 아무 말도 안 한다.**

    `평소 수준`을 적던 것을 걷어냈다(2026-08-06) — 카드 셋에 매일 붙어 정작 다를 때의 문구가
    그 사이에 묻혔다. 꼬리표가 하는 일은 "평소와 다른가" 하나이고, 다르지 않으면 말할 게 없다.
    """
    # ⚠️ **관측 수(`of`)를 문구에 적지 않는다**(2026-08-11). `26거래일 중 …`은 읽는 사람에게
    #    아무 뜻이 아니었다 — 26이 긴지 짧은지, 왜 하필 26인지가 화면 어디에도 없다. 그건
    #    기간이 아니라 그 창에서 실제로 잡힌 관측 수라 지표마다 다르게 나온다.
    #    구간은 **달력으로** 말하고(조회 창 30~40일), 세는 일은 그대로 한다(`of`는 저장된다).
    assert brief.recent_move_text({"of": 20, "direction": "down", "rank": 1}) == "최근 한 달 남짓 사이 가장 큰 하락"
    assert brief.recent_move_text({"of": 18, "direction": "up", "rank": 3}) == "최근 한 달 남짓 사이 세 번째로 큰 상승"
    # 같은 판정이면 관측 수가 달라도 **같은 문구**다 — 문구가 창 크기를 나르지 않는다.
    assert brief.recent_move_text({"of": 9, "direction": "up", "rank": 3}) == brief.recent_move_text(
        {"of": 28, "direction": "up", "rank": 3}
    )
    assert brief.recent_move_text({"of": 20, "direction": "up", "rank": None}) is None
    # 창이 짧거나 보합이면 꼬리표 자체를 안 단다 — 근거가 얇은 자리를 말로 채우지 않는다.
    assert brief.recent_move_text(None) is None


def test_quote_line_carries_the_comparison_and_stays_sourced():
    """꼬리표는 같은 시세에서 나온 것이라 문장을 쪼개지 않는다 — 출처 하나로 게이트를 통과한다."""
    q = {**QUOTE, "recent": {"of": 20, "direction": "down", "rank": 1}}
    md, sentences = brief.assemble(
        [{"stock_code": "005930", "corp_name": "삼성전자", "quote": q, "disclosures": [], "news": []}]
    )
    assert "최근 한 달 남짓 사이 가장 큰 하락" in md
    assert brief.check(md, sentences) == []


MAJOR = {"report_nm": "단일판매ㆍ공급계약체결", "rcept_dt": "20260805", "rcept_no": "M1",
         "viewer_url": "https://dart.fss.or.kr/m1", "importance": "major"}
INSIDER = {"report_nm": "임원ㆍ주요주주특정증권등소유상황보고서", "rcept_dt": "20260806",
           "rcept_no": "I1", "viewer_url": "https://dart.fss.or.kr/i1", "importance": "insider"}


def test_lead_picks_the_major_disclosure():
    """리드는 새 문장이 아니라 **이미 있는 줄 하나를 고른 것**이다 — 링크까지 그대로 따라온다."""
    items = [
        {"stock_code": "005930", "corp_name": "삼성전자", "quote": QUOTE,
         "disclosures": [INSIDER], "news": []},
        {"stock_code": "000660", "corp_name": "SK하이닉스", "quote": QUOTE,
         "disclosures": [MAJOR], "news": []},
    ]
    lead = brief.pick_lead(items)
    assert lead["reason"] == "disclosure"
    assert lead["stock_code"] == "000660" and lead["corp_name"] == "SK하이닉스"
    assert lead["text"] == "단일판매ㆍ공급계약체결"
    assert lead["href"] == "https://dart.fss.or.kr/m1"
    # 주요 공시가 있으면 조용한 줄은 나오지 않는다 — 둘이 같이 뜨면 서로 반대말이 된다.
    assert brief.quiet_note(items) is None


def test_lead_falls_back_to_the_biggest_move():
    """주요 공시가 없으면 창에서 **가장 컸던** 움직임이 리드가 된다. 2·3위는 고르지 않는다."""
    big = {**QUOTE, "recent": {"of": 20, "direction": "down", "rank": 1}}
    second = {**QUOTE, "recent": {"of": 20, "direction": "up", "rank": 2}}
    items = [
        {"stock_code": "000660", "corp_name": "SK하이닉스", "quote": second,
         "disclosures": [], "news": []},
        {"stock_code": "005930", "corp_name": "삼성전자", "quote": big,
         "disclosures": [INSIDER], "news": []},
    ]
    lead = brief.pick_lead(items)
    assert lead["reason"] == "move" and lead["stock_code"] == "005930"
    assert lead["text"] == "최근 한 달 남짓 사이 가장 큰 하락"
    # 시세에는 열어 볼 원문이 없다 — 링크를 지어내지 않는다.
    assert lead["href"] is None


def test_lead_is_none_when_nothing_stands_out():
    items = [{"stock_code": "005930", "corp_name": "삼성전자", "quote": QUOTE,
              "disclosures": [INSIDER], "news": [NEWS]}]
    assert brief.pick_lead(items) is None
    assert brief.quiet_note(items) == "1종목 모두 주요 공시가 없고, 밤사이 뉴스는 1건입니다."


def test_quiet_note_says_so_when_even_news_is_empty():
    items = [{"stock_code": "005930", "corp_name": "삼성전자", "quote": QUOTE,
              "disclosures": [], "news": []}]
    assert brief.quiet_note(items) == "1종목 모두 주요 공시·밤사이 뉴스가 없습니다."


def test_marks_what_is_new_since_yesterday():
    """어제 브리프에 있던 것과 오늘 처음 뜬 것을 가른다 — 비교는 공짜다(DB에 이미 있다)."""
    yesterday = [{"stock_code": "005930", "corp_name": "삼성전자",
                  "disclosures": [{"rcept_no": "OLD"}],
                  "news": [{"title": "메모리 업황 회복"}]}]
    today = [{"stock_code": "005930", "corp_name": "삼성전자", "quote": QUOTE,
              "disclosures": [{"rcept_no": "OLD"}, {"rcept_no": "NEW"}],
              "news": [{"title": "메모리 업황 회복"}, {"title": "미국 신공장 가동"}]}]
    marked = brief.mark_new(today, brief.seen_keys(yesterday))
    assert [d["is_new"] for d in marked[0]["disclosures"]] == [False, True]
    assert [n["is_new"] for n in marked[0]["news"]] == [False, True]


def test_same_article_from_another_outlet_is_not_new():
    """뉴스는 링크가 아니라 제목으로 맞춘다 — 어제 본 기사가 다른 URL로 오면 새것으로 뜬다."""
    yesterday = [{"stock_code": "005930", "corp_name": "삼성전자", "disclosures": [],
                  "news": [{"title": "삼성전자, HBM4 양산 준비 마무리", "link": "a"}]}]
    today = [{"stock_code": "005930", "corp_name": "삼성전자", "disclosures": [],
              "news": [{"title": "삼성전자 HBM4 양산 준비 마무리", "link": "b"}]}]
    marked = brief.mark_new(today, brief.seen_keys(yesterday))
    assert marked[0]["news"][0]["is_new"] is False


def test_no_yesterday_means_no_marking_at_all():
    """첫 브리프에서 전부 `새것`으로 찍으면 "견줘 봤더니 전부 새것"이라는 뜻이 된다 —
    실제로는 견줄 것이 없었을 뿐이다. 필드 자체를 붙이지 않는다."""
    today = [{"stock_code": "005930", "corp_name": "삼성전자", "quote": QUOTE,
              "disclosures": [{"rcept_no": "X"}], "news": [NEWS]}]
    marked = brief.mark_new(today, None)
    assert "is_new" not in marked[0]["disclosures"][0]
    assert "is_new" not in marked[0]["news"][0]


def test_lead_prefers_a_disclosure_yesterday_did_not_have():
    """어제 이미 맨 위였던 공시를 오늘 또 올리면 브리핑이 아니다 — 접수일이 더 옛것이어도
    **어제 없던 것**이 먼저다."""
    old = {**MAJOR, "rcept_no": "OLD", "rcept_dt": "20260806", "is_new": False}
    fresh = {**MAJOR, "rcept_no": "FRESH", "rcept_dt": "20260805", "is_new": True}
    items = [{"stock_code": "000660", "corp_name": "SK하이닉스", "quote": QUOTE,
              "disclosures": [old, fresh], "news": []}]
    assert brief.pick_lead(items)["as_of"] == "20260805"


def test_lead_still_shows_an_old_major_when_nothing_is_new():
    """새것이 없다고 리드를 비우면 "오늘은 조용하다"로 잘못 읽힌다 — 어제부터 이어지는
    사안도 상담 준비에서는 맨 위가 맞다."""
    old = {**MAJOR, "is_new": False}
    items = [{"stock_code": "000660", "corp_name": "SK하이닉스", "quote": QUOTE,
              "disclosures": [old], "news": []}]
    assert brief.pick_lead(items)["reason"] == "disclosure"


# ── 요약 불릿(digest) — 카드 맨 위, 지수 줄 위 ───────────────────────────────

def _stock(code, name, pct, **kw):
    return {"stock_code": code, "corp_name": name,
            "quote": {**QUOTE, "stock_code": code, "corp_name": name, "change_pct": pct},
            "disclosures": [], "news": [], **kw}


def test_digest_has_no_lead_or_quiet_bullet():
    """`먼저 볼 것`·`조용합니다` 불릿은 걷어냈다(2026-08-06) — 종목 줄과 같은 말을 하고 있었다.

    주요 공시가 있든 없든 맨 위 한 줄로 다시 올리지 않는다. 되살리려면 `pick_lead` 위 주석의
    "종목 줄과 같은 말을 하지 않는 이유"부터 있어야 한다.
    """
    loud = [_stock("000660", "SK하이닉스", "0.64", holders=21, disclosures=[MAJOR])]
    quiet = [_stock("005930", "삼성전자", "-4.31", disclosures=[INSIDER], news=[NEWS])]
    for items in (loud, quiet):
        kinds = [b["kind"] for b in brief.stock_digest(items)]
        assert "lead" not in kinds and "quiet" not in kinds, kinds
        assert not [b for b in brief.stock_digest(items) if "먼저 볼 것" in b["text"]]


def test_digest_delta_counts_only_what_is_new():
    items = [_stock("005930", "삼성전자", "-4.31",
                    disclosures=[{**MAJOR, "is_new": True}, {**MAJOR, "is_new": False}],
                    news=[{**NEWS, "is_new": True}])]
    delta = [b for b in brief.stock_digest(items, compared=True) if b["kind"] == "delta"]
    assert delta[0]["text"] == "어제 브리프 이후 새로 생긴 것은 공시 1건 · 뉴스 1건입니다."


def test_digest_delta_says_nothing_new_but_only_if_compared():
    """0건에도 내는 건 여기 하나뿐이다 — "달라진 게 없다"가 그 자체로 답이라서.
    다만 **견주지 않았으면 아예 안 낸다**(없는 비교를 한 것처럼 말하지 않는다)."""
    items = [_stock("005930", "삼성전자", "-4.31", disclosures=[{**MAJOR, "is_new": False}])]
    kinds = lambda **kw: [b["kind"] for b in brief.stock_digest(items, **kw)]  # noqa: E731
    assert "delta" in kinds(compared=True)
    assert "delta" not in kinds(compared=False)


def test_digest_cautions_separate_missing_from_empty():
    """"없다"와 "못 가져왔다"를 가르는 자리 — 종류마다 할 일이 달라 불릿을 따로 세운다."""
    items = [{"stock_code": "012450", "corp_name": "한화에어로스페이스",
              "quote": None, "disclosures": [], "news": []}]
    texts = [b["text"] for b in brief.stock_digest(items, market_note="KRX 미연결")]
    assert "오늘 지수를 가져오지 못했습니다 — KRX 미연결" in texts
    assert "한화에어로스페이스는 지연시세가 조회되지 않았습니다." in texts
    # 조회 0건은 **종목 줄**이 말한다 — 유의사항에 또 두면 같은 사실이 두 줄이 된다.
    assert "한화에어로스페이스: 밤사이 공시·뉴스가 없습니다." in texts
    assert not [t for t in texts if "밤사이 공시·뉴스가 조회되지 않았습니다" in t]


def test_digest_every_bullet_is_one_sentence():
    """불릿당 한 문장 — 두 문장을 허용하면 규칙이 문장을 이어 붙이고 브리핑이 리포트가 된다."""
    items = [_stock("000660", "SK하이닉스", "0.64", holders=21,
                    disclosures=[{**MAJOR, "is_new": True}], news=[{**NEWS, "is_new": True}])]
    for b in brief.stock_digest(items, compared=True, market_note="사유"):
        assert b["text"].count(". ") == 0, b["text"]


def test_digest_stock_line_quotes_titles_not_just_counts():
    """무엇이 있었는지를 **건수가 아니라 이름으로** 말한다 — `공시 2건`은 무슨 일인지 안 알려준다.

    ⚠️ 주요 공시가 아닌 공시는 이름을 인용하지 않는다(대개 임원 보고가 같은 이름으로 반복된다).
    """
    items = [
        _stock("000660", "SK하이닉스", "5.77", disclosures=[MAJOR, INSIDER],
               news=[{**NEWS, "title": "로이터 SK하이닉스, 주주환원 확대 검토"},
                     {**NEWS, "title": "둘째"}]),
        _stock("005930", "삼성전자", "2.50", disclosures=[INSIDER] * 5,
               news=[{**NEWS, "title": "갤럭시 Z8 공식 출시"}]),
    ]
    assert [b["text"] for b in brief.stock_digest(items) if b["kind"] == "stock"] == [
        "SK하이닉스: 주요 공시 「단일판매ㆍ공급계약체결」 외 1건 · 뉴스 「로이터 SK하이닉스, 주주환원 확대 검토」 외 1건.",
        "삼성전자: 공시 5건 · 뉴스 「갤럭시 Z8 공식 출시」.",
    ]


def test_digest_stock_line_clips_a_long_title():
    """긴 제목이 불릿 하나를 두 줄로 만들면 요약이 목록보다 길어진다 — 원문은 아래 카드에 있다."""
    long_title = "한화에어로스페이스, 4500억 규모 영국 UAM 부품 계약 조기 종료 결정 공시 관련 상세 내용"
    items = [_stock("012450", "한화에어로스페이스", "0.30", news=[{**NEWS, "title": long_title}])]
    text = [b for b in brief.stock_digest(items) if b["kind"] == "stock"][0]["text"]
    assert "…" in text and len(text) < len(long_title) + 30


# ── ⑤-C. LLM이 쓴 한 문장 — 통과 못 하면 규칙 문장으로 떨어진다 ────────────────

def test_summary_input_carries_only_titles():
    """입력은 **제목·공시명뿐**이다 — 시세도 보유 고객 수도 나가지 않는다."""
    items = [_stock("000660", "SK하이닉스", "5.77", holders=21, disclosures=[MAJOR], news=[NEWS])]
    text = brief.summary_input(items)
    assert "단일판매ㆍ공급계약체결" in text and NEWS["title"] in text
    assert "21" not in text and "5.77" not in text and QUOTE["close"] not in text


def test_stock_with_nothing_is_not_sent_to_the_model():
    """근거가 0건이면 LLM에 넘기지 않는다 — 쓸 게 없는데 쓰라고 하면 지어내는 수밖에 없다.
    그 종목의 규칙 문장("밤사이 공시·뉴스가 없습니다")이 이미 정확한 답이다."""
    items = [
        _stock("000660", "SK하이닉스", "5.77", disclosures=[MAJOR]),
        _stock("012450", "한화에어로스페이스", "0.30"),  # 공시·뉴스 0건
    ]
    assert [it["stock_code"] for it in brief.summarizable(items)] == ["000660"]
    # 넘기지 않은 종목의 줄을 모델이 지어내도 검사에서 걸린다(알려진 코드가 아니다).
    assert brief.parse_summaries(
        "012450|조용한 하루였습니다", brief.summarizable(items)
    ) == {}


def test_summary_is_used_when_it_passes():
    items = [_stock("000660", "SK하이닉스", "5.77", disclosures=[MAJOR], news=[NEWS])]
    ok = brief.parse_summaries("000660|주주환원 확대 검토 보도가 이어졌습니다", items)
    b = [x for x in brief.stock_digest(items, summaries=ok) if x["kind"] == "stock"][0]
    assert b["text"] == "SK하이닉스: 주주환원 확대 검토 보도가 이어졌습니다."
    assert b["ai"] is True
    # 여러 건을 뭉친 문장이라 한 링크가 대표하지 못한다 — 밑줄을 걸지 않는다.
    assert b["href"] is None and b["link_text"] is None


def test_summary_with_a_number_not_in_the_input_is_dropped():
    """**입력에 없는 수치를 만들면 버린다.** 근거가 화면에 없는 숫자가 맨 위에 뜨면 안 된다."""
    items = [_stock("000660", "SK하이닉스", "5.77", disclosures=[MAJOR], news=[NEWS])]
    assert brief.parse_summaries("000660|목표가 30만원 도달 전망입니다", items) == {}
    # 폴백은 규칙 문장이다 — 조용히 비지 않는다(LLM 실패는 "오늘 조용했다"와 다르다).
    b = [x for x in brief.stock_digest(items, summaries={}) if x["kind"] == "stock"][0]
    assert b["text"].startswith("SK하이닉스: 주요 공시") and b["ai"] is False


def test_summary_rejects_forbidden_phrases_and_bad_shape():
    items = [_stock("000660", "SK하이닉스", "5.77", disclosures=[MAJOR], news=[NEWS])]
    p = lambda raw: brief.parse_summaries(raw, items)  # noqa: E731
    assert p("000660|수익을 보장한다는 분위기입니다") == {}  # 남은 금지 표현(단정)
    assert p("000999|남의 종목입니다") == {}  # 모르는 종목코드
    assert p("주주환원 보도가 이어졌습니다") == {}  # 형식 불일치(구분자 없음)
    assert p("000660|" + "가" * 100) == {}  # 길이 초과
    assert p("여기 요약입니다:\n000660|보도가 이어졌습니다\n") == {"000660": "보도가 이어졌습니다"}


def test_digest_gives_every_stock_its_own_line():
    """종목은 브리프에 실린 만큼 **전부** 한 줄씩 갖는다 — 조용하다고 빼면 목록에서 빠진 건지
    조용한 건지 모른다. 있는 것만 적고(0건인 종류는 아예 안 쓴다) 순서는 맨 아래다."""
    items = [
        _stock("000660", "SK하이닉스", "5.77", disclosures=[MAJOR, INSIDER],
               news=[NEWS, {**NEWS, "title": "둘째"}]),
        _stock("005930", "삼성전자", "2.50", disclosures=[INSIDER]),
        _stock("012450", "한화에어로스페이스", "0.30"),
    ]
    stock = [b for b in brief.stock_digest(items) if b["kind"] == "stock"]
    assert [b["text"] for b in stock] == [
        "SK하이닉스: 주요 공시 「단일판매ㆍ공급계약체결」 외 1건 · 뉴스 「메모리 업황 회복」 외 1건.",
        "삼성전자: 공시 1건.",
        "한화에어로스페이스: 밤사이 공시·뉴스가 없습니다.",
    ]
    # 밑줄은 주요 공시 이름에만 — 종목명·건수는 공시 원문이 아니다.
    assert stock[0]["link_text"] == "「단일판매ㆍ공급계약체결」"
    assert stock[1]["link_text"] is None and stock[1]["href"] is None
    # 맨 아래다 — 위 넷이 "오늘 전체"를 말하고 그 뒤에 종목이 하나씩 온다.
    kinds = [b["kind"] for b in brief.stock_digest(items)]
    assert kinds[-3:] == ["stock", "stock", "stock"]


def test_digest_stock_line_counts_what_the_card_shows():
    """공시 건수는 **카드에 실린 전부**(접힌 임원 보고 포함) — 카드가 5건인데 불릿이 0건이면
    어느 쪽이 맞는지 화면에서 알 수 없다."""
    items = [_stock("005930", "삼성전자", "2.50", disclosures=[INSIDER] * 5)]
    stock = [b for b in brief.stock_digest(items) if b["kind"] == "stock"][0]
    assert stock["text"] == "삼성전자: 공시 5건."


def test_lead_stays_out_of_the_gated_body():
    """리드는 본문에 안 들어간다 — 들어가면 같은 사실이 두 번 세어져 부착률 분모가 흔들린다."""
    items = [{"stock_code": "000660", "corp_name": "SK하이닉스", "quote": QUOTE,
              "disclosures": [MAJOR], "news": []}]
    md, sentences = brief.assemble(items)
    assert "먼저 볼 것" not in md
    assert sum(1 for s in sentences if MAJOR["report_nm"] in s["text"]) == 1
    assert brief.check(md, sentences) == []


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


# ── 거시 브리핑 (2026-08-07) ──────────────────────────────────────────────────
#
# 위쪽 테스트 대부분은 **배선 해제된 종목 경로**를 지킨다(`brief.py`의 같은 이름 구역).
# 지우지 않은 이유는 그 규칙들이 라이브에서 고쳐 얻은 것이고, 되살릴 때 여기서 시작하기
# 위해서다. 지금 화면에 나가는 것은 아래 테스트들이 지키는 경로다.


def _ix(name, pct, as_of="20260807", recent=None):
    return {"index_name": name, "close": "6690.62", "change_pct": pct,
            "as_of": as_of, "source": "공공데이터포털 지수시세정보", "recent": recent}


def test_direction_of_does_not_fill_unreadable_with_zero():
    """못 읽은 등락률을 0으로 채우면 `보합`이라는 뜻이 되어, 조회가 실패한 날
    "어제 상승에서 오늘 보합으로 바뀌었다"는 없는 사실이 만들어진다."""
    assert brief.direction_of("0.42") == "up"
    assert brief.direction_of("-0.42") == "down"
    assert brief.direction_of("0") == "flat"
    assert brief.direction_of(None) is None and brief.direction_of("") is None


# ⚠️ **어제 대비 줄(`_delta_bullets`)은 2026-08-10에 걷어냈다** — 첫 줄이 3개월 추세로
#    바뀌었다. `compare_macro`는 감사로그가 그대로 쓰므로 **판정은 계속 검증한다.**
def test_turn_is_reported_when_the_sign_flips():
    """어제 하락하던 것이 오늘 상승으로 돌았다는 **판정**은 감사로그에 남는다."""
    cmp = brief.compare_macro([_ix("코스피", "0.42")], [_ix("코스피", "-0.31", as_of="20260806")])
    assert cmp["turns"] == [{"index_name": "코스피", "from": "down", "to": "up"}]


def test_no_turn_is_distinguishable_from_no_comparison():
    """"안 바뀌었다"와 "견주지 않았다"는 다른 상태다 — 감사로그가 둘을 가를 수 있어야 한다."""
    same = brief.compare_macro([_ix("코스피", "0.42")], [_ix("코스피", "0.31", as_of="20260806")])
    assert same["compared"] == ["코스피"] and same["turns"] == []
    first = brief.compare_macro([_ix("코스피", "0.42")], None)
    assert first["has_prev"] is False and first["compared"] == []


def test_same_basis_date_is_not_a_comparison():
    """주말·휴장에는 어제 브리프도 오늘 브리프도 **같은 종가**를 싣는다. 그걸 견줘서
    "방향이 안 바뀌었다"고 적으면 견주지 않은 것을 견줬다고 말하는 것이다."""
    cmp = brief.compare_macro([_ix("코스피", "0.42")], [_ix("코스피", "0.42")])
    assert cmp["compared"] == [] and cmp["stale"] == ["코스피"]
    # ⚠️ 이 상태에 대한 **유의사항 줄도 함께 걷어냈다** — 화면에 없는 것("어제 대비")을
    #    못 했다고 말하는 문장이 되기 때문이다.
    assert brief._macro_cautions(None, cmp) == []


def test_indices_are_matched_by_name_not_by_order():
    """한 지수만 조회에 실패한 날 순서로 맞추면 코스피를 코스닥과 견주게 된다."""
    cmp = brief.compare_macro(
        [_ix("코스닥", "-0.30")],
        [_ix("코스피", "1.00", as_of="20260806"), _ix("코스닥", "-0.10", as_of="20260806")],
    )
    assert cmp["compared"] == ["코스닥"] and cmp["turns"] == []


def test_notable_bullet_uses_the_shared_phrasing():
    """판정·문구를 만드는 곳은 `recent_move_text` 하나다 — 지수와 종목이 같은 말을 써야 한다."""
    idx = _ix("코스피", "-2.10", recent={"of": 20, "direction": "down", "rank": 2})
    assert [b["text"] for b in brief._notable_bullets([idx])] == [
        "코스피는 최근 한 달 남짓 사이 두 번째로 큰 하락입니다."
    ]


def test_ordinary_move_says_nothing():
    """평범하면 아무 말도 하지 않는다 — 지표마다 매일 한 줄씩 붙으면 정작 다를 때의 문구가
    그 사이에 묻힌다."""
    assert brief._notable_bullets([_ix("코스피", "0.10", recent=None)]) == []
    assert brief._notable_bullets([_ix("코스피", "0.10",
                                       recent={"of": 20, "direction": "up", "rank": None})]) == []


def test_particle_follows_the_final_consonant():
    """규칙이 쓰는 문장이라 조사가 틀리면 더 눈에 띈다(`코스피가` · `코스닥이`).
    2단계에서 들어올 이름들도 여기서 함께 지킨다."""
    assert brief._particle("코스피", "이", "가") == "가"
    assert brief._particle("코스닥", "이", "가") == "이"
    assert brief._particle("원/달러", "이", "가") == "가"
    assert brief._particle("국고채3년", "은", "는") == "은"


def test_macro_digest_order_and_one_sentence_each():
    """읽는 순서 = 3개월 추세 → 평소 대비 → 고객 관련 종목 → 유의사항. 불릿당 한 문장."""
    today = [_ix("코스피", "-2.10", recent={"of": 20, "direction": "down", "rank": 1}),
             _ix("코스닥", "0.30")]
    prev = [_ix("코스피", "0.50", as_of="20260806"), _ix("코스닥", "0.10", as_of="20260806")]
    trend = {"kind": "trend", "text": "코스피가 석 달 동안 내렸습니다.", "href": None}
    bullets = brief.macro_digest(
        today, compare=brief.compare_macro(today, prev), market_note=None, trends=[trend]
    )
    assert [b["kind"] for b in bullets] == ["trend", "notable"]
    for b in bullets:
        assert b["text"].count(".") == 1 and b["text"].endswith(".")
        # 거시 불릿에는 열어 볼 원문이 없다 — 링크를 지어내지 않는다.
        assert b["href"] is None


def test_macro_digest_separates_missing_from_unchanged():
    """"못 가져왔다"와 "안 바뀌었다"는 다르다 — 지수 조회가 실패하면 그 사실이 뜬다."""
    bullets = brief.macro_digest([], compare=brief.compare_macro([], None),
                                 market_note="KRX 지수시세정보 미연결")
    assert [b["kind"] for b in bullets] == ["caution"]
    assert "미연결" in bullets[0]["text"]


def test_macro_body_has_no_stocks_and_still_passes_the_gate():
    """브리프 본문은 이제 지수 줄뿐이다 — 종목이 빠져도 고지·출처·지연 표기는 그대로다."""
    md, sentences = brief.assemble([], [_ix("코스피", "0.42")])
    assert "삼성전자" not in md and BRIEF_NOTICE in md
    assert [s["is_heading"] for s in sentences] == [True, False]
    assert "지연시세" in sentences[1]["text"]
    assert brief.check(md, sentences) == []


# ── 공급자가 둘 (2026-08-07 · 지수 = 공공데이터포털, 환율·금리 = 한국은행 ECOS) ────


def _fx(name="원/달러", move="-0.42", as_of="20260807"):
    return {"index_name": name, "close": "1418.8", "level_unit": "", "move": move,
            "move_unit": "%", "basis": "공표", "as_of": as_of, "recent": None,
            "source": "한국은행 ECOS 오픈API (일별 공표치, 실시간 아님)"}


def _rate(move="7.3", as_of="20260806", recent=None):
    return {"index_name": "국고채3년", "close": "3.742", "level_unit": "%", "move": move,
            "move_unit": "bp", "basis": "공표", "as_of": as_of, "recent": recent,
            "source": "한국은행 ECOS 오픈API (일별 공표치, 실시간 아님)"}


def test_ecos_line_says_published_not_delayed_quote():
    """환율·금리는 시세가 아니라 **공표 통계**다 — `지연시세`라고 쓰면 틀린 말이고,
    출처 종류도 krx가 아니다(게이트가 krx를 시세 인용으로 보므로 달면 안 된다)."""
    text, src = brief._index_line(_fx())
    assert text == "원/달러 1,418.8 ▼0.42% — 20260807 기준 공표치(실시간 아님)."
    assert src["type"] == "ecos"
    assert "지연시세" not in text


def test_rate_move_is_written_in_bp():
    """금리를 %로 적으면 3.742→3.669가 `-1.95%`가 되는데 채권에서 그렇게 말하지 않는다."""
    text, _ = brief._index_line(_rate())
    assert text == "국고채3년 3.742% ▲7.3bp — 20260806 기준 공표치(실시간 아님)."


def test_level_keeps_the_precision_the_source_gave():
    """`float(x):,.2f`로 찍던 것을 바꿨다 — 국고채 3.669가 3.67로 깎이면 bp가 사라진다."""
    assert brief.fmt_level("3.669") == "3.669"
    assert brief.fmt_level("6296.38") == "6,296.38"
    assert brief.fmt_level("1418.8") == "1,418.8"
    # 숫자가 아니면 손대지 않는다 — 지어내는 것보다 그대로가 낫다.
    assert brief.fmt_level("N/A") == "N/A"


def test_arrow_does_not_double_the_minus_sign():
    """`▼-4.58%`로 나오던 것을 고쳤다(2026-08-07) — 화살표가 이미 방향을 말한다."""
    text, _ = brief._index_line(_ix("코스피", "-4.58"))
    assert "▼4.58%" in text and "▼-" not in text


def test_old_brief_without_move_still_assembles():
    """2026-08-07 이전 브리프에는 `move`가 없고 `change_pct`만 있다 — 다시 조립해도
    등락이 빈 문장(`코스피 3,105.22 ▲% — …`)이 되면 안 된다."""
    legacy = {"index_name": "코스피", "close": "3105.22", "change_pct": "0.42",
              "as_of": "20260721", "source": "공공데이터포털 지수시세정보"}
    text, src = brief._index_line(legacy)
    assert "▲0.42%" in text and "지연시세" in text and src["type"] == "krx"
    assert brief.direction_of(brief.move_of(legacy)) == "up"


def test_mixed_providers_compare_by_name_and_keep_their_units():
    """지수·환율·금리가 한 띠에 서도 전환 판정은 지표별로 따로 돈다 — 단위가 섞여도
    부호만 보기 때문에 안전하다."""
    today = [_ix("코스피", "-4.58"), _fx(move="0.31"), _rate(move="-2.0")]
    prev = [_ix("코스피", "0.50", as_of="20260806"), _fx(move="-0.10", as_of="20260806"),
            _rate(move="-1.0", as_of="20260805")]
    cmp = brief.compare_macro(today, prev)
    assert sorted(cmp["compared"]) == sorted(["코스피", "원/달러", "국고채3년"])
    # 코스피(상승→하락)와 원/달러(하락→상승)만 방향이 바뀌었다. 국고채는 계속 하락이다.
    assert sorted(t["index_name"] for t in cmp["turns"]) == sorted(["코스피", "원/달러"])


def test_body_with_both_providers_passes_the_gate():
    """지수 줄은 지연시세 고지를, ECOS 줄은 공표 표기를 갖는다 — 섞여도 통과해야 한다."""
    md, sentences = brief.assemble([], [_ix("코스피", "-4.58"), _fx(), _rate()])
    assert brief.check(md, sentences) == []
    assert all(s["source"] for s in sentences if not s["is_heading"])
    assert {s["source"]["type"] for s in sentences if not s["is_heading"]} == {"krx", "ecos"}


def test_macro_bullets_stay_out_of_the_gated_body():
    """불릿은 `lead_json`에 산다 — 본문에 넣으면 같은 사실이 두 번 세어진다."""
    today = [_ix("코스피", "-2.10", recent={"of": 20, "direction": "down", "rank": 1})]
    md, _ = brief.assemble([], today)
    for b in brief.macro_digest(today, compare=brief.compare_macro(today, None)):
        assert b["text"] not in md


# ── 뉴스 후보 고르기 (신선도·중복 제거) ──────────────────────────────────────
#
# 2026-08-10에 밤사이 거시 헤드라인 줄을 걷어내면서 그 줄의 프롬프트·검증 테스트도 같이
# 지웠다. **아래 셋은 남는다** — `pick_headlines`는 고객 관련 종목 줄이 그대로 쓰고
# (`main._watch_bullet`), 이 규칙이 느슨해지면 종목 줄에 지난주 기사가 섞인다.

from datetime import datetime, timedelta, timezone  # noqa: E402

KST = timezone(timedelta(hours=9))
NOW = datetime(2026, 8, 7, 9, 0, tzinfo=KST)


def _art(title, hours_ago=2, link="https://n.example/1"):
    at = NOW - timedelta(hours=hours_ago)
    return {"title": title, "link": link,
            "pub_date": at.strftime("%a, %d %b %Y %H:%M:%S %z")}


def test_stale_articles_are_dropped():
    """이 자리가 답하는 건 "밤사이"다 — 지난주 기사가 섞이면 그 자체로 거짓이 된다.
    (실측: `국제금융시장` 검색이 일주일 전 기사를 상위에 올렸다.)"""
    rows = [_art("어제 뉴욕증시 하락", 3), _art("지난주 미 금리 동결", 24 * 7)]
    picked = brief.pick_headlines(rows, NOW)
    assert [r["title"] for r in picked] == ["어제 뉴욕증시 하락"]


def test_unreadable_pub_date_is_dropped_not_treated_as_now():
    """못 읽은 시각을 '지금'으로 치면 신선도 필터가 조용히 열린다."""
    rows = [{"title": "시각 불명", "link": "x", "pub_date": "언제인지 모름"}]
    assert brief.pick_headlines(rows, NOW) == []
    assert brief.parse_pub_date("언제인지 모름") is None


def test_same_event_from_many_outlets_counts_once():
    """같은 사건이 매체만 달리해 다섯 건 오면 그것만으로 입력이 다 찬다."""
    rows = [_art("뉴욕증시, 호르무즈 변수에 하락", 1, "a"),
            _art("뉴욕증시 호르무즈 변수에 하락", 2, "b"),
            _art("국제유가 급등", 3, "c")]
    assert len(brief.pick_headlines(rows, NOW)) == 2


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
