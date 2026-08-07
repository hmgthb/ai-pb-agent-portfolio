"""고객 50명에게 **상황(시나리오)**를 붙이는 UPDATE SQL을 만든다.

## 왜 필요한가

계좌 숫자만으로는 상담이 안 된다. 등록 성향이 `공격투자형`이어도 반년 뒤 전세 보증금을
치러야 하면 지금 실질은 `안정형`이고, 그 간극이 상담에서 가장 먼저 확인할 것인데 지금까지
화면 어디에도 없었다. 잔고·수익률·자산배분은 **결과**만 보여 주고 **왜 그런지**는 안 보여 준다.

## 구조 — 산문이 아니라 필드다

자유 산문으로 두면 규칙이 비식별화할 수 없다(HANDOFF §7 — 자유 텍스트 비식별화기가 없다).
F1에서 외부 모델로 나갈 후보이므로 **저장 시점에 이미 비식별화된 모양**으로 적는다:

    {"summary", "goal", "horizon", "assets"[], "constraints"[], "plan"[],
     "effective_risk", "effective_risk_why"}

⚠️ **금액은 구간뿐이다**(`redact.BALANCE_BANDS`와 같은 어휘). 계좌 밖 자산도 마찬가지다 —
   가릴 것이 없으면 못 가려서 새는 일도 없다.
⚠️ **고객 이름이 문장에 들어가지 않는다** — `compliance.egress_guard`가 담당 고객명을 대조해
   차단한다. 이름을 넣으면 시나리오를 프롬프트에 싣는 순간 답변이 통째로 막힌다.
⚠️ `effective_risk`는 **`f1.RISK_LABELS`의 인덱스**다(등록 성향과 같은 축이라야 견줄 수 있다).

## 난수를 쓰지 않는다

`reseed_holdings.py`와 같은 규칙이다 — 같은 입력이면 같은 SQL이 나와야 다시 돌려도
데이터가 흔들리지 않고, 리뷰가 가능하다. 배정은 `id`에서 결정론적으로 유도한다.

## 시나리오는 고객 데이터와 **맞물려야** 한다

62세 안정형에게 `창업 자금`을 주면 화면이 스스로 모순된다. 그래서 원형(archetype)마다
나이·잔고 조건을 두고, 조건을 만족하는 것 중에서만 고른다.

출력은 SQL이고 DB에 직접 쓰지 않는다 — 사람이 보고 실행한다(reseed_holdings와 같은 규약).

실행:
    docker compose exec -T backend python /repo/backend/scripts/seed_scenarios.py > /tmp/scenarios.sql
"""

import asyncio
import json
import os

import asyncpg
import dotenv

# 위험성향 라벨 — `f1.RISK_LABELS`와 **같은 순서여야 한다**(어긋나면 실질 성향이 거짓말한다).
RISK_LABELS = ["안정형", "안정추구형", "위험중립형", "적극투자형", "공격투자형"]

# 계좌 밖 자산의 금액 어휘. **`redact.BALANCE_BANDS`의 라벨과 같은 말을 쓴다** — 화면에서
# 증권잔고 구간과 나란히 서는데 어휘가 다르면 읽는 사람이 두 척도를 견주게 된다.
BANDS = ["1억 미만", "1억~5억", "5억~10억", "10억~50억", "50억 이상"]

# 지역은 **이름을 그대로 쓴다**(가명 처리 대상이 아니다) — 부동산 정리 순서를 말하려면
# 어디인지가 정보 그 자체이고, 지역명은 개인을 특정하지 않는다.
METRO = ["용인", "수원", "성남", "고양", "화성", "김포"]
SEOUL = ["마포", "성동", "노원", "은평", "동작", "광진"]
TARGET = ["강남", "서초", "송파", "용산", "성수", "여의도"]


def _pick(seq, n):
    """id에서 결정론적으로 하나 고른다 — 난수를 쓰지 않는다(위 머리말)."""
    return seq[n % len(seq)]


def _band_of(balance):
    """증권 잔고 → 구간 라벨. `redact.balance_band`와 같은 경계다."""
    for upper, label in zip((1e8, 5e8, 1e9, 5e9), BANDS):
        if balance < upper:
            return label
    return BANDS[-1]


