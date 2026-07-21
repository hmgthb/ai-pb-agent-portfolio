"""산출물 발행 전 컴플라이언스 게이트 — 판정 로직은 여기서 직접 작성한다
(SDK 훅은 배선 지점일 뿐, 규칙 자체는 프로젝트 코드).

CLAUDE.md 컴플라이언스 게이트 항목:
- 기능별 필수 고지문구가 삽입되어 있는가 (F2 브리프와 F3 노트는 문구가 다르다 — NOTICES)
- 출처가 누락된 문장이 없는가 (있으면 어떤 문장인지 알려줘야 함 — 발행 하드 블록)
- MNPI/PII 패턴 없는가
- 투자권유·광고성 표현 없는가
- 시세 수치를 실었다면 지연시세임을 밝혔는가
"""

import re

WATERMARK = "⚠ AI 초안 · 미검증 — 사람의 검토·심의·승인 없이는 발행되지 않습니다."
BRIEF_NOTICE = "ℹ 내부 참고용 — 투자권유·광고가 아닙니다."

# CLAUDE.md "기능별 필수 고지문구" 표를 코드로 옮긴 것. 사용자가 끌 수 없고, LLM 출력에
# 의존하지 않도록 백엔드가 저장 시점에 강제로 붙인다(apply_notice).
# ponytail: 이번 스코프에 있는 기능만 넣는다 — F1은 W6 조건부, F4·F5는 명시적 제외라
# 그때 가서 한 줄씩 추가한다. 지금 넣어두면 검증 못 하는 문구만 늘어난다.
NOTICES = {
    "F2": BRIEF_NOTICE,  # 모닝 브리프
    "F3": WATERMARK,  # 실적·공시 노트 초안
}

FORBIDDEN_PHRASES = [
    "매수 추천",
    "매도 추천",
    "강력 매수",
    "적극 매수",
    "목표주가",
    "투자의견 매수",
    "지금 사세요",
    "무조건 오릅니다",
    "수익을 보장",
]

# 시세를 실으면 지연시세임을 반드시 밝혀야 한다(CLAUDE.md 기능별 고지). 기능별 플래그를
# 받지 않고 "본문에 시세가 있으면 발동"하는 조건부 규칙으로 둔다 — F3 노트는 공시·뉴스만
# 써서 대개 걸리지 않고, KRX 시세가 들어가는 F2 모닝 브리프에서 자동으로 켜진다.
#
# 단어만 보면 과검출한다: F2 빈 결과 안내문("...시세 모두 조회된 항목이 없습니다")처럼
# 시세 수치가 하나도 없는 줄까지 고지를 요구했다(실제로 발생). 그래서 **시세 단어 + 실제
# 수치(가격 또는 등락률)** 가 함께 있을 때만 발동하도록 좁혔다.
# ponytail: 그래도 "주가 7만원 돌파" 같은 뉴스 제목은 잡는다 — 그건 실제로 시세를 인용한
# 것이라 고지 대상이 맞다고 본다. 더 정밀하게 가려면 문장 단위 출처 종류(krx인지)로
# 판단해야 하는데, 그건 게이트가 아니라 조립 단계의 일이다.
QUOTE_TERMS = ["시세", "주가", "종가", "현재가", "등락률"]
# "244,000원"뿐 아니라 "7만원"·"1.7조원"처럼 단위를 끼워 쓰는 표기도 가격으로 본다.
_PRICE_RE = re.compile(r"\d[\d,]*(?:\.\d+)?\s*[천만억조]?\s*원")
_PERCENT_RE = re.compile(r"-?\d+(?:\.\d+)?\s*%")

# ponytail: 진짜 MNPI/PII 탐지는 NER·분류 모델급 작업이다. F3는 DART 공시·공개 뉴스만
# 입력으로 쓰는 파이프라인이라(자유 텍스트 챗이 아님) 리스크가 F1보다 낮은 편이라
# 명백한 키워드 휴리스틱으로 시작한다 — F1(대화형 챗) 붙일 때 반드시 강화할 것.
MNPI_PATTERNS = [
    r"미공개\s*정보",
    r"내부자\s*정보",
    r"공시\s*전(?:에|\s)",
    r"비공식\s*확인",
]


def check_note(content_md: str, sentences: list[dict], feature: str = "F3") -> list[str]:
    """위반 사유 목록을 반환한다. 빈 리스트면 게이트 통과.

    feature: 기능 코드(NOTICES의 키). 기능마다 요구되는 고지문구가 다르므로 필수다 —
    기본값 F3는 기존 노트 경로가 그대로 동작하도록 둔 것이다.
    """
    violations: list[str] = []

    notice = required_notice(feature)
    if notice not in content_md:
        violations.append(f"{feature} 필수 고지문구 누락: \"{notice}\"")

    for phrase in FORBIDDEN_PHRASES:
        if phrase in content_md:
            violations.append(f"투자권유·광고성 표현 감지: '{phrase}'")

    for pattern in MNPI_PATTERNS:
        if re.search(pattern, content_md):
            violations.append(f"MNPI 의심 패턴 감지 (정규식: {pattern})")

    # "지연시세" 자체가 QUOTE_TERMS의 "시세"를 포함하므로, 고지가 있으면 자연히 통과한다.
    quoted = [t for t in QUOTE_TERMS if t in content_md]
    has_figure = _PRICE_RE.search(content_md) or _PERCENT_RE.search(content_md)
    if quoted and has_figure and "지연시세" not in content_md:
        violations.append(
            f"시세 정보 포함('{quoted[0]}') — 지연시세 고지 누락 (실시간이 아님을 명시해야 함)"
        )

    unsourced = [s for s in sentences if not s["is_heading"] and s["source"] is None]
    if unsourced:
        preview = unsourced[0]["text"][:40]
        violations.append(
            f"출처 없는 문장 {len(unsourced)}개 — 예: \"{preview}...\" (전부 출처를 붙이거나 재작성 필요)"
        )

    return violations


def required_notice(feature: str) -> str:
    """기능별 필수 고지문구. 모르는 기능 코드는 조용히 통과시키지 않고 터뜨린다 —
    고지 없이 발행되는 것보다 배선 실수로 죽는 편이 안전하다."""
    try:
        return NOTICES[feature]
    except KeyError:
        raise ValueError(
            f"'{feature}'의 필수 고지문구가 정의돼 있지 않습니다 — compliance.NOTICES에 추가하세요."
        ) from None


def apply_notice(content_md: str, feature: str = "F3") -> str:
    """고지문구는 LLM 출력에 의존하지 않고 백엔드가 저장 시점에 강제로 붙인다."""
    notice = required_notice(feature)
    if notice in content_md:
        return content_md
    return f"{notice}\n\n{content_md}"
