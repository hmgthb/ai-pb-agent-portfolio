"""F2 고객 관련 종목 줄 — 고르기 규칙 · 비식별 경계 · 권유 차단 (2026-08-10).

이 줄은 브리핑에서 **고객 데이터가 근거가 되는 유일한 자리**다. 그래서 검사가 셋이다:
① 무엇을 올릴지 고르는 규칙이 결정론적인가 ② 경계를 넘는 것이 집계뿐인가
③ 사정을 말하는 문장이 "그래서 하라"로 미끄러지지 않는가.

⚠️ 여기 테스트는 **LLM을 부르지 않는다.** 부르는 자리(`main._watch_bullet`)는 얇게 두고,
   판단은 전부 순수 함수로 내려 두었기 때문이다 — 그게 이 설계의 요점이다.
"""

import re
from pathlib import Path

from backend import brief, redact
from backend.compliance import egress_guard

# --- 재료 -------------------------------------------------------------------

SHORT = {  # 기한이 급하고 자금성향이 투자성향보다 보수적인 고객
    "horizon": "1~2년",
    "registered_risk": 4,
    "effective_risk": 2,
    "effective_risk_why": "정리 일정과 보증금 지출이 겹쳐 단기 현금이 묶여 있음",
    "constraints": ["전세 보증금 지출 예정 — 현금을 함부로 쓸 수 없음"],
}
LONG = {"horizon": "10년 이상", "registered_risk": 4, "effective_risk": 4}


def _cust(scenario, *codes):
    return {
        "holdings": [{"code": c, "name": f"종목{c}", "amt": 10_000_000} for c in codes],
        "scenario": scenario,
    }


def _chg(pct):
    return {"pct": pct, "days": 5, "from": "20260803", "to": "20260810"}


# --- ① 고르는 규칙 ----------------------------------------------------------


def test_needs_both_a_move_and_a_reason():
    """움직임만으로도, 사정만으로도 올라가지 않는다 — 둘이 겹칠 때가 오늘 할 얘기다."""
    customers = [_cust(SHORT, "000001"), _cust(LONG, "000002")]
    changes = {"000001": _chg(1.0), "000002": _chg(20.0)}
    # 000001은 사정은 있으나 안 움직였고, 000002는 크게 움직였으나 사정이 없다.
    assert brief.watch_candidates(customers, changes) == []


def test_move_and_reason_together_make_a_candidate():
    customers = [_cust(SHORT, "000001")]
    got = brief.watch_candidates(customers, {"000001": _chg(-12.4)})
    assert [c["code"] for c in got] == ["000001"]
    assert got[0]["short"] == 1 and got[0]["gap"] == 1


def test_threshold_is_the_move_size_not_its_direction():
    """급락도 급등도 같은 문턱이다 — 방향은 PB가 읽고, 규칙은 크기만 본다."""
    customers = [_cust(SHORT, "000001")]
    below = brief.WATCH_MOVE_MIN - 0.1
    assert brief.watch_candidates(customers, {"000001": _chg(below)}) == []
    assert brief.watch_candidates(customers, {"000001": _chg(-below)}) == []
    assert len(brief.watch_candidates(customers, {"000001": _chg(brief.WATCH_MOVE_MIN)})) == 1


def test_order_puts_urgent_holders_first_then_size():
    """급한 사정 보유자 수 → |등락| 순. 크게 움직인 것이 아니라 급한 것이 먼저다."""
    customers = [
        _cust(SHORT, "000001"),
        _cust(SHORT, "000001"),  # 000001을 급한 고객 둘이 보유
        _cust(SHORT, "000002"),
    ]
    changes = {"000001": _chg(4.0), "000002": _chg(-30.0)}
    assert [c["code"] for c in brief.watch_candidates(customers, changes)] == [
        "000001",
        "000002",
    ]


def test_short_horizons_use_the_vocabulary_that_actually_exists():
    """`SHORT_HORIZONS`는 **seed가 쓰는 표기**의 부분집합이어야 한다(2026-08-11).

    이 목록은 틀려도 아무 데서도 터지지 않는다 — 없는 표기를 적어 두면 그 항목이 조용히
    죽고, 있는 표기를 빠뜨리면 급한 고객이 조용히 안 세어진다. 실제로 넷이 죽어 있었고
    (`1년`·`2년`·`2년 이내`·`6개월`) 셋이 빠져 있었다(`수령 직후`·`6개월 이내`·`6개월~1년`).
    그래서 주석이 아니라 테스트로 막는다 — 어휘의 단일 출처는 seed 스크립트다.
    """
    src = (Path(__file__).parent / "scripts" / "seed_scenarios.py").read_text("utf-8")
    vocab = set(re.findall(r'"horizon":\s*"([^"]+)"', src))
    assert vocab, "seed에서 horizon 리터럴을 못 찾았다 — 이 테스트가 먼저 낡았다"

    dead = set(brief.SHORT_HORIZONS) - vocab
    assert not dead, f"실제로 쓰이지 않는 표기: {sorted(dead)}"

    # 6개월~2년 안에 돈이 나가는 표기는 하나도 빠지면 안 된다. `상시`·`매년 정기 지출`은
    # 판단을 보류한 자리라(brief.SHORT_HORIZONS 주석) 여기서도 강제하지 않는다.
    for h in ("이미 시작", "수령 직후", "6개월 이내", "6개월~1년", "1년 이내", "1~2년"):
        assert h in vocab, f"seed가 더는 쓰지 않는 표기: {h}"
        assert brief._is_short_horizon({"horizon": h}), f"급한데 안 세는 표기: {h}"
    for h in ("2~3년", "3년 이상"):
        assert not brief._is_short_horizon({"horizon": h})


