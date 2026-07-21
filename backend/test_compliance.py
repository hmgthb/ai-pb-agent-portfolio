"""컴플라이언스 게이트 규칙 자체 점검 (크레딧 불필요 — LLM 호출 없음).

실행: backend/.venv/bin/python -m backend.test_compliance
"""

from backend.compliance import BRIEF_NOTICE, WATERMARK, apply_notice, check_note

SOURCED = [{"text": "매출액은 300조원이다.", "source": {"type": "dart"}, "is_heading": False}]


def _check(body: str, sentences=None, feature="F3"):
    return check_note(
        apply_notice(body, feature), sentences if sentences is not None else SOURCED, feature
    )


def test_clean_note_passes():
    assert _check("매출액은 300조원이다.") == []


def test_notice_required():
    # 고지문구 없이 저장된 본문은 발행이 막혀야 한다
    v = check_note("매출액은 300조원이다.", SOURCED, "F3")
    assert any("고지문구 누락" in x for x in v), v
    # apply_notice는 멱등 — 이미 있으면 중복으로 붙이지 않는다
    once = apply_notice("본문", "F3")
    assert apply_notice(once, "F3") == once
    assert once.count(WATERMARK) == 1


def test_notice_is_per_feature():
    """F2 브리프에 F3 워터마크를 요구하면 안 되고, 그 반대도 안 된다."""
    brief = apply_notice("전일 공시 요약입니다.", "F2")
    assert BRIEF_NOTICE in brief and WATERMARK not in brief
    assert check_note(brief, SOURCED, "F2") == []
    # 같은 본문을 F3으로 검사하면 워터마크가 없어서 막힌다
    assert any("F3 필수 고지문구" in x for x in check_note(brief, SOURCED, "F3"))
    # 반대로 F3 노트를 F2로 검사하면 브리프 고지가 없어서 막힌다
    note = apply_notice("노트 본문입니다.", "F3")
    assert any("F2 필수 고지문구" in x for x in check_note(note, SOURCED, "F2"))


def test_unknown_feature_raises():
    """배선 실수로 모르는 기능 코드가 오면 조용히 통과시키지 않는다."""
    try:
        check_note("본문", SOURCED, "F9")
    except ValueError as e:
        assert "F9" in str(e)
    else:
        raise AssertionError("모르는 기능 코드인데 통과했다")


def test_forbidden_phrase():
    assert any("투자권유" in x for x in _check("목표주가는 10만원이다."))


def test_mnpi_pattern():
    assert any("MNPI" in x for x in _check("내부자 정보에 따르면 실적이 좋다."))


def test_unsourced_sentence_blocks():
    unsourced = [{"text": "매출이 늘었다.", "source": None, "is_heading": False}]
    v = _check("매출이 늘었다.", unsourced)
    assert any("출처 없는 문장" in x for x in v), v
    # 제목 줄은 출처가 없어도 위반이 아니다
    heading = [{"text": "실적 요약", "source": None, "is_heading": True}]
    assert _check("실적 요약", heading) == []


def test_delayed_quote_notice():
    # 시세를 실었는데 지연시세 고지가 없으면 막힌다 (F2 모닝 브리프 대비)
    v = _check("현재 주가는 7만원이다.")
    assert any("지연시세" in x for x in v), v

    # 고지가 있으면 통과한다 — "지연시세"가 "시세"를 포함하므로 자기충족적으로 풀린다
    assert _check("현재 주가는 7만원이다. 본 시세는 지연시세입니다.") == []

    # 시세를 아예 안 싣는 F3 노트는 이 규칙에 걸리지 않는다 (오탐 방지)
    assert _check("매출액은 300조원, 영업이익은 30조원이다.") == []

    # 시세 단어가 있어도 수치가 없으면 발동하지 않는다 — F2 빈 결과 안내문에서 실제로
    # 오탐이 났던 케이스. 여기가 깨지면 조회 0건인 브리프가 발행 불가가 된다.
    assert _check("전일 공시·밤사이 뉴스·시세 모두 조회된 항목이 없습니다.") == []
    assert _check("주가 흐름을 지켜볼 필요가 있다는 평가가 나온다.") == []


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
