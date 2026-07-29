"""비식별화 경계 + 반출 가드 자체 점검 (크레딧 불필요 — LLM 호출 없음).

실행: backend/.venv/bin/python -m backend.test_redact
"""

from backend import f1, redact
from backend.compliance import egress_guard

# test_f1.py의 _CUST와 같은 모양(main._customer_to_dict 형태). 여기서는 금액이 커야
# 밴드·큰 정수 규칙이 실제로 눌린다.
_CUST = {
    "name": "신태윤",
    "acct": "110-***-724441",
    "age": 41,
    "risk": 2,
    "balance": 1_430_000_000,
    "ret": -2.3,
    "alloc": {"현금성": 4, "채권": 12, "펀드": 10, "국내주식": 74},
    "holdings": [
        {"code": "005930", "name": "삼성전자", "amt": 580_000_000},
        {"code": "000660", "name": "SK하이닉스", "amt": 560_000_000},
    ],
    "flagReasons": [{"key": "conc", "text": "보유주식 내 삼성전자 집중 50.9%"}],
}


# ── 밴드 ──────────────────────────────────────────────────
def test_bands_cover_the_line_and_never_invent():
    assert redact.balance_band(None) is None  # 없는 값에 구간을 지어내지 않는다
    assert redact.balance_band(0) == "1억 미만"
    assert redact.balance_band(99_999_999) == "1억 미만"
    # 경계값은 위 구간에 붙는다(< upper) — 1억은 "1억 미만"이 아니라 "1억~5억"이다.
    assert redact.balance_band(100_000_000) == "1억~5억"
    assert redact.balance_band(1_430_000_000) == "10억~50억"
    assert redact.balance_band(5_000_000_000) == "50억 이상"
    assert redact.balance_band(10**15) == "50억 이상"


def test_bands_are_wide_enough_that_reverse_math_stays_vague():
    """밴드 폭이 곧 방어선이다 — 비중이 같이 나가므로 `구간 × 비중`으로 금액이 역산된다.
    구간을 좁히려면 먼저 이 계산을 다시 해 볼 것."""
    facts = f1.portfolio_facts(_CUST)
    top = facts["holdings"][0]
    lo, hi = 1_000_000_000, 5_000_000_000  # "10억~50억"
    span = (hi - lo) * top["pct_of_balance"] / 100
    assert span > 1_000_000_000, "역산 폭이 10억 미만이면 사실상 금액이 드러난다"


# ── 비식별화 ───────────────────────────────────────────────
def test_age_is_generalized_not_deleted():
    """일반화는 삭제가 아니다 — 나이대는 성향 대비를 읽는 맥락이라 남기되 해상도를 낮춘다.
    ⚠️ 10년 폭을 좁히지 말 것(잔고 밴드와 같은 규칙: 좁힐수록 재식별이 쉬워진다)."""
    assert redact.age_band(None) is None  # 없는 값에 나이대를 지어내지 않는다
    assert redact.age_band(38) == "30대"
    assert redact.age_band(40) == "40대"
    assert redact.age_band(9) == "10대"  # 아래로 새지 않는다(`0대`가 나오면 안 된다)


def test_customer_ref_is_a_pseudonym_not_the_name():
    assert redact.customer_ref(None) is None
    assert redact.customer_ref(5) == "고객 #5"


def test_sanitized_payload_carries_no_amount_and_no_identity():
    """가드레일 1 — 이 dict가 그대로 프롬프트가 된다."""
    sanitized, _ = redact.redact_portfolio(
        f1.portfolio_facts(_CUST), customer_id=5, age=_CUST["age"]
    )
    blob = repr(sanitized)
    for leak in ("신태윤", "110-***-724441", "1430000000", "580000000"):
        assert leak not in blob, f"경계 밖으로 샜다: {leak}"
    # 실나이(41)는 안 나가고 나이대만 나간다.
    assert sanitized["age_band"] == "40대" and str(_CUST["age"]) not in blob
    assert sanitized["customer_ref"] == "고객 #5"
    assert sanitized["balance_band"] == "10억~50억"
    assert "balance" not in sanitized
    assert all("amt" not in h for h in sanitized["holdings"])


def test_sanitized_keeps_what_the_answer_actually_needs():
    """가리느라 답할 수 없게 만들면 안 된다 — 집중도·배분·성향 대비는 그대로 답해진다."""
    sanitized, _ = redact.redact_portfolio(f1.portfolio_facts(_CUST))
    assert sanitized["risk_label"] == "위험중립형"
    assert sanitized["return_pct"] == -2.3
    assert {a["class"] for a in sanitized["alloc"]} == set(_CUST["alloc"])
    top = sanitized["holdings"][0]
    assert top["name"] == "삼성전자" and top["pct_of_equity"] == 50.9
    assert sanitized["flags"][0]["text"].startswith("보유주식 내")