def _shift_band(balance, steps):
    """계좌 밖 자산 구간 = 증권 잔고 구간에서 몇 칸 옮긴 것.

    부동산을 든 고객은 대개 증권 잔고보다 계좌 밖 자산이 크다 — 그 관계를 고정해 두면
    시나리오가 계좌 숫자와 어긋나지 않는다(예: 잔고 3백만원인데 현금 7억을 적는 일이 없다).
    """
    i = BANDS.index(_band_of(balance))
    return BANDS[max(0, min(len(BANDS) - 1, i + steps))]


# ── 원형(archetype) ─────────────────────────────────────────────────────────
#
# `when(age, risk, balance)` — 이 고객에게 이 상황이 말이 되는가.
# `risk_shift` — 등록 성향에서 몇 칸 옮긴 것이 **지금의 실질 성향**인가.
#     음수 = 단기 자금이 묶여 보수적으로 봐야 한다 · 0 = 등록 성향 그대로 ·
#     양수 = 목적 자금이 따로 있어 이 계좌는 더 공격적으로 둘 수 있다.
# `build(c)` — 고객 dict를 받아 나머지 필드를 만든다.
#
# ⚠️ **AI가 판단한 것이 아니다.** 이건 목업 데이터이고, 실제 배치에서는 PB가 상담 기록에서
#    적어 넣는 칸이다. 화면도 그렇게 말해야 한다(AI 생성 배지를 붙이지 말 것).
ARCHETYPES = [
    {
        "key": "multi_home",
        "label": "다주택 정리 후 상급지 이동",
        "when": lambda a, r, b: 35 <= a <= 58 and b >= 5e8,
        "risk_shift": -2,
        "build": lambda c: {
            "goal": f"{_pick(TARGET, c['id'])} 주택 마련",
            "horizon": "1~2년",
            "assets": [
                # ⚠️ 증권 잔고보다 **한 구간 아래**다. 위로 올리면 잔고 15억짜리 고객에게
                #    현금 `50억 이상`이 붙어, 계좌가 자산의 일부라는 사실이 뒤집힌다.
                {"kind": "현금", "band": _shift_band(c["balance"], -1)},
                {"kind": "주택", "where": _pick(METRO, c["id"])},
                {"kind": "주택", "where": _pick(SEOUL, c["id"] + 2)},
            ],
            "constraints": [
                "다주택 정책으로 1주택 정리 필요",
                "전세 보증금 지출 예정 — 현금을 함부로 쓸 수 없음",
            ],
            "plan": [
                f"{_pick(METRO, c['id'])} 주택 우선 정리",
                f"이후 {_pick(SEOUL, c['id'] + 2)} 주택 정리",
            ],
            "why": "정리 일정과 보증금 지출이 겹쳐 단기 현금이 묶여 있음",
        },
    },
    {
        "key": "retire_income",
        "label": "은퇴 후 현금흐름 전환",
        "when": lambda a, r, b: a >= 57,
        "risk_shift": -1,
        "build": lambda c: {
            "goal": "월 생활비를 배당·이자로 충당",
            "horizon": "이미 시작",
            "assets": [
                {"kind": "예금", "band": _shift_band(c["balance"], -1)},
                {"kind": "주택", "where": _pick(SEOUL, c["id"]), "note": "거주 중"},
            ],
            "constraints": ["근로소득 종료 — 원금 인출이 곧 생활비 감소"],
            "plan": ["인출률을 먼저 정하고 그에 맞춰 배분 조정", "국민연금 수령 시점과 맞물려 재검토"],
            "why": "인출이 시작돼 원금 변동을 견딜 여력이 줄었음",
        },
    },
    {
        "key": "tuition",
        "label": "자녀 유학·학자금 지출",
        "when": lambda a, r, b: 40 <= a <= 56,
        "risk_shift": -1,
        "build": lambda c: {
            "goal": "학비를 정해진 시점에 환차손 없이 지급",
            "horizon": "매년 정기 지출",
            "assets": [
                {"kind": "예금", "band": _shift_band(c["balance"], 0)},
                {"kind": "외화예금", "band": "1억 미만"},
            ],
            "constraints": ["학기마다 고정 지출", "환율 변동이 실지출에 직결"],
            "plan": ["학기 단위 필요액을 먼저 떼어 두기", "남는 자금만 위험자산에 배분"],
            "why": "정해진 시점에 반드시 필요한 자금이 매년 나감",
        },
    },
    {
        "key": "business_sale",
        "label": "사업체 매각 대금 유입 예정",
        "when": lambda a, r, b: 45 <= a <= 62 and b >= 1e9,
        "risk_shift": 0,
        "build": lambda c: {
            "goal": "매각 대금의 운용 구조를 미리 정해 두기",
            "horizon": "6개월~1년",
            "assets": [
                {"kind": "비상장 지분", "band": _shift_band(c["balance"], 1)},
                {"kind": "현금", "band": _shift_band(c["balance"], -1)},
            ],
            "constraints": ["매각 시점 미확정", "유입 시 양도세 재원 필요"],
            "plan": ["세금 재원을 먼저 분리", "잔여분의 배분안을 유입 전에 확정"],
            "why": "큰 유입이 예정돼 지금 배분을 크게 바꾸면 두 번 손대게 됨",
        },
    },
    {
        "key": "inheritance",
        "label": "상속·증여 진행 중",
        "when": lambda a, r, b: a >= 48,
        "risk_shift": -1,
        "build": lambda c: {
            "goal": "세대 이전을 세금 부담이 작은 순서로",
            "horizon": "2~3년",
            "assets": [
                {"kind": "주택", "where": _pick(SEOUL, c["id"] + 1)},
                {"kind": "예금", "band": _shift_band(c["balance"], 0)},
            ],
            "constraints": ["증여세 납부 재원 필요", "이전 대상 자산은 처분 제약"],
            "plan": ["납부 재원부터 확보", "이전 순서를 확정한 뒤 잔여 자산 배분"],
            "why": "납부 시점이 정해져 있어 그때까지 현금을 지켜야 함",
        },
    },
    {
        "key": "jeonse_to_buy",
        "label": "전세에서 매매로 전환",
        "when": lambda a, r, b: 28 <= a <= 42,
        "risk_shift": -2,
        "build": lambda c: {
            "goal": f"{_pick(SEOUL, c['id'])} 주택 매입",
            "horizon": "1년 이내",
            "assets": [
                {"kind": "전세보증금", "band": _shift_band(c["balance"], 0)},
                {"kind": "현금", "band": _shift_band(c["balance"], -1)},
            ],
            "constraints": ["계약 만기에 맞춰 잔금 필요", "대출 한도가 매입가를 제한"],
            "plan": ["잔금 소요액을 먼저 확정", "만기 전까지는 원금 손실 위험을 최소화"],
            "why": "만기라는 고정된 날짜에 목돈이 나가야 함",
        },
    },
    {
        "key": "severance",
        "label": "퇴직금 수령 후 운용",
        "when": lambda a, r, b: a >= 55,
        "risk_shift": -1,
        "build": lambda c: {
            "goal": "퇴직금을 연금 형태로 나눠 받기",
            "horizon": "수령 직후",
            "assets": [
                {"kind": "퇴직연금", "band": _shift_band(c["balance"], 0)},
                {"kind": "현금", "band": "1억 미만"},
            ],
            "constraints": ["일시금 수령 시 세부담 증가", "재취업 여부 미정"],
            "plan": ["연금 수령 방식으로 세부담 먼저 확인", "생활비 공백 구간의 현금 확보"],
            "why": "소득이 끊긴 구간이 있어 원금을 지켜야 함",
        },
    },
    {
        "key": "startup",
        "label": "창업 자금 확보",
        "when": lambda a, r, b: 30 <= a <= 45 and r >= 2,
        "risk_shift": -2,
        "build": lambda c: {
            "goal": "초기 운영자금 확보",
            "horizon": "6개월 이내",
            "assets": [{"kind": "현금", "band": _shift_band(c["balance"], 0)}],
            "constraints": ["개업 초기 수입 공백", "보증금·설비 지출 예정"],
            "plan": ["공백 기간 생활비를 먼저 떼어 두기", "그 뒤 남는 자금만 운용"],
            "why": "수입 공백이 예정돼 있어 당분간 인출 가능성이 높음",
        },
    },
    {
        "key": "relocate",
        "label": "해외 이주 준비",
        "when": lambda a, r, b: 30 <= a <= 50,
        "risk_shift": -1,
        "build": lambda c: {
            "goal": "이주 후 현지 정착 자금 마련",
            "horizon": "1~2년",
            "assets": [
                {"kind": "외화예금", "band": _shift_band(c["balance"], -1)},
                {"kind": "현금", "band": _shift_band(c["balance"], 0)},
            ],
            "constraints": ["환율 변동이 정착 자금에 직결", "국내 자산 처분 일정 미확정"],
            "plan": ["필요 외화를 분할 매수", "국내 자산은 처분 시점을 나눠 잡기"],
            "why": "환전 시점이 정해져 있어 변동을 크게 받으면 계획이 흔들림",
        },
    },
    {
        "key": "care_cost",
        "label": "가족 의료·간병 지출",
        "when": lambda a, r, b: a >= 50,
        "risk_shift": -2,
        "build": lambda c: {
            "goal": "예측하기 어려운 지출에 대비",
            "horizon": "상시",
            "assets": [{"kind": "예금", "band": _shift_band(c["balance"], 0)}],
            "constraints": ["지출 시점·규모 예측 어려움", "언제든 인출 가능해야 함"],
            "plan": ["즉시 인출 가능한 몫을 먼저 정하기", "나머지만 만기를 두고 운용"],
            "why": "예고 없이 인출해야 할 수 있어 환금성이 우선",
        },
    },
    {
        "key": "first_home",
        "label": "결혼·첫 주택 마련",
        "when": lambda a, r, b: a <= 36,
        "risk_shift": -1,
        "build": lambda c: {
            "goal": f"{_pick(METRO, c['id'])} 첫 주택 마련",
            "horizon": "2~3년",
            "assets": [{"kind": "현금", "band": _shift_band(c["balance"], 0)}],
            "constraints": ["청약·대출 조건에 따라 시점이 달라짐", "예식 관련 지출 예정"],
            "plan": ["필요 자기자금 규모를 먼저 확정", "그때까지는 손실 구간을 짧게 유지"],
            "why": "목표 시점이 가까워 회복 기간을 길게 잡기 어려움",
        },
    },
    {
        "key": "rental_shift",
        "label": "보유 부동산 임대 전환",
        "when": lambda a, r, b: a >= 46 and b >= 3e8,
        "risk_shift": 1,
        "build": lambda c: {
            "goal": "임대 수입으로 생활비를 충당하고 계좌는 장기 운용",
            "horizon": "3년 이상",
            "assets": [
                {"kind": "주택", "where": _pick(METRO, c["id"] + 3), "note": "임대 예정"},
                {"kind": "주택", "where": _pick(SEOUL, c["id"]), "note": "거주 중"},
            ],
            "constraints": ["공실 구간에는 수입이 끊김"],
            "plan": ["임대 전환 후 수입이 안정되면 계좌는 장기 자금으로 분리"],
            "why": "생활비가 임대 수입으로 충당되면 이 계좌는 당장 쓸 돈이 아님",
        },
    },
]


