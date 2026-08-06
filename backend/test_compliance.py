"""컴플라이언스 게이트 규칙 자체 점검 (크레딧 불필요 — LLM 호출 없음).

실행: backend/.venv/bin/python -m backend.test_compliance
"""

from backend.compliance import (
    BRIEF_NOTICE,
    WATERMARK,
    apply_notice,
    check_note,
    live_acks,
)

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


def _qsent(text, source=None):
    """시세 규칙용 문장. ⚠️ 이 파일 아래쪽에 확인(ack) 테스트용 `_sent`가 따로 있다 —
    이름이 겹치면 **나중 정의가 이깁니다**(실제로 겹쳐서 픽스처가 조용히 바뀌었다)."""
    return {"text": text, "source": source, "sources": [source] if source else [],
            "is_heading": False, "kind": "claim"}


def _quote_check(*texts, sentences=None, feature="F3", removed=None):
    """본문과 문장 목록이 **같은 내용**이 되도록 묶어 검사한다 — 시세 규칙은 문장 단위라
    둘이 어긋나면 규칙이 아니라 픽스처를 시험하게 된다."""
    body = " ".join(texts)
    return check_note(
        apply_notice(body, feature),
        sentences if sentences is not None else [_qsent(t, {"type": "dart"}) for t in texts],
        feature,
        None,
        removed,
    )


def test_delayed_quote_notice():
    # 시세를 실었는데 지연시세 고지가 없으면 막힌다 (F2 상담 전 브리핑 대비)
    v = _quote_check("현재 주가는 7만원이다.")
    assert any("지연시세" in x for x in v), v

    # 고지가 있으면 통과한다 — "지연시세"가 "시세"를 포함하므로 자기충족적으로 풀린다
    assert _quote_check("현재 주가는 7만원이다.", "본 시세는 지연시세입니다.") == []

    # 시세를 아예 안 싣는 F3 노트는 이 규칙에 걸리지 않는다 (오탐 방지)
    assert _quote_check("매출액은 300조원, 영업이익은 30조원이다.") == []

    # 시세 단어가 있어도 수치가 없으면 발동하지 않는다 — F2 빈 결과 안내문에서 실제로
    # 오탐이 났던 케이스. 여기가 깨지면 조회 0건인 브리프가 발행 불가가 된다.
    assert _quote_check("전일 공시·밤사이 뉴스·시세 모두 조회된 항목이 없습니다.") == []
    assert _quote_check("주가 흐름을 지켜볼 필요가 있다는 평가가 나온다.") == []


def test_quote_rule_is_per_sentence_not_per_document():
    """⚠️ 회귀 고정(2026-08-06) — 예전에는 **문서 단위 공존**으로 판정해서, 시세를 한 줄도
    인용하지 않은 노트가 **자기 실적 수치 때문에** 막혔다(실측: 노트 #33).
    시세 낱말과 수치가 **같은 문장**에 있어야 고지 대상이다."""
    v = _quote_check(
        "관련 보도는 주가가 최근 큰 폭 하락했으나 펀더멘탈에 변화가 없다고 전했다.",  # 수치 없음
        "2024 매출액은 300조8,709억원으로 전기 대비 약 16% 늘었다.",  # 시세 아님
    )
    assert v == [], v
    # 같은 문장 안에 있으면 그대로 잡는다("주가 7만원 돌파" 같은 뉴스 인용)
    assert any("지연시세" in x for x in _quote_check("주가가 7만원을 돌파했다고 보도됐다."))


def test_quote_rule_follows_the_source_even_without_a_price_word():
    """출처가 시세 그 자체(`[^krx]`)면 표기와 무관하게 고지 대상이다."""
    krx = [_qsent("전 거래일 대비 오름세로 마감했다.", {"type": "krx", "as_of": "20260804"})]
    v = _quote_check("전 거래일 대비 오름세로 마감했다.", sentences=krx)
    assert any("지연시세" in x for x in v), v


def test_removed_sentence_drops_out_of_the_quote_rule():
    """`제거`로 최종본에서 뺀 문장은 시세 규칙에서도 빠진다 — 게이트가 보는 건 최종본이다.
    ⚠️ 확인(ack)은 이 규칙을 못 푼다(test_ack_cannot_waive_forbidden_phrase와 짝)."""
    texts = ("주가는 7만원이다.", "매출액은 300조원이다.")
    assert any("지연시세" in x for x in _quote_check(*texts))
    assert _quote_check(*texts, removed={0}) == []