def test_report_names_what_was_removed_without_the_values():
    """보고 자체가 SSE로 나가 화면에 그려진다 — 거기 실금액을 실으면 가린 의미가 없다."""
    _, report = redact.redact_portfolio(f1.portfolio_facts(_CUST))
    assert report["mode"] == "rule"
    labels = {r["label"] for r in report["removed"]}
    assert {"잔고 실금액", "종목별 평가금액"} <= labels
    assert "1430000000" not in repr(report) and "580000000" not in repr(report)


def test_report_separates_masking_from_deduplication():
    """화면 배지가 `mask`만 센다 — 사본을 지운 것까지 합쳐 세면 "5개나 가렸다"가 된다.
    가린 것은 실금액 둘뿐이고, 나머지는 안 가려도 무해했던 중복이다."""
    _, report = redact.redact_portfolio(f1.portfolio_facts(_CUST))
    masked = [r for r in report["removed"] if r["kind"] == "mask"]
    assert {r["label"] for r in masked} == {"잔고 실금액", "종목별 평가금액"}
    assert all(r["kind"] in ("mask", "drop") for r in report["removed"])


def test_empty_holdings_do_not_claim_a_removal():
    """보유가 비면 "종목별 평가금액을 가렸다"고 말하면 안 된다 — 가릴 게 없었다."""
    empty = {**_CUST, "holdings": [], "balance": None, "flagReasons": []}
    sanitized, report = redact.redact_portfolio(f1.portfolio_facts(empty))
    assert sanitized["balance_band"] is None and sanitized["holdings"] == []
    labels = {r["label"] for r in report["removed"]}
    assert "잔고 실금액" not in labels and "종목별 평가금액" not in labels


# ── 반출 가드 ──────────────────────────────────────────────
def _clean_prompt() -> str:
    sanitized, _ = redact.redact_portfolio(f1.portfolio_facts(_CUST))
    r = f1.route("집중도 어때?", has_portfolio=True)
    return f1.answer_input("집중도 어때?", r, {"portfolio": sanitized}), sanitized


def test_guard_passes_the_normal_path():
    prompt, sanitized = _clean_prompt()
    assert egress_guard(prompt, sanitized, ["신태윤", "강준서"]) == []


def test_guard_blocks_raw_facts_that_skipped_the_boundary():
    """새 기능이 원본을 그대로 얹는 경우 — 허용 목록에 없는 키에서 걸린다."""
    raw = f1.portfolio_facts(_CUST)
    v = egress_guard("아무 프롬프트", raw, [])
    assert v and any("허용 목록" in x for x in v)


def test_guard_blocks_amount_hidden_in_holdings_row():
    """상위 키는 멀쩡한데 보유 행에만 금액이 남은 경우(부분 비식별화)."""
    sanitized, _ = redact.redact_portfolio(f1.portfolio_facts(_CUST))
    sanitized["holdings"][0]["amt"] = 580_000_000
    v = egress_guard("아무 프롬프트", sanitized, [])
    assert any("보유 종목에 허용되지 않은" in x for x in v)
    assert any("계좌 금액으로 보이는" in x for x in v)  # 큰 정수 그물에도 걸린다


def test_guard_catches_customer_name_in_free_text():
    """PII_PATTERNS는 숫자 형식만 봐서 한글 이름을 못 잡았다(HANDOFF §7). 이제 명단 대조다."""
    prompt, sanitized = _clean_prompt()
    v = egress_guard(prompt + "\n신태윤 고객이 물어본 건데", sanitized, ["신태윤", "강준서"])
    assert any("신태윤" in x for x in v)


def test_guard_catches_account_number_in_free_text():
    prompt, sanitized = _clean_prompt()
    v = egress_guard(prompt + "\n계좌 110-123-724441 확인해줘", sanitized, [])
    assert any("PII" in x for x in v)


def test_guard_does_not_block_public_market_and_dart_numbers():
    """⚠️ 회귀 고정 — 큰 정수 규칙을 프롬프트 전체에 걸면 KRX 종가·DART 재무수치가
    통째로 막힌다. 그건 공개데이터라 가릴 대상이 아니다(가드레일 1)."""
    r = f1.route("삼성전자 최근 실적", has_portfolio=False)
    prompt = f1.answer_input("삼성전자 최근 실적", r, {
        "financials": {"bsns_year": "2024", "fs_div": "CFS",
                       "figures": {"매출액": {"당기": "10737700000000", "전기": "9670600000000"}}},
        "quote": {"close": "71900", "as_of": "20260728", "change": "800",
                  "change_pct": "1.1", "source": "KRX"},
    })
    assert "10737700000000" in prompt  # 실제로 큰 정수가 들어 있다
    assert egress_guard(prompt, None, ["신태윤"]) == []


def test_guard_skips_two_letter_names_by_design():
    """2글자 이름은 대조하지 않는다 — 일반 낱말과 겹쳐 오탐이 크다. 못 잡는 걸 한계로
    남기고 지어내지 않는다(목업 고객 50명은 전원 3글자다)."""
    assert egress_guard("한수 고객 문의", None, ["한수"]) == []


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