def _eligible(c: dict) -> list[dict]:
    """이 고객에게 말이 되는 원형들. 하나도 없으면 가장 일반적인 것으로 떨어진다 —
    시나리오가 비면 화면에 빈 칸이 생기는데, 그건 "상황이 없다"가 아니라 "못 만들었다"이다."""
    out = [a for a in ARCHETYPES if a["when"](c["age"], c["risk"], c["balance"])]
    return out or [a for a in ARCHETYPES if a["key"] == "first_home"]


def assign(customers: list[dict]) -> dict[int, dict]:
    """id 순으로 돌며 **지금까지 가장 적게 쓴 원형**을 준다 → {고객 id: 시나리오}.

    처음에는 `id`에서 곧장 골랐는데(`(id * 7) % len(eligible)`) 쏠렸다: 후보 집합이 고객마다
    달라서 나머지 연산이 고르게 퍼지지 않는다. 실측으로 `전세→매매`가 50명 중 10명이었고
    정작 대표 사례인 `다주택 정리`는 2명이었다 — 목업의 목적은 **여러 상황을 보여 주는 것**이라
    그 분포가 곧 결함이다.

    ⚠️ 난수가 아니다. id 순서가 고정이므로 다시 돌려도 같은 결과가 나온다(이 파일의 규칙).
    ⚠️ 동점이면 `ARCHETYPES`에 적힌 순서가 이긴다 — 그래서 그 순서도 데이터의 일부다.
    """
    used: dict[str, int] = {a["key"]: 0 for a in ARCHETYPES}
    out: dict[int, dict] = {}
    for c in sorted(customers, key=lambda x: x["id"]):
        cands = _eligible(c)
        arche = min(cands, key=lambda a: (used[a["key"]], ARCHETYPES.index(a)))
        used[arche["key"]] += 1
        out[c["id"]] = _build(c, arche)
    return out