def test_waiver_opens_the_forbidden_phrase_rule_for_that_sentence_only():
    """준법이 사유를 적어 통과시킨 문장의 금지 표현만 빠진다(2026-08-06).

    쓰임: 제3자 목표주가를 **각주와 함께 인용한** 문장. 규칙은 제시와 인용을 구분하지
    못하고, 확인(ack)은 미인용 전용이라 예전엔 삭제 말고 길이 없었다.
    """
    quoted = "골드만삭스가 목표주가를 49만원으로 제시했다고 보도됐다."
    other = "당사는 목표주가를 12만원으로 봅니다."
    ours = [_qsent(quoted, {"type": "news"}), _qsent(other, {"type": "news"})]
    body = apply_notice(f"{quoted} {other}", "F3")

    # ⚠️ 위반 문구는 미인용 예시로 **문장 원문을 인용**한다 — `'목표주가' in x`로 세면
    #    엉뚱한 위반이 잡힌다. 규칙 이름("투자권유")으로 본다.
    assert any("투자권유" in x for x in check_note(body, ours, "F3"))
    # 인용 문장만 예외 → **다른 문장에 같은 표현이 남아 있으므로 여전히 막힌다**
    assert any("투자권유" in x for x in check_note(body, ours, "F3", None, None, {0}))
    # 둘 다 예외라야 풀린다 — 예외가 본문 전체로 번지지 않는다는 뜻이다
    assert check_note(body, ours, "F3", None, None, {0, 1}) == []


def test_waiver_opens_nothing_else():
    """⚠️ 예외는 **금지 표현 규칙 하나만** 연다 — 미인용·지연시세·MNPI는 그대로 막는다."""
    s = [_qsent("목표주가 49만원이라고 내부자 정보에 따르면 전해진다.")]  # 출처 없음
    v = check_note(apply_notice(s[0]["text"], "F3"), s, "F3", None, None, {0})
    assert not any("투자권유" in x for x in v)  # 금지 표현은 풀렸는데
    assert any("MNPI" in x for x in v), v  # MNPI는 그대로
    assert any("출처 없는" in x for x in v), v  # 미인용도 그대로


def test_target_price_is_not_a_market_quote():
    """`목표주가`는 `주가`를 품지만 시세가 아니다 — 지연시세 고지를 요구하지 않는다.
    (요구하면 예외로 금지 표현을 풀어도 시세 규칙이 남아 결국 못 낸다.)"""
    s = [_qsent("골드만삭스가 목표주가를 49만원으로 제시했다.", {"type": "news"})]
    v = check_note(apply_notice(s[0]["text"], "F3"), s, "F3", None, None, {0})
    assert v == [], v


def test_f1_notice_self_satisfies_delayed_quote():
    """F1 고지문구에 '지연시세'가 들어 있어, 시세를 실은 F1 답변도 QUOTE 게이트를 통과한다."""
    body = "종가는 185,900원입니다."
    assert check_note(apply_notice(body, "F1"), SOURCED, "F1") == []


def test_f1_gate_counts_unsourced_claims_only():
    """F1은 발행 단계가 없어 해석 문장은 위반으로 세지 않고, 근거 없는 사실 주장만 잡는다."""
    interp = [{"text": "판단하기 어렵습니다.", "source": None, "is_heading": False, "kind": "interpretation"}]
    # 해석 문장만 있는 F1 답변 → 위반 없음
    assert not any("출처 없는" in x for x in check_note(apply_notice("판단하기 어렵습니다.", "F1"), interp, "F1"))
    # 그러나 근거 없는 사실 주장은 F1에서도 잡는다
    claim = [{"text": "매출이 2배 늘었다.", "source": None, "is_heading": False, "kind": "claim"}]
    assert any("출처 없는" in x for x in check_note(apply_notice("매출이 2배 늘었다.", "F1"), claim, "F1"))
    # F3에서는 해석 문장도 게이트에 올라간다(발행 전 사람 검토용, §1-1)
    assert any("출처 없는" in x for x in check_note(apply_notice("판단하기 어렵습니다.", "F3"), interp, "F3"))


