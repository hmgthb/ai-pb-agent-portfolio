"""외부 모델로 나가는 고객 데이터의 **비식별화 경계**.

현실 배치에서는 이 자리에 망분리된 내부 GPU가 선다: 원본은 경계 안에서만 돌고, 밖으로는
식별정보를 뺀 뒤 금액을 비율·구간으로 바꾼 것만 나간다. 이 레포에는 그 GPU가 없으므로
**규칙(순수 코드)이 그 일을 한다.**

⚠️ **정직하게 적어 둘 것: LLM에게 비식별화를 시키는 것 자체는 보안이 아니다.**
그 모델이 이미 원본을 봤기 때문이다(경계 밖이라면 원본이 이미 나간 뒤다). 보안은 경계가
**코드에 있고 그 경계를 지나는 것이 검사받는다**(`compliance.egress_guard`)는 사실에서 온다.
그래서 여기서 하는 일은 결정론적이고 크레딧이 0이며 테스트로 고정된다 —
구조화된 dict를 다루는 데는 규칙이 모델보다 명백히 낫다(자릿수가 안 틀리고, 재현된다).
모델이 필요한 자리는 정규식으로 안 되는 **자유 텍스트**이고 그건 아직 이 파일에 없다.

경계가 서는 곳은 `main.chat_stream` 하나다:
    portfolio_facts(원본) ──▶ redact_portfolio ──▶ egress_guard ──▶ 프롬프트
⚠️ **`f1.portfolio_facts`를 고쳐서 여기 맞추지 말 것** — 그건 화면(보유 표의 비중)과
   계산이 쓰는 단일 출처다. 경계는 그 **뒤**에 선다.
"""

from __future__ import annotations

# 잔고 구간. **넓게 5구간**인 것은 의도다 — 비중(`pct_of_balance`)이 같이 나가므로
# 구간이 좁을수록 `구간 × 비중`으로 원래 금액이 역산된다. 폭이 곧 방어선이다.
# ⚠️ 구간을 잘게 쪼개면 답변은 구체적이 되지만 재식별이 쉬워진다. 늘리기 전에 역산을 해 볼 것.
BALANCE_BANDS: list[tuple[float, str]] = [
    (100_000_000, "1억 미만"),
    (500_000_000, "1억~5억"),
    (1_000_000_000, "5억~10억"),
    (5_000_000_000, "10억~50억"),
    (float("inf"), "50억 이상"),
]

# 경계 밖으로 나갈 수 있는 키. **화이트리스트다** — 새 기능이 원본 dict를 그대로 얹으면
# `egress_guard`가 여기 없는 키를 보고 차단한다(모르는 것은 못 나간다).
SANITIZED_KEYS = frozenset({
    "customer_ref", "age_band",
    "risk_label", "balance_band", "return_pct", "alloc", "holdings", "flags",
    # 2026-08-07 — `Next Best Action` 채팅이 답할 둘의 근거. **넓히는 것이 명시적 결정**이라
    # 여기 적어 둔다: 상황과 상담 이력이 없으면 그 채팅은 아무것도 답할 수 없고, 대신
    # 경계를 지나는 것이 늘었다. 늘어난 만큼 아래 두 함수가 **필드 단위로 다시 고른다.**
    "scenario", "history",
})
SANITIZED_HOLDING_KEYS = frozenset({"code", "name", "pct_of_equity", "pct_of_balance"})
# 시나리오·히스토리도 **중첩 화이트리스트**를 갖는다(보유 종목과 같은 처방). 원본 dict를
# 통째로 얹는 코드가 생기면 `egress_guard`가 여기 없는 키를 보고 막는다.
# ⚠️ `registered_risk`·`effective_risk`(정수 인덱스)는 **여기 없다** — 라벨로 바꿔 내보낸다.
#    facts에서 `risk_index`를 빼던 것과 같은 이유다: 라벨이 이미 같은 말을 하고, 사본이 둘이면
#    언젠가 한쪽만 가려진다.
SANITIZED_SCENARIO_KEYS = frozenset({
    "key", "summary", "goal", "horizon", "assets", "constraints", "plan",
    "registered_risk_label", "effective_risk_label", "effective_risk_why",
})
SANITIZED_ASSET_KEYS = frozenset({"kind", "band", "where", "note"})
SANITIZED_HISTORY_KEYS = frozenset({"at", "kind", "detail"})