def _build(c: dict, arche: dict) -> dict:
    risk = c["risk"]
    built = arche["build"](c)
    effective = max(0, min(len(RISK_LABELS) - 1, risk + arche["risk_shift"]))
    return {
        "key": arche["key"],
        # 한 줄 요약 — 카드가 접혀 있을 때 보이는 것. **규칙이 조립한다**(LLM 아님).
        "summary": f"{arche['label']} — {built['goal']}",
        "goal": built["goal"],
        "horizon": built["horizon"],
        "assets": built["assets"],
        "constraints": built["constraints"],
        "plan": built["plan"],
        # 등록 성향과 **같은 축**(RISK_LABELS 인덱스)이라야 화면이 둘을 견줄 수 있다.
        "registered_risk": risk,
        "effective_risk": effective,
        # 같으면 굳이 이유를 적지 않는다 — 화면이 "다르다"고 말할 때만 근거가 필요하다.
        "effective_risk_why": built["why"] if effective != risk else None,
    }


# ── 상담 히스토리 ───────────────────────────────────────────────────────────
#
# **왜 필요한가.** `Next Best Action` 채팅이 답할 둘 중 하나가 "히스토리를 기반으로 투자성향을
# 분석"이다. 그런데 `pb_sessions`에는 50명 중 **3명분**밖에 없었다 — 그걸로는 47명에게
# 기능이 죽는다. 그래서 상담 이력을 목업으로 함께 만든다.
#
# ⚠️ `pb_sessions`(고객 문의 큐)와 **다른 것**이다. 그쪽은 아직 답하지 않은 문의이고,
#    이쪽은 지나간 접점의 기록이다. 섞지 말 것 — 큐는 처리 대상이고 히스토리는 읽을거리다.
# ⚠️ 여기서도 **금액은 안 적는다.** 성향 판단에 필요한 건 "무엇을 했나"이지 얼마인지가 아니다.
# ⚠️ **판단을 적지 않는다.** `안정형으로 보임` 같은 결론은 히스토리가 아니라 분석 결과다 —
#    그건 채팅이 할 일이고, 여기에 미리 적으면 모델이 그걸 베껴 쓰고 근거는 사라진다.

