"""F3 노트 초안 발행 전 컴플라이언스 게이트 — 판정 로직은 여기서 직접 작성한다
(SDK 훅은 배선 지점일 뿐, 규칙 자체는 프로젝트 코드).

CLAUDE.md 컴플라이언스 게이트 4항목 중 F3 관련:
- 필수 고지문구("AI 초안·미검증" 워터마크) 삽입 여부
- 출처가 누락된 문장이 없는가 (있으면 어떤 문장인지 알려줘야 함 — 발행 하드 블록)
- MNPI/PII 패턴 없는가
- 투자권유·광고성 표현 없는가
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