def balance_band(balance: float | int | None) -> str | None:
    """잔고 → 구간 이름. 값이 없으면 None(구간을 지어내지 않는다)."""
    if balance is None:
        return None
    for upper, label in BALANCE_BANDS:
        if balance < upper:
            return label
    return BALANCE_BANDS[-1][1]


def age_band(age: int | None) -> str | None:
    """나이 → 나이대(`38` → `30대`). 실나이는 경계를 넘지 않는다.

    **일반화**는 비식별화의 기본 수단이다 — 값을 지우는 대신 해상도를 낮춘다. 나이대는
    등록 위험성향 대비 구성을 읽을 때 실제로 쓰이는 맥락이라, 통째로 지우면 답변이 얕아진다.
    ⚠️ 10년 폭을 좁히지 말 것(5년 단위 등) — 좁힐수록 재식별이 쉬워진다(잔고 밴드와 같은 규칙).
    """
    if age is None:
        return None
    return f"{max(age // 10 * 10, 10)}대"


def customer_ref(customer_id: int | None) -> str | None:
    """고객 → **가명**(`고객 #1`). 이름 대신 나가는 값이다.

    ⚠️ **익명이 아니라 가명이다.** 원본 DB와 대조하면 사람이 특정된다 — 여기서 얻는 건
       "모델이 이름을 못 본다"이지 "누구인지 알 수 없다"가 아니다. 대화의 주어가 있어야
       답변이 "이 포트폴리오"를 가리킬 수 있어서 두는 것이고, 그 이상은 아니다.
    """
    return None if customer_id is None else f"고객 #{customer_id}"


def redact_scenario(scenario: dict | None, risk_labels: list[str]) -> dict | None:
    """고객 상황 → 경계를 넘을 모양. 없으면 None(빈 dict를 지어내지 않는다).

    **저장 시점에 이미 비식별화돼 있다** — 금액은 구간뿐이고 이름은 안 들어간다
    (`scripts/seed_scenarios.py`). 그래도 여기서 **다시 고르는** 이유는, 나중에 그 스크립트가
    필드를 늘렸을 때 경계가 자동으로 넓어지면 안 되기 때문이다(모르는 것은 못 나간다).

    ⚠️ 성향은 **정수 인덱스가 아니라 라벨로** 내보낸다. 모델이 `4`를 보고 무엇인지 맞히게
       하지 않는다 — 맞히게 하면 틀릴 수 있고, 라벨은 이미 있다.
    """
    if not scenario:
        return None

    def _label(i):
        return risk_labels[i] if isinstance(i, int) and 0 <= i < len(risk_labels) else None

    out = {
        "key": scenario.get("key"),
        "summary": scenario.get("summary"),
        "goal": scenario.get("goal"),
        "horizon": scenario.get("horizon"),
        "assets": [
            {k: v for k, v in (a or {}).items() if k in SANITIZED_ASSET_KEYS}
            for a in scenario.get("assets") or []
        ],
        "constraints": list(scenario.get("constraints") or []),
        "plan": list(scenario.get("plan") or []),
        "registered_risk_label": _label(scenario.get("registered_risk")),
        "effective_risk_label": _label(scenario.get("effective_risk")),
        "effective_risk_why": scenario.get("effective_risk_why"),
    }
    return {k: v for k, v in out.items() if v not in (None, [], "")}


def redact_history(history: list[dict] | None) -> list[dict]:
    """상담 이력 → 경계를 넘을 모양. 필드 셋(`at`·`kind`·`detail`)만 남긴다.

    ⚠️ 이 목록에는 **판정이 없다**(`안정형으로 보임` 같은 결론). 그건 답변이 할 일이고,
       데이터에 미리 적혀 있으면 모델이 그걸 베껴 쓰면서 근거는 사라진다.
    """
    return [
        {k: v for k, v in (h or {}).items() if k in SANITIZED_HISTORY_KEYS}
        for h in history or []
    ]