# 기준 시점. **오늘 날짜를 읽지 않는다** — 읽으면 돌릴 때마다 결과가 달라져서 "난수 없음"이
# 깨진다(`bizdate`를 안 쓰는 이유이기도 하다). 데이터 세계의 현재가 2026-08이라 거기 맞춘다.
ANCHOR = (2026, 8)


def _ago(months: int) -> str:
    """기준 시점에서 N개월 전 → `YYYY-MM`."""
    total = ANCHOR[0] * 12 + (ANCHOR[1] - 1) - months
    return f"{total // 12:04d}-{total % 12 + 1:02d}"


# 원형별 상담 이력 뼈대 — `(몇 개월 전, 종류, 내용)`. 종류는 화면이 묶어 볼 수 있게 고정어다.
# 마지막 항목이 가장 최근이 되도록 개월 수를 내림차순으로 적는다.
HISTORY_BY_KEY = {
    "multi_home": [(30, "성향 등록", "설문 결과에 따라 등록"),
                   (18, "상담", "국내주식 비중 확대 요청"),
                   (7, "상담", "보유 부동산 정리 계획 공유"),
                   (2, "문의", "정리 일정에 맞춘 현금 확보 방법 문의")],
    "retire_income": [(36, "성향 등록", "설문 결과에 따라 등록"),
                      (20, "상담", "퇴직 시점과 생활비 규모 논의"),
                      (6, "상담", "배당·이자 중심으로 전환 희망"),
                      (1, "문의", "월 인출액을 얼마로 잡아야 하는지 문의")],
    "tuition": [(34, "성향 등록", "설문 결과에 따라 등록"),
                (16, "상담", "자녀 진학 일정 공유"),
                (5, "상담", "학기별 지출 시점 정리"),
                (2, "문의", "환율 변동이 학비에 미치는 영향 문의")],
    "business_sale": [(28, "성향 등록", "설문 결과에 따라 등록"),
                      (12, "상담", "사업체 매각 검토 사실 공유"),
                      (4, "상담", "매각 대금 운용 구조 사전 논의")],
    "inheritance": [(40, "성향 등록", "설문 결과에 따라 등록"),
                    (15, "상담", "가족 간 자산 이전 계획 공유"),
                    (6, "상담", "증여세 납부 재원 확인"),
                    (1, "문의", "이전 순서를 어떻게 잡아야 하는지 문의")],
    "jeonse_to_buy": [(24, "성향 등록", "설문 결과에 따라 등록"),
                      (10, "상담", "전세 만기 시점 공유"),
                      (3, "상담", "매입 희망 지역·자기자금 규모 논의")],
    "severance": [(38, "성향 등록", "설문 결과에 따라 등록"),
                  (14, "상담", "퇴직 예정 시점 공유"),
                  (3, "상담", "일시금과 연금 수령 방식 비교 요청")],
    "startup": [(26, "성향 등록", "설문 결과에 따라 등록"),
                (9, "상담", "창업 준비 사실 공유"),
                (2, "문의", "개업 전까지 자금을 어디에 둘지 문의")],
    "relocate": [(32, "성향 등록", "설문 결과에 따라 등록"),
                 (13, "상담", "해외 이주 검토 사실 공유"),
                 (4, "상담", "외화 준비 시점 논의")],
    "care_cost": [(35, "성향 등록", "설문 결과에 따라 등록"),
                  (11, "상담", "가족 건강 문제로 지출 가능성 공유"),
                  (2, "문의", "필요할 때 바로 찾을 수 있는지 문의")],
    "first_home": [(22, "성향 등록", "설문 결과에 따라 등록"),
                   (8, "상담", "결혼·주거 계획 공유"),
                   (3, "상담", "청약·대출 조건 확인")],
    "rental_shift": [(33, "성향 등록", "설문 결과에 따라 등록"),
                     (17, "상담", "보유 부동산 임대 전환 검토"),
                     (5, "상담", "임대 수입으로 생활비 충당 계획 공유")],
}


