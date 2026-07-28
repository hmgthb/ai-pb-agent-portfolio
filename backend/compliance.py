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

from backend import citations

WATERMARK ="⚠ AI 초안 · 미검증 — 사람의 검토·심의·승인 없이는 발행되지 않습니다."
BRIEF_NOTICE = "ℹ 내부 참고용 — 투자권유·광고가 아닙니다."
# F1 대화형 Q&A: CLAUDE.md 표 = "지연시세 명시, 투자권유 아님". 문구에 **"지연시세"를
# 그대로 넣어** 자기충족적으로 만든다 — F1 답변에 시세가 실리든 안 실리든 이 고지가 늘
# 붙으므로 QUOTE 게이트가 항상 만족된다(WATERMARK가 "미검증"을 품는 것과 같은 방식).
#
# 뒷문장(보유·배분)은 F1이 포트폴리오 질문까지 받으면서 붙었다. 그 답변의 근거는 DART·뉴스·
# KRX가 아니라 **내부 계좌 보유데이터**라, 가드레일 1("공개데이터 온리")의 명시적 예외다 —
# 예외를 쓰면서 화면에 말하지 않으면 읽는 사람이 공시와 같은 급으로 오해한다.
# ⚠️ 이 문구는 종목만 묻는 답변에도 늘 붙는다(고지는 조건부로 켜지 않는다 — 조건이 생기는
#    순간 "안 붙은 경우"가 버그로 숨는다). 문장별 근거는 각 문장의 출처 배지가 말한다.
CHAT_NOTICE = (
    "ℹ 시세·주가는 지연시세(일별 종가) 기준이며, 본 답변은 투자권유가 아닙니다. "
    "보유·배분 수치는 내부 계좌데이터로 공개데이터가 아니며, 스냅샷 시점이 다를 수 있습니다."
)

# CLAUDE.md "기능별 필수 고지문구" 표를 코드로 옮긴 것. 사용자가 끌 수 없고, LLM 출력에
# 의존하지 않도록 백엔드가 저장 시점에 강제로 붙인다(apply_notice).
# ponytail: 검증 가능한 기능만 넣는다 — F4·F5는 명시적 제외라 그때 가서 한 줄씩 추가한다.
NOTICES = {
    "F1": CHAT_NOTICE,  # 대화형 종목 Q&A
    "F2": BRIEF_NOTICE,  # 상담 전 브리핑
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
# 써서 대개 걸리지 않고, KRX 시세가 들어가는 F2 상담 전 브리핑에서 자동으로 켜진다.
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

# --- F1 입력 가드 -----------------------------------------------------------
# F1은 자유 텍스트 챗이라 F3·F2에 없던 입력 공격면이 생긴다(CLAUDE.md 가드레일 2·5).
# 여기서 막는 건 세 갈래다:
#   ① MNPI 유입 — 사용자가 미공개정보를 흘려 답변 근거로 삼게 하는 것(MNPI_PATTERNS 재사용)
#   ② 프롬프트 인젝션 — 공시·뉴스가 아니라 사용자 입력이 직접 지시문으로 오는 경우.
#      신뢰하지 않는 데이터로 취급하되, 명백한 지시 탈취 시도는 아예 처리 중단한다.
#   ③ PII — 주민번호·계좌번호 등. 답변에 필요 없고 로그에 남으면 안 된다.
# ponytail: NER급 정밀 탐지가 아니라 보수적 키워드/정규식이다. 놓치는 것보다 과검출이
# 안전한 방향이라 의심되면 막고 사람에게 다시 묻게 한다(F1은 발행이 아니라 대화라 비용이 낮다).
INJECTION_PATTERNS = [
    r"이전\s*(?:지시|명령|규칙)(?:을|는)?\s*(?:무시|잊)",
    r"(?:지시|규칙|가드레일|시스템\s*프롬프트)(?:을|를|은|는)?\s*(?:무시|잊|해제|무력화)",
    r"ignore\s+(?:all\s+)?(?:previous|prior|above)",
    r"system\s*prompt",
    r"너는\s*이제",
    r"역할을\s*(?:잊|바꿔)",
]
PII_PATTERNS = [
    r"\b\d{6}\s*[-–]\s*[1-4]\d{6}\b",  # 주민등록번호
    r"\b\d{2,3}\s*[-–]\s*\d{3,4}\s*[-–]\s*\d{4,6}\b",  # 계좌/카드 번호 형태
]


def input_guard(text: str) -> list[str]:
    """F1 사용자 입력(신뢰하지 않는 자유 텍스트)의 위반 사유 목록. 빈 리스트면 통과.

    산출물 게이트(check_note)와 분리한 이유: 이건 **입력을 받자마자, 에이전트를 돌리기
    전에** 도는 문지기다. 여기서 막히면 어떤 도구도 호출되지 않는다."""
    violations: list[str] = []
    for pattern in MNPI_PATTERNS:
        if re.search(pattern, text):
            violations.append(f"MNPI 의심 패턴 감지 (정규식: {pattern})")
    for pattern in INJECTION_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            violations.append(f"프롬프트 인젝션 의심 — 지시 탈취 시도 (정규식: {pattern})")
    for pattern in PII_PATTERNS:
        if re.search(pattern, text):
            violations.append("PII(주민·계좌번호 등) 의심 — 개인정보는 입력하지 마세요")
    return violations


def check_note(
    content_md: str,
    sentences: list[dict],
    feature: str = "F3",
    acked_indices: set[int] | None = None,
) -> list[str]:
    """위반 사유 목록을 반환한다. 빈 리스트면 게이트 통과.

    feature: 기능 코드(NOTICES의 키). 기능마다 요구되는 고지문구가 다르므로 필수다 —
    기본값 F3는 기존 노트 경로가 그대로 동작하도록 둔 것이다.

    acked_indices: 준법이 **사유를 적어 확인한** 문장의 인덱스(F3 심의 단계).
    각주를 붙일 수 없는 문장(해석·전망, 고지·면책, 데이터 설명)이 실제로 있기 때문에,
    게이트가 그걸 전부 잠그면 사람이 열 방법이 없어진다 — 그래서 '누가 왜 확인했는가'가
    기록된 문장만 미인용 집계에서 뺀다(판단은 사람, 근거는 감사로그).

    ⚠️ **면제되는 건 미인용 규칙 하나뿐이다.** 투자권유·광고성 표현, MNPI 패턴,
    지연시세 고지 누락은 확인으로 풀 수 없다 — 그건 문장을 고쳐야 하는 위반이다.
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

    # 소제목뿐 아니라 고지문구·구분선도 뺀다 — 우리가 강제로 붙인 워터마크가
    # "출처 없는 문장"으로 세어져 스스로 발행을 막던 문제가 있었다(citations 참고).
    #
    # F1(대화형)은 발행 단계가 없어 사람이 해석 문장을 검토하지 않는다. 그래서 근거 없는
    # **사실 주장**(=날조 위험)만 잡고, 규칙상 각주가 없는 해석 문장은 위반으로 세지 않는다.
    # F3 노트는 발행 전 사람 검토가 있어 해석 문장까지 게이트에 올려 판단하게 둔다(§1-1 설계).
    if feature == "F1":
        # F1은 발행 단계가 없어 확인해 줄 사람도 없다 — acked_indices를 받지 않는다.
        unsourced = [s for s in sentences if citations.is_claim(s) and s["source"] is None]
    else:
        acked = acked_indices or set()
        unsourced = [
            s
            for i, s in enumerate(sentences)
            if citations.is_body(s) and s["source"] is None and i not in acked
        ]
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
