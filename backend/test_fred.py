"""FRED CSV → 일별 움직임 계산 자체 점검 (네트워크·키 불필요).

⚠️ **시리즈 ID가 맞는지는 여기서 검증되지 않는다** — 그건 실호출로만 확인된다. 확인한 값과
   확인한 날짜는 `backend/fred.py` 머리말 표에 적혀 있다(2026-08-09). 틀린 ID는 오류가 아니라
   빈 시리즈로 와서 **조용히 "휴장"처럼** 보인다.

실행: backend/.venv/bin/python -m backend.test_fred
"""

from backend import fred, market


def _csv(series_id: str, *lines: str) -> str:
    return "\n".join([f"observation_date,{series_id}", *lines])


def test_iso_dates_become_yyyymmdd():
    """띠의 다른 지표(KRX·ECOS)와 저장된 브리프가 전부 `YYYYMMDD`다. 여기서 안 맞추면
    `compare_macro`가 기준일을 견주지 못하고 화면이 같은 날을 둘로 센다."""
    obs = fred._observations(_csv("SP500", "2026-08-06,7709.96", "2026-08-07,7757.64"))
    assert obs == [("20260806", "7709.96"), ("20260807", "7757.64")]


def test_level_keeps_the_source_precision():
    """`f"{x:g}"`가 나스닥 `26690.620`을 유효숫자 6자리로 깎아 **`26690.6`을 내보냈다**
    (2026-08-09 실측). 수준은 숫자로 만들었다 되돌리지 않고 원본 문자열을 그대로 쓴다."""
    obs = fred._observations(_csv("NASDAQCOM", "2026-08-07,26690.620"))
    assert obs[-1][1] == "26690.620"
    assert f"{float('26690.620'):g}" == "26690.6"  # 왜 문자열을 지키는지의 근거


def test_holiday_rows_are_dropped_not_zeroed():
    """미 휴장일은 **행은 있고 값이 빈칸**으로 온다(실측 2026-07-03). 0으로 채우면
    "그날 지수가 0이었다"가 된다 — 빼고, 창 크기도 같이 줄어든다."""
    obs = fred._observations(
        _csv("NASDAQCOM", "2026-07-02,25832.670", "2026-07-03,", "2026-07-06,26121.160")
    )
    assert [t for t, _ in obs] == ["20260702", "20260706"]


def test_rows_are_sorted_by_date_not_by_arrival():
    """응답 순서를 믿고 마지막 행을 오늘로 쓰면, 순서가 뒤집힌 날 몇 주 전 값이 오늘 값이 된다."""
    obs = fred._observations(
        _csv("DGS30", "2026-08-06,5.22", "2026-08-04,5.18", "2026-08-05,5.17")
    )
    assert [t for t, _ in obs] == ["20260804", "20260805", "20260806"]


def test_index_moves_are_percent():
    """나스닥·S&P500은 전일 대비 비율이다(`ecos`의 환율과 같은 관례)."""
    obs = fred._observations(_csv("SP500", "2026-08-06,7709.96", "2026-08-07,7757.64"))
    assert [round(m, 2) for m in market.daily_moves(fred._values(obs), "%")] == [0.62]


def test_treasury_moves_are_bp():
    """미국채는 bp(=0.01%p)다. 5.22 → 5.19는 -0.57%가 아니라 **-3.0bp**다."""
    obs = fred._observations(_csv("DGS30", "2026-08-06,5.22", "2026-08-07,5.19"))
    assert [round(m, 1) for m in market.daily_moves(fred._values(obs), "bp")] == [-3.0]


def test_series_specs_match_band_contract():
    """띠는 지표마다 다른 키를 보지 않는다 — 세 지표가 같은 모양이어야 한다.
    ⚠️ 지수에 `공표`를 달면 게이트의 지연시세 고지가 그 문장에서 빠진다."""
    for spec in fred.SERIES:
        assert spec["basis"] in ("지연시세", "공표")
        assert spec["move_unit"] in ("%", "bp")
        assert spec["source"]
    by_name = {s["name"]: s for s in fred.SERIES}
    assert by_name["나스닥"]["basis"] == "지연시세"
    assert by_name["S&P500"]["basis"] == "지연시세"
    assert by_name["미국채30년"]["basis"] == "공표"


def test_non_csv_body_is_a_reason_not_a_silent_empty():
    """시리즈를 여러 개 묶으면 **ZIP이 200으로 온다**(실측). 그대로 파싱하면 관측 0건이 되어
    휴장처럼 보이므로, 사유로 세워 화면이 "미연결"이라고 말하게 한다."""

    class _Resp:
        status_code = 200
        text = "PK\x03\x04binary-zip-not-csv"

    saved = fred.requests.get
    fred.requests.get = lambda *a, **k: _Resp()
    try:
        rows, note = fred.fetch_series_snapshot()
        assert rows == [] and note and "CSV" in note
        # 사유가 같으면 지표마다 되풀이하지 않는다 — 한 문장이어야 한다.
        assert ";" not in note
    finally:
        fred.requests.get = saved


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