def test_acked_sentence_clears_unsourced_only():
    """준법이 확인한 미인용 문장은 게이트에서 빠진다 — 단 미인용 규칙에서만."""
    interp = {"text": "수익성 회복이 뚜렷하다고 볼 여지가 있다.", "source": None,
              "is_heading": False, "kind": "interpretation"}
    notice_line = {"text": "내부 참고용 초안이다.", "source": None,
                   "is_heading": False, "kind": "claim"}
    body = apply_notice("수익성 회복이 뚜렷하다고 볼 여지가 있다. 내부 참고용 초안이다.", "F3")

    # 확인 전 — 두 문장 다 미인용으로 잡힌다
    assert any("출처 없는 문장 2개" in x for x in check_note(body, [interp, notice_line], "F3"))
    # 하나만 확인 — 아직 1개 남는다
    assert any("출처 없는 문장 1개" in x for x in check_note(body, [interp, notice_line], "F3", {0}))
    # 둘 다 확인 — 게이트 통과. 해석뿐 아니라 분류기가 claim으로 본 고지 문장도 사람이 푼다
    assert check_note(body, [interp, notice_line], "F3", {0, 1}) == []


def _sent(text, kind="claim"):
    return {"text": text, "source": None, "is_heading": False, "kind": kind}


def test_live_acks_drops_confirmations_that_moved():
    """재파싱으로 인덱스가 밀린 확인은 무효다 — 원문 앞 60자로 대조한다(§1-2)."""
    sentences = [_sent("첫 문장이다."), _sent("두 번째 문장이다."), _sent("세 번째 문장이다.")]
    ok = {"index": 1, "text": "두 번째 문장이다.", "reason": "해석·전망", "actor": "준법"}
    moved = {"index": 0, "text": "두 번째 문장이다.", "reason": "해석·전망", "actor": "준법"}
    gone = {"index": 9, "text": "사라진 문장이다.", "reason": "해석·전망", "actor": "준법"}

    assert live_acks([ok], sentences) == [ok]        # 그 자리에 그 문장이 그대로
    assert live_acks([moved], sentences) == []       # 문장이 밀렸다 → 무효
    assert live_acks([gone], sentences) == []        # 인덱스가 범위 밖 → 무효
    # 섞여 있으면 유효한 것만 남는다(무효 때문에 유효한 것까지 버리지 않는다)
    assert live_acks([gone, ok, moved], sentences) == [ok]


def test_gate_and_screen_count_the_same_acks():
    """**화면 목록과 게이트가 같은 함수에서 나와야 한다.**

    저장된 목록을 그대로 세면 "확인 2개 · 남은 것 0개"라고 말한 뒤 발행이 막힌다 —
    2026-07-30에 실제로 그 상태였다(화면은 raw, 게이트는 live).
    """
    sentences = [_sent("근거가 필요한 주장이다."), _sent("해석에 가까운 문장이다.", "interpretation")]
    body = apply_notice("근거가 필요한 주장이다. 해석에 가까운 문장이다.", "F3")
    stale = {"index": 0, "text": "옛 문장이다.", "reason": "해석·전망", "actor": "준법"}
    fresh = {"index": 1, "text": "해석에 가까운 문장이다.", "reason": "해석·전망", "actor": "준법"}

    live = live_acks([stale, fresh], sentences)
    assert live == [fresh]
    # 화면이 셀 수(len(live))와 게이트가 남긴다고 보는 수가 어긋나지 않는다
    remaining = check_note(body, sentences, "F3", {a["index"] for a in live})
    assert any("출처 없는 문장 1개" in x for x in remaining)
    # 저장된 목록을 그대로 쓰면(옛 동작) 게이트가 통과해 버린다 — 그래서 무효를 걸러야 한다
    assert check_note(body, sentences, "F3", {a["index"] for a in [stale, fresh]}) == []


def test_ack_cannot_waive_forbidden_phrase():
    """확인은 미인용만 푼다 — 투자권유 표현·지연시세 누락은 문장을 고쳐야 한다."""
    s = [{"text": "목표주가는 20만원이다.", "source": None, "is_heading": False, "kind": "claim"}]
    v = check_note(apply_notice("목표주가는 20만원이다.", "F3"), s, "F3", {0})
    assert not any("출처 없는" in x for x in v)  # 미인용은 풀렸는데
    assert any("목표주가" in x for x in v)       # 투자권유 표현은 그대로 막는다


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
