"""F2 첫 줄 — 3개월 추세 (2026-08-10).

이 줄이 답하는 질문은 "석 달 동안 무엇이 가장 크게 움직였고 왜인가"다. 검사가 셋이다:
① 단위가 다른 다섯을 같은 축에서 견주는가 ② 몇 줄을 세울지 규칙이 정하는가
③ 문장이 입력에 없는 것을 말하지 않는가.

⚠️ 여기 테스트는 **LLM도 네트워크도 부르지 않는다.** 부르는 자리(`main._trend_bullet`)는
   얇게 두고 판단은 전부 순수 함수로 내려 두었기 때문이다.
"""

from backend import brief, market

# --- ① 단위가 다른 지표를 견주기 ---------------------------------------------


def _series(start, step, n=40):
    """일정하게 움직이는 관측 n개. 날짜는 순서만 맞으면 되므로 단순 증가로 만든다."""
    return [(f"2026{5 + i // 28:02d}{i % 28 + 1:02d}", start + step * i) for i in range(n)]


def test_trend_needs_a_long_enough_window():
    """석 달을 물었는데 2주치로 답하지 않는다 — 근거가 모자라면 아무 말도 하지 않는다."""
    assert market.trend_of(_series(100.0, 0.5, n=market.TREND_MIN_WINDOW - 1), "%") is None
    assert market.trend_of(_series(100.0, 0.5, n=market.TREND_MIN_WINDOW), "%") is not None


def test_flat_series_has_no_z_instead_of_infinity():
    """관측이 전부 같으면 나눌 것이 없다. 무한대를 내면 그 지표가 늘 1등이 된다."""
    t = market.trend_of(_series(100.0, 0.0), "%")
    assert t is not None and t["change"] == 0 and t["z"] is None


def test_change_follows_the_unit_convention():
    """`%`는 비율, `bp`는 절대차 ×100 — 일별 움직임(`daily_moves`)과 같은 관례다."""
    pct = market.trend_of([("20260501", 100.0), *_series(100.0, 1.0)[1:]], "%")
    assert round(pct["change"], 1) == round((pct["to_level"] - 100.0) / 100.0 * 100, 1)
    bp = market.trend_of(_series(3.0, 0.01), "bp")
    assert round(bp["change"], 1) == round((bp["to_level"] - 3.0) * 100, 1)


def test_z_makes_percent_and_bp_comparable():
    """**이 테스트가 이 기능의 요점이다.** `+12%`와 `+40bp` 중 무엇이 큰가는 성립하지 않는
    물음이라, 각 지표를 **자기 일간 변동으로 나눠** 견준다.

    아래 둘은 변화폭 숫자가 크게 다르지만(퍼센트 39 vs bp 39) 움직임의 결이 같으므로
    z도 같은 자리에 온다 — 단위가 상쇄된다는 뜻이다."""
    pct = market.trend_of(_series(100.0, 1.0), "%")
    bp = market.trend_of(_series(3.0, 0.01), "bp")
    assert pct["z"] is not None and bp["z"] is not None
    # 둘 다 "매일 같은 폭으로 한 방향" — 평소 변동이 0에 가까우므로 z가 크다.
    assert pct["z"] > 10 and bp["z"] > 10


def test_a_noisy_series_scores_lower_than_a_steady_one_of_the_same_size():
    """같은 크기로 움직였어도 **평소에 많이 흔들리던 지표**는 덜 특별하다."""
    steady = market.trend_of(_series(100.0, 1.0), "%")
    noisy = market.trend_of(
        [(d, v + (8.0 if i % 2 else -8.0)) for i, (d, v) in enumerate(_series(100.0, 1.0))],
        "%",
    )
    assert abs(noisy["z"]) < abs(steady["z"])


# --- ② 몇 줄을 세울까 --------------------------------------------------------


def _ix(name, z, unit="%"):
    return {
        "index_name": name,
        "level_unit": "",
        "trend": {"from": "20260512", "from_level": 100.0, "to": "20260810",
                  "to_level": 110.0, "change": 10.0, "unit": unit, "days": 61,
                  "sigma": 1.0, "z": z},
    }


# ⚠️ 아래 셋은 **문턱 상수에서 값을 끌어다 쓴다**(`TREND_BIG_Z`·`TREND_TIE_RATIO`).
#    숫자를 박아 두면 문턱을 조정할 때 테스트가 조용히 뜻을 잃는다 — 실제로 2.0 → 0.7로
#    낮췄을 때 "문턱 아래" 사례가 문턱이 아니라 비율 때문에 걸러지면서 통과했다.
BIG = brief.TREND_BIG_Z
RATIO = brief.TREND_TIE_RATIO


def test_always_one_even_when_nothing_is_dramatic():
    """"크지 않으면 그냥 하나"— 문턱을 못 넘어도 가장 큰 것 하나는 낸다."""
    got = brief.pick_trends([_ix("나스닥", BIG * 0.5), _ix("원/달러", BIG * 0.3)])
    assert [t["index_name"] for t in got] == ["나스닥"]