def history_for(c: dict, scenario: dict) -> list[dict]:
    """상담 이력. 첫 줄의 성향 등록에는 **그때 등록한 라벨**을 적는다 — 지금 등록값과 같지만,
    "언제 무엇으로 등록했는가"가 히스토리에서 성향을 읽는 출발점이다."""
    rows = []
    for months, kind, detail in HISTORY_BY_KEY[scenario["key"]]:
        if kind == "성향 등록":
            detail = f"{RISK_LABELS[c['risk']]}으로 등록 — {detail}"
        rows.append({"at": _ago(months), "kind": kind, "detail": detail})
    return rows


def _sql(cid: int, scenario: dict, history: list[dict]) -> str:
    s = json.dumps(scenario, ensure_ascii=False).replace("'", "''")
    h = json.dumps(history, ensure_ascii=False).replace("'", "''")
    return (
        f"UPDATE pb_customers SET scenario = '{s}'::jsonb, history = '{h}'::jsonb "
        f"WHERE id = {cid};"
    )


async def main() -> None:
    dotenv.load_dotenv()
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    rows = await conn.fetch(
        "SELECT id, age, risk_profile, balance FROM pb_customers ORDER BY id"
    )
    await conn.close()

    customers = [
        {"id": r["id"], "age": r["age"], "risk": r["risk_profile"], "balance": r["balance"]}
        for r in rows
    ]
    print("-- 고객 상황(시나리오)·상담 히스토리 — backend/scripts/seed_scenarios.py (난수 없음)")
    print("-- 다시 돌리면 같은 결과가 나온다.")
    print("-- 되돌리기: UPDATE pb_customers SET scenario = '{}', history = '[]';")
    assigned = assign(customers)
    by_id = {c["id"]: c for c in customers}
    for cid, scenario in sorted(assigned.items()):
        print(_sql(cid, scenario, history_for(by_id[cid], scenario)))


if __name__ == "__main__":
    asyncio.run(main())