def test_candidates_are_capped():
    customers = [_cust(SHORT, "00000%d" % i) for i in range(1, 6)]
    changes = {"00000%d" % i: _chg(10.0 + i) for i in range(1, 6)}
    got = brief.watch_candidates(customers, changes)
    assert len(got) == brief.WATCH_BULLETS == 2


def test_selection_is_deterministic_on_ties():
    """동률이면 종목코드가 순서를 정한다 — 같은 입력에 같은 브리프여야 한다."""
    customers = [_cust(SHORT, "000002"), _cust(SHORT, "000001")]
    changes = {"000001": _chg(9.0), "000002": _chg(9.0)}
    twice = [
        [c["code"] for c in brief.watch_candidates(customers, changes)] for _ in range(2)
    ]
    assert twice[0] == twice[1] == ["000001", "000002"]


def test_missing_quote_drops_the_stock_instead_of_guessing():
    """시세를 못 가져온 종목은 후보에서 빠진다 — 0으로 채우지 않는다."""
    assert brief.watch_candidates([_cust(SHORT, "000001")], {}) == []


# --- ② 비식별 경계 ----------------------------------------------------------


def test_context_carries_aggregates_only_not_even_a_pseudonym():
    """가명(`고객 #1`)조차 담지 않는다 — 브리핑은 고객이 아니라 종목을 고르는 카드다."""
    ctx = redact.redact_watch("LG화학", [{"scenario": SHORT}, {"scenario": SHORT}])
    assert set(ctx) <= redact.SANITIZED_WATCH_KEYS
    assert ctx["holders"] == 2
    assert "고객 #" not in str(ctx)
    # 같은 사정을 둘이 공유해도 한 번만 나간다.
    assert ctx["constraints"] == SHORT["constraints"]
    assert ctx["horizons"] == ["1~2년"]


def test_context_never_carries_amounts():
    """금액은 어느 필드로도 나가지 않는다 — 반출 가드의 큰 정수 그물이 이를 확인한다."""
    ctx = redact.redact_watch("LG화학", [{"scenario": SHORT}])
    assert egress_guard("보유 맥락", None, [], watch=[ctx]) == []


def test_guard_blocks_a_context_that_skipped_redaction():
    """비식별화를 거치지 않은 원본이 오면 허용 목록에서 걸린다."""
    raw = {"stock_name": "LG화학", "holders": 1, "customer_name": "신태윤"}
    assert egress_guard("x", None, [], watch=[raw]) != []


def test_guard_still_catches_a_customer_name_in_the_prompt():
    ctx = redact.redact_watch("LG화학", [{"scenario": SHORT}])
    assert egress_guard("신태윤 고객 보유", None, ["신태윤"], watch=[ctx]) != []


# --- ③ 권유로 미끄러지지 않기 ------------------------------------------------

CTX = redact.redact_watch("LG화학", [{"scenario": SHORT}])
ROWS = [{"title": "LG화학, 3분기 증설 계획 발표", "link": "u", "pub_date": "p"}]


def _parse(text):
    return brief.parse_stock_headline(text, ROWS, CTX)


def test_a_plain_report_sentence_passes():
    assert _parse("LG화학이 증설 계획을 발표했다는 보도가 이어졌습니다.")


def test_context_may_be_mentioned_as_an_overlap():
    got = _parse("LG화학 증설 계획 보도가 이어졌으며, 정리 일정이 1~2년인 보유 고객과 겹칩니다.")
    assert got is not None


def test_recommendations_are_allowed_now():
    """**행동 권유 차단(`ADVICE_WORDS`)을 걷어냈다**(2026-08-10). 이 도구는 PB가 보는
    화면이고 어떤 종목을 권할지 AI가 말해도 된다 — 그 줄들이 전부 통과한다."""
    for ok in (
        "LG화학 증설 보도가 이어져 비중을 줄여야 합니다.",
        "LG화학 급락으로 매수 시점이라는 보도가 이어졌습니다.",
        "정리 일정을 서둘러야 한다는 점이 확인됩니다.",
        "보유 고객은 처분 검토가 필요합니다.",
        "LG화학이 유망하다는 보도가 이어졌습니다.",
        "리밸런싱을 권고한다는 분석이 나왔습니다.",
    ):
        assert _parse(ok) is not None, ok