def test_two_when_both_clear_the_bar_and_stand_close():
    both = brief.pick_trends([_ix("나스닥", BIG * 2), _ix("원/달러", BIG * 2 * 0.9)])
    assert [t["index_name"] for t in both] == ["나스닥", "원/달러"]


def test_second_line_needs_the_absolute_bar():
    """1등과 아무리 가까워도 **자기가 작으면** 서지 않는다 — 바닥권 둘을 나란히 놓으면
    둘 다 큰 변화처럼 읽힌다. (비율은 통과하도록 값을 잡아 문턱만 시험한다.)"""
    got = brief.pick_trends([_ix("나스닥", BIG), _ix("원/달러", BIG * 0.95)])
    assert [t["index_name"] for t in got] == ["나스닥"]


def test_second_line_needs_to_be_close_to_the_first():
    """문턱을 넘었어도 **1등과 격차가 크면** 서지 않는다 — 1등만 큰 날이다."""
    small = BIG * 1.2
    got = brief.pick_trends([_ix("나스닥", small / RATIO * 2), _ix("원/달러", small)])
    assert [t["index_name"] for t in got] == ["나스닥"]


def test_direction_does_not_matter_only_size():
    """급락도 급등도 같은 축이다 — 방향은 PB가 읽고, 규칙은 크기만 본다."""
    got = brief.pick_trends([_ix("나스닥", -6.0), _ix("원/달러", 3.0)])
    assert got[0]["index_name"] == "나스닥"


def test_indicators_without_a_trend_are_skipped_not_zeroed():
    no_trend = {"index_name": "국고채10년", "trend": None}
    got = brief.pick_trends([no_trend, _ix("나스닥", 1.0)])
    assert [t["index_name"] for t in got] == ["나스닥"]
    assert brief.pick_trends([no_trend]) == []


def test_ties_are_deterministic():
    """같은 입력에 같은 브리프여야 한다 — 동률은 지표 이름이 가른다."""
    ixs = [_ix("원/달러", 5.0), _ix("나스닥", 5.0)]
    twice = [[t["index_name"] for t in brief.pick_trends(ixs)] for _ in range(2)]
    assert twice[0] == twice[1] == ["나스닥", "원/달러"]


# --- ③ 문장 검증 -------------------------------------------------------------

T = {"index_name": "원/달러", "level_unit": "", "from": "20260512", "from_level": 1380.0,
     "to": "20260810", "to_level": 1548.4, "change": 12.2, "unit": "%", "days": 61}
ROWS = [{"title": "원달러 환율, 관세 우려에 1,540원대 돌파", "link": "u", "pub_date": "p"}]


def test_a_sentence_grounded_in_the_input_passes():
    assert brief.trend_reject(
        "원/달러가 석 달간 12.2% 올랐고, 관세 우려가 배경으로 전해졌습니다.", T, ROWS
    ) is None


def test_a_sentence_without_the_change_figure_is_rejected():
    """배지를 걷어낸 자리를 문장이 대신한다 — 변화폭이 빠지면 "올랐다"까지만 남는다."""
    r = brief.trend_reject("원/달러가 석 달간 올랐다고 전해졌습니다.", T, ROWS)
    assert r and "변화폭" in r


def test_an_integer_form_of_the_change_is_accepted():
    """`24.0bp`를 문장이 `24bp`로 적는 건 정상이다 — 두 표기를 다 받는다.

    ⚠️ 지표 이름을 `미국채30년`으로 두고 `T`(원/달러)를 그대로 쓰면 **이름 속 `30`이 입력에
       없는 수치로 잡힌다.** 검증이 제대로 도는 것이고, 픽스처를 맞추는 게 맞다."""
    t = {**T, "index_name": "미국채30년", "change": 24.0, "unit": "bp",
         "from_level": 4.98, "to_level": 5.22}
    assert brief.trend_reject("미국채30년이 석 달간 24bp 올라 5.22%까지 왔습니다.", t, ROWS) is None


def test_a_float_artifact_does_not_kill_a_good_line():
    """**실측 회귀**(2026-08-10). `(5.22-4.98)*100`은 부동소수점에서 `23.999999999999996`이
    되는데 화면에는 `24.0`으로 찍히고 모델도 `24bp`라고 쓴다. 자르면(`int`) `23`을 찾게 되어
    멀쩡한 미국채30년 줄이 통째로 사라졌다 — 표시와 같은 값(반올림)으로 찾아야 한다."""
    t = {**T, "index_name": "미국채30년", "change": (5.22 - 4.98) * 100, "unit": "bp",
         "from_level": 4.98, "to_level": 5.22}
    assert t["change"] != 24.0 and f"{t['change']:.1f}" == "24.0"  # 오차가 실재한다
    assert brief.trend_reject("미국채30년이 석 달간 24bp 올라 5.22%까지 왔습니다.", t, ROWS) is None