def redact_portfolio(
    facts: dict,
    customer_id: int | None = None,
    age: int | None = None,
    scenario: dict | None = None,
    history: list[dict] | None = None,
    risk_labels: list[str] | None = None,
) -> tuple[dict, dict]:
    """`f1.portfolio_facts()` 결과 → (경계 밖으로 보낼 dict, 무엇을 했는지 보고).

    `customer_id`·`age`는 `portfolio_facts`가 **일부러 담지 않는 값**이라(가드레일 1) 따로
    받는다. 여기서 가명·나이대로 바꾼 뒤에만 경계를 넘는다 — 원본은 어느 쪽으로도 안 나간다.

    보고(report)는 화면 배지가 쓴다. **원본 값은 담지 않는다** — 보고 자체가 SSE로 나가고
    화면에 그려지므로, 거기 실금액을 실으면 가린 의미가 없다. 담기는 건 '무엇을 어떻게
    했는가'라는 항목 이름뿐이다.
    """
    # kind는 **두 가지를 섞어 세지 않으려고** 있다:
    #   mask = 민감해서 가린 것(실금액). 이 개수가 곧 "이 경계가 실제로 한 일"이다.
    #   drop = 사본이라 지운 것. 안 가려도 무해했다 — 이걸 같이 세면 배지 숫자가 부풀고
    #          "5개나 가렸다"가 사실이 아니게 된다.
    removed: list[dict] = []

    ages = age_band(age)
    if age is not None:
        removed.append({"label": "나이", "how": f"나이대로 일반화({ages})", "kind": "mask"})
    # 가명은 **가린 것이 아니라 더한 것**이라 보고에 안 넣는다(배지 숫자는 가린 개수다).
    ref = customer_ref(customer_id)

    band = balance_band(facts.get("balance"))
    if facts.get("balance") is not None:
        removed.append({"label": "잔고 실금액", "how": f"구간으로 대체({band})", "kind": "mask"})

    holdings = []
    for h in facts.get("holdings") or []:
        holdings.append({
            "code": h.get("code"),
            "name": h.get("name"),
            "pct_of_equity": h.get("pct_of_equity"),
            "pct_of_balance": h.get("pct_of_balance"),
        })
    if any("amt" in (h or {}) for h in facts.get("holdings") or []):
        removed.append({"label": "종목별 평가금액", "how": "비중(%)만 남김", "kind": "mask"})

    # `risk_index`(정수)와 `equity_pct`·`top_holding`은 지운다. 앞의 것은 라벨이 이미
    # 같은 말을 하고, 뒤의 둘은 `alloc`·`holdings[0]`의 사본이다 — 경계를 지나는 것은
    # 적을수록 좋고, 사본이 둘이면 언젠가 한쪽만 가려진다.
    for key, label in (("risk_index", "위험성향 코드"), ("equity_pct", "주식 비중 사본"),
                       ("top_holding", "최대 보유 사본")):
        if facts.get(key) is not None:
            removed.append({"label": label, "how": "중복이라 제외", "kind": "drop"})

    sanitized = {
        # 이름 자리에 서는 값. 대화의 주어가 있어야 답변이 "이 포트폴리오"를 가리킨다.
        "customer_ref": ref,
        "age_band": ages,
        "risk_label": facts.get("risk_label"),
        "balance_band": band,
        "return_pct": facts.get("return_pct"),
        "alloc": facts.get("alloc") or [],
        "holdings": holdings,
        # 플래그는 코드가 판정한 결과 문장이다(`pb_customers.flag_reasons`). 지금 규칙 3종은
        # %와 종목명만 쓰지만, ⚠️ **규칙을 늘릴 때 금액이 문장에 섞이지 않는지 확인할 것** —
        # 섞이면 `egress_guard`의 큰 정수 규칙에 걸려 답변이 통째로 막힌다(막히는 게 맞다).
        "flags": facts.get("flags") or [],
    }

    # 상황·상담 이력 — 있을 때만 싣는다(빈 값을 자리만 채워 넣지 않는다).
    # ⚠️ 이건 `drop`도 `mask`도 아니다. 가린 것이 아니라 **더 나가는 것**이라, 화면 배지의
    #    "가린 개수"에 세지 않는다(가명을 안 세는 것과 같은 규칙). 대신 무엇이 더 나가는지는
    #    `/egress-preview`가 payload를 통째로 보여 주므로 화면에서 그대로 읽힌다.
    scen = redact_scenario(scenario, risk_labels or [])
    if scen:
        sanitized["scenario"] = scen
    hist = redact_history(history)
    if hist:
        sanitized["history"] = hist

    report = {"mode": "rule", "removed": removed}
    return sanitized, report
