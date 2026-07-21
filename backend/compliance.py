"""F3 노트 초안 발행 전 컴플라이언스 게이트 — 판정 로직은 여기서 직접 작성한다
(SDK 훅은 배선 지점일 뿐, 규칙 자체는 프로젝트 코드).

CLAUDE.md 컴플라이언스 게이트 4항목 중 F3 관련:
- 필수 고지문구("AI 초안·미검증" 워터마크) 삽입 여부
- 출처가 누락된 문장이 없는가 (있으면 어떤 문장인지 알려줘야 함 — 발행 하드 블록)
- MNPI/PII 패턴 없는가
- 투자권유·광고성 표현 없는가
- 시세 수치를 실었다면 지연시세임을 밝혔는가
"""

import re

WATERMARK = "⚠ AI 초안 · 미검증 — 사람의 검토·심의·승인 없이는 발행되지 않습니다."

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
# ponytail: 단어 포함 여부만 보는 휴리스틱이라, 시세 수치가 없는데 뉴스 요지에 "주가"가
# 스쳐도 고지를 요구한다(과검출). 게이트에서 과검출은 발행이 막히고 사람이 사유를 보는
# 방향이라 안전한 쪽 오류다 — 실제로 거슬리면 수치 패턴(원·%)까지 같이 보도록 좁힐 것.
QUOTE_TERMS = ["시세", "주가", "종가", "현재가", "등락률"]

# ponytail: 진짜 MNPI/PII 탐지는 NER·분류 모델급 작업이다. F3는 DART 공시·공개 뉴스만
# 입력으로 쓰는 파이프라인이라(자유 텍스트 챗이 아님) 리스크가 F1보다 낮은 편이라
# 명백한 키워드 휴리스틱으로 시작한다 — F1(대화형 챗) 붙일 때 반드시 강화할 것.
MNPI_PATTERNS = [
    r"미공개\s*정보",
    r"내부자\s*정보",
    r"공시\s*전(?:에|\s)",
    r"비공식\s*확인",
]


def check_note(content_md: str, sentences: list[dict]) -> list[str]:
    """위반 사유 목록을 반환한다. 빈 리스트면 게이트 통과."""
    violations: list[str] = []

    if WATERMARK not in content_md:
        violations.append("필수 고지문구(AI 초안·미검증 워터마크) 누락")

    for phrase in FORBIDDEN_PHRASES:
        if phrase in content_md:
            violations.append(f"투자권유·광고성 표현 감지: '{phrase}'")

    for pattern in MNPI_PATTERNS:
        if re.search(pattern, content_md):
            violations.append(f"MNPI 의심 패턴 감지 (정규식: {pattern})")

    # "지연시세" 자체가 QUOTE_TERMS의 "시세"를 포함하므로, 고지가 있으면 자연히 통과한다.
    quoted = [t for t in QUOTE_TERMS if t in content_md]
    if quoted and "지연시세" not in content_md:
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


def apply_watermark(content_md: str) -> str:
    """워터마크는 LLM 출력에 의존하지 않고 백엔드가 저장 시점에 강제로 붙인다."""
    if WATERMARK in content_md:
        return content_md
    return f"{WATERMARK}\n\n{content_md}"
