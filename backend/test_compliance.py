"""컴플라이언스 게이트 규칙 자체 점검 (크레딧 불필요 — LLM 호출 없음).

실행: backend/.venv/bin/python -m backend.test_compliance
"""

from backend.compliance import WATERMARK, apply_watermark, check_note

SOURCED = [{"text": "매출액은 300조원이다.", "source": {"type": "dart"}, "is_heading": False}]


def _check(body: str, sentences=None):
    return check_note(apply_watermark(body), sentences if sentences is not None else SOURCED)


def test_clean_note_passes():
    assert _check("매출액은 300조원이다.") == []


def test_watermark_required():
    # 워터마크 없이 저장된 본문은 발행이 막혀야 한다
    v = check_note("매출액은 300조원이다.", SOURCED)
    assert any("워터마크" in x for x in v), v
    # apply_watermark는 멱등 — 이미 있으면 중복으로 붙이지 않는다
    once = apply_watermark("본문")
    assert apply_watermark(once) == once
    assert once.count(WATERMARK) == 1


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


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
