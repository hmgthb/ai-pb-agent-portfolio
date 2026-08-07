"""ECOS 응답 → 일별 움직임 계산 자체 점검 (네트워크·키 불필요).

⚠️ **통계표·항목 코드가 맞는지는 여기서 검증되지 않는다** — 그건 실호출로만 확인된다.
   확인한 값과 확인한 날짜는 `backend/ecos.py` 머리말 표에 적혀 있다(2026-08-07,
   공개 `sample` 키). 코드를 바꾸면 그 표부터 다시 확인할 것: 틀린 코드는 오류가 아니라
   `INFO-200`(데이터 없음)으로 와서 **조용히 빈 값**이 된다.

실행: backend/.venv/bin/python -m backend.test_ecos
"""

from backend import ecos


def _rows(*pairs):
    """ECOS 응답 행 모양 — 값은 문자열로 온다(실호출 확인)."""
    return [{"TIME": t, "DATA_VALUE": str(v), "UNIT_NAME": "원"} for t, v in pairs]


def test_rows_are_sorted_by_date_not_by_arrival():
    """응답 순서를 믿고 마지막 행을 오늘로 쓰면, 순서가 뒤집힌 날 **몇 주 전 값이 오늘 값이
    된다.** 정렬은 여기서 한 번만 한다."""
    v = ecos._values(_rows(("20260806", 3.7), ("20260804", 3.5), ("20260805", 3.6)))
    assert [t for t, _ in v] == ["20260804", "20260805", "20260806"]


def test_unreadable_rows_are_dropped_not_zeroed():
    """환율 0원은 값이 아니라 사고다 — 못 읽은 행은 빼고, 창 크기도 같이 줄어든다."""
    rows = _rows(("20260804", 1500.0)) + [
        {"TIME": "20260805", "DATA_VALUE": None},
        {"TIME": "20260806", "DATA_VALUE": ""},
    ]
    assert ecos._values(rows) == [("20260804", 1500.0)]


def test_percent_moves_for_fx():
    """환율은 전일 대비 비율이다."""
    v = ecos._values(_rows(("20260804", 1000.0), ("20260805", 1010.0), ("20260806", 1005.0)))
    moves = ecos.daily_moves(v, "%")
    assert [round(m, 4) for m in moves] == [1.0, -0.4950]


def test_bp_moves_for_rates():
    """금리는 전일 대비 bp(=0.01%p)다. 3.742 → 3.669는 -1.95%가 아니라 **-7.3bp**다."""
    v = ecos._values(_rows(("20260805", 3.742), ("20260806", 3.669)))
    assert [round(m, 1) for m in ecos.daily_moves(v, "bp")] == [-7.3]


def test_single_observation_yields_no_move():
    """관측이 하나면 '어제 대비'가 없다 — 0으로 채우면 보합이라는 뜻이 된다."""
    assert ecos.daily_moves(ecos._values(_rows(("20260806", 3.7))), "bp") == []


def test_zero_previous_value_is_skipped_not_divided():
    """0으로 나누지 않는다 — 그 구간만 건너뛰고 나머지는 살린다."""
    v = ecos._values(_rows(("20260804", 0.0), ("20260805", 1000.0), ("20260806", 1010.0)))
    assert [round(m, 2) for m in ecos.daily_moves(v, "%")] == [1.0]


def test_missing_key_is_a_reason_not_a_silent_empty():
    """키가 없으면 조용히 비우지 않고 사유를 돌려준다(`market`과 같은 규약) — 화면이
    "미연결"이라고 말할 수 있어야 한다."""
    import os

    saved = os.environ.pop("ECOS_API_KEY", None)
    try:
        rows, note = ecos.fetch_series_snapshot()
        assert rows == [] and note and "ECOS_API_KEY" in note
        # 사유가 같으면 지표마다 되풀이하지 않는다 — 한 문장이어야 한다.
        assert ";" not in note
    finally:
        if saved is not None:
            os.environ["ECOS_API_KEY"] = saved


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