def test_manufactured_certainty_is_still_rejected():
    """권하는 것과 **지어내는 것**은 다른 문제다 — 없는 확실성은 그대로 막힌다
    (`compliance.FORBIDDEN_PHRASES`에 남은 둘)."""
    for bad in (
        "LG화학은 수익을 보장한다는 보도가 이어졌습니다.",
        "LG화학은 무조건 오릅니다.",
    ):
        assert _parse(bad) is None, bad


def test_ordinary_factual_sentences_survive():
    """넓은 금지어는 엄격이 아니라 조용한 고장이다 — 버려진 줄은 화면에 안 보이므로,
    사실 문장이 통째로 사라져도 아무도 모른다."""
    for ok in (
        "LG화학이 증설 확대 계획을 발표했다는 보도가 이어졌습니다.",
        "LG화학 경영권 분쟁이 마무리됐다는 보도가 이어졌습니다.",
        "LG화학이 패키징 사업 정리를 발표했다는 보도가 이어졌습니다.",
    ):
        assert _parse(ok) is not None, ok


def test_reject_reason_is_reported_so_a_missing_line_is_diagnosable():
    """왜 안 나갔는지가 남아야 '오늘은 없었다'와 '검증에 걸렸다'를 가를 수 있다."""
    assert brief.stock_headline_reject("증설 보도가 이어졌습니다.", ROWS, CTX) is None
    assert "금지 표현" in brief.stock_headline_reject("수익을 보장합니다.", ROWS, CTX)
    assert "수치" in brief.stock_headline_reject("37% 급락했습니다.", ROWS, CTX)
    assert "빈 응답" == brief.stock_headline_reject("", ROWS, CTX)


def test_numbers_absent_from_the_input_are_rejected():
    """제목에도 맥락에도 없는 수치를 만들면 버린다(거시 줄과 같은 규칙)."""
    assert _parse("LG화학이 37% 급락했다는 보도가 이어졌습니다.") is None


def test_numbers_present_in_the_context_are_allowed():
    """맥락의 `1~2년`은 인용할 수 있어야 한다 — 검사의 분모가 제목 + 맥락인 이유다."""
    assert _parse("정리 일정이 1~2년인 보유 고객과 겹친다는 점이 확인됩니다.") is not None


def test_multi_sentence_and_overlong_are_rejected():
    assert _parse("증설 보도가 있었습니다. 그리고 또 있었습니다.") is None
    assert _parse("가" * (brief.STOCK_HEADLINE_MAX_LEN + 1)) is None


def test_bullet_carries_a_stock_code_but_never_a_customer():
    """화면이 **종목코드로 조인해** 고객 이름을 붙인다(`/api/customers`) — 그래서 불릿에는
    코드와 집계만 싣는다. 이름이나 id를 담으면 `briefs` 테이블에 고객 식별정보가 저장되고,
    그건 가드레일 1이 막는 자리다."""
    cand = brief.watch_candidates([_cust(SHORT, "000001")], {"000001": _chg(-12.4)})[0]
    b = brief.stock_headline_bullet("증설 보도가 이어졌습니다.", ROWS, cand)
    assert b["ai"] is True and b["kind"] == "watch"
    assert b["stock"] == {"code": "000001", "name": "종목000001", "holders": 1,
                          "days": 5, "pct": -12.4, "short": 1, "gap": 1}
    # 문자열 배지는 화면이 직접 그리므로 불릿에 없다(감사로그만 `watch_meta`를 쓴다).
    assert "meta" not in b
    # 고객을 가리키는 값은 어느 필드로도 나가지 않는다.
    assert "고객" not in str(b["stock"]) and "customer" not in str(b["stock"])


def test_audit_line_is_human_readable_not_json():
    """감시 탭은 사람이 읽는 화면이다 — dict를 넣으면 JSON이 찍힌다."""
    line = brief.watch_meta({"name": "SK하이닉스", "holders": 21, "days": 14,
                             "pct": -19.2, "short": 10, "gap": 13})
    assert line == "SK하이닉스 · 보유 21명 · 14일 -19.2% · 기한 임박 10명 · 자금성향 보수적 13명"


def test_bullet_keeps_model_text_and_sources():
    """모델이 쓴 것은 `text` 하나뿐 — 나머지(`stock`·`sources`)는 규칙이 만든다."""
    cand = brief.watch_candidates([_cust(SHORT, "000001")], {"000001": _chg(-12.4)})[0]
    b = brief.stock_headline_bullet("증설 보도가 이어졌습니다.", ROWS, cand)
    assert b["text"] == "증설 보도가 이어졌습니다."
    assert [s["url"] for s in b["sources"]] == ["u"]


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
