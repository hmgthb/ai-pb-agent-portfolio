"""오늘 움직임이 평소 대비 어느 정도인가 — 판정·창 계산 자체 점검 (네트워크·키 불필요).

`krx_quote`가 **한 응답으로 이미 받아 온 수십 일치**로 계산하는 값이라(추가 조회 0회),
여기서 순수 함수로 전부 검증된다. 문구를 만드는 쪽은 brief.recent_move_text이고
그 테스트는 test_brief.py에 있다 — 판정과 문구를 나눠 둔 이유도 그것이다.

실행: backend/.venv/bin/python -m backend.test_market
"""

from backend import market


def test_biggest_drop_in_window():
    pcts = [-4.3, 0.5, -1.2, 0.8, -0.3, 1.1, -2.0, 0.2, 0.9, -0.7]
    assert market.rank_recent_move(pcts, -4.3) == {"of": 10, "direction": "down", "rank": 1}


def test_ranks_within_the_same_direction_only():
    """하락을 상승과 섞어 절대값으로 줄 세우면 '가장 큰 하락'이 실은 작은 하락일 수 있다.

    아래에서 -1.0보다 큰 움직임은 +9.0·+5.0 둘이지만 **방향이 반대**라 세지 않는다 —
    하락 중에서는 -1.0이 가장 크므로 1위가 맞다.
    """
    pcts = [-1.0, 9.0, 5.0, 0.4, -0.2, -0.5, 0.1, 0.3, 0.6, 0.7]
    assert market.rank_recent_move(pcts, -1.0)["rank"] == 1


def test_ordinary_move_has_no_rank():
    """상위 밖이면 rank가 None — 등수를 그대로 적으면 '4위'가 크다는 뜻으로 읽힌다."""
    pcts = [-0.1, -5.0, -4.0, -3.0, -2.0, 0.5, 0.6, 0.7, 0.8, 0.9]
    r = market.rank_recent_move(pcts, -0.1)
    assert r["rank"] is None and r["of"] == 10


def test_short_window_says_nothing():
    """신규상장·긴 연휴로 창이 짧으면 통째로 None — '5거래일 중 가장 큰 하락'은
    없는 무게를 실어 주는 말이다."""
    assert market.rank_recent_move([-1.0, 0.2, 0.3], -1.0) is None


def test_flat_and_unreadable_say_nothing():
    pcts = [0.1] * 10
    assert market.rank_recent_move(pcts, 0.0) is None  # 보합
    assert market.rank_recent_move(pcts, None) is None  # 등락률을 못 읽은 행


def test_unreadable_rows_shrink_the_window_too():
    """못 읽은 행을 빼면 창 크기도 같이 줄어야 한다 — 안 그러면 'N거래일 중'의 N이
    실제로 본 날수와 어긋난다."""
    rows = [{"fltRt": "1.0"}, {"fltRt": None}, {"fltRt": "-2.0"}, {"fltRt": "??"}]
    assert market.daily_pcts(rows) == [1.0, -2.0]


def test_zero_is_not_missing():
    """보합(0.0)과 '못 읽음'(None)은 다르다 — 0으로 채우면 보합이 되어 버린다."""
    assert market.as_pct("0") == 0.0
    assert market.as_pct(None) is None


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