def test_numbers_absent_from_the_input_are_rejected():
    """모델이 그럴듯한 수치를 만들면 그 줄은 안 나간다 — 근거가 화면에 없기 때문이다."""
    r = brief.trend_reject("원/달러가 석 달간 37.5% 올랐습니다.", T, ROWS)
    assert r and "수치" in r


def test_no_meta_badge_because_the_sentence_already_says_it():
    """배지에 있던 값(`4.98% → 5.22% · ▲24.0bp`)이 **문장에 이미 들어 있어** 같은 말이
    두 줄이 됐다. 대신 변화폭을 문장이 반드시 담게 했다(아래 테스트)."""
    b = brief.trend_bullet("원/달러가 석 달간 12.2% 올랐습니다.", T, ROWS)
    assert b["ai"] is True and b["kind"] == "trend"
    assert "meta" not in b
    assert [s["url"] for s in b["sources"]] == ["u"]


def test_z_never_reaches_the_screen_or_the_prompt():
    """z는 **고르는 기준이지 읽을 값이 아니다.** 화면에 z가 뜨면 설명할 수 없는 숫자가 는다."""
    b = brief.trend_bullet("원/달러가 석 달간 12.2% 올랐습니다.", {**T, "z": 8.31}, ROWS)
    assert "8.31" not in b["text"] and "0.42" not in str(b)
    assert "8.31" not in brief.trend_input({**T, "z": 8.31}, ROWS)


def test_shape_rules_match_the_stock_line():
    assert brief.trend_reject("", T, ROWS) == "빈 응답"
    assert "한 문장" in brief.trend_reject("12.2% 올랐습니다. 그리고 또 올랐습니다.", T, ROWS)
    assert "길이" in brief.trend_reject("가" * (brief.TREND_MAX_LEN + 1), T, ROWS)
    assert "금지" in brief.trend_reject("원/달러는 12.2% 올랐고 무조건 오릅니다.", T, ROWS)


def test_the_query_is_not_the_indicator_name():
    """`국고채10년`으로 검색하면 시장 기사가 아니라 발행 공고가 상위를 채운다."""
    assert brief.TREND_QUERIES["국고채10년"] == "국고채 금리"
    assert set(brief.TREND_QUERIES) == {
        "나스닥", "S&P500", "원/달러", "국고채10년", "미국채30년"
    }


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")


# ── 지표별 기사 필터 (2026-08-11) ─────────────────────────────────────────────
#
# 실측한 사고: `미국 국채 금리`로 찾은 결과에 **한국 국고채 기사**가 섞였고, 모델이 그
# 제목의 사유(`중동리스크·환율상승`)를 미국 30년물 문장에 붙였다. 두 나라 채권시장이
# 한 문장에서 섞인 것이라, 각주가 형식만 지켜지고 뜻은 깨졌다.
_US = [
    {"title": "‘국채 금리와 전쟁 선언’...베선트의 3가지 카드는"},
    {"title": "장기국채 금리 19년 만에 최고…중간선거 앞 美 ‘금리와의 전쟁’"},
    {"title": "중동리스크·환율상승…7월 국고채 금리 전반적으로 상승"},  # 한국 기사
]


def test_a_korean_bond_article_never_backs_the_us_line():
    kept = [r["title"] for r in brief.trend_news_filter("미국채30년", _US)]
    assert len(kept) == 2
    assert not any("국고채" in t for t in kept)


def test_the_filter_is_symmetric():
    """반대 방향도 막는다 — 미국 기사가 국고채 줄의 근거로 서면 같은 사고다."""
    kept = [r["title"] for r in brief.trend_news_filter("국고채10년", _US)]
    assert kept == ["중동리스크·환율상승…7월 국고채 금리 전반적으로 상승"]


def test_every_trend_index_has_a_filter():
    """표에 없는 지표는 **아무것도 안 걸러진다** — 지표를 늘리면서 여기를 빠뜨리면
    그 줄만 조용히 옛 상태로 돌아간다(주석이 아니라 테스트가 막는다)."""
    missing = sorted(set(brief.TREND_QUERIES) - set(brief.TREND_NEWS_FILTERS))
    assert not missing, f"기사 필터가 없는 지표: {missing}"


def test_an_unknown_index_passes_through_unchanged():
    """모르는 지표를 통째로 버리지 않는다 — 거르는 규칙이 없는 것과 기사가 없는 것은 다르다."""
    rows = [{"title": "무엇이든"}]
    assert brief.trend_news_filter("새 지표", rows) == rows


def test_filtering_may_leave_nothing_and_that_is_allowed():
    """다 걸러지면 줄은 **움직임만** 말하고 각주 없이 선다 — 관련 기사를 몇 건 놓치는 것이
    다른 시장 기사를 근거로 삼는 것보다 낫다(놓치는 쪽으로 기운 설계)."""
    assert brief.trend_news_filter("나스닥", [{"title": "코스닥 급등"}]) == []
