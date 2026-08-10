"""산출물 발행 전 컴플라이언스 게이트 — 판정 로직은 여기서 직접 작성한다
(SDK 훅은 배선 지점일 뿐, 규칙 자체는 프로젝트 코드).

CLAUDE.md 컴플라이언스 게이트 항목:
- 기능별 필수 고지문구가 삽입되어 있는가 (F2 브리프와 F3 노트는 문구가 다르다 — NOTICES)
- 출처가 누락된 문장이 없는가 (있으면 어떤 문장인지 알려줘야 함 — 발행 하드 블록)
- MNPI/PII 패턴 없는가
- 없는 확실성을 만드는 단정 표현 없는가 (투자권유 차단은 2026-08-10에 걷어냈다)
- 시세 수치를 실었다면 지연시세임을 밝혔는가
"""

import json
import re

from backend import citations

WATERMARK ="⚠ AI 초안 · 미검증 — 사람의 검토·심의·승인 없이는 발행되지 않습니다."
# F2 상담 전 브리핑. 뒷문장은 2026-08-10에 붙었다 — 브리핑이 거시 전용을 벗어나 **담당
# 고객의 보유 종목과 상황을 근거로 볼 종목을 고르고, 그 맥락이 요약 문장에까지 실리면서**
# 근거가 더는 공개데이터만이 아니게 됐다. F1이 같은 이유로 고지를 늘린 것과 같은 판단이다
# (예외를 쓰면서 화면에 말하지 않으면 읽는 사람이 공시와 같은 급으로 오해한다).
# ⚠️ 이 문구는 **고객 관련 줄이 없는 브리프에도 늘 붙는다.** 고지를 조건부로 켜지 않는
#    이유는 CHAT_NOTICE와 같다 — 조건이 생기는 순간 "안 붙은 경우"가 버그로 숨는다.
# ⚠️ "투자권유·광고가 아닙니다"를 뺐다(2026-08-10 · `FORBIDDEN_PHRASES` 주석의 같은 결정).
#    남은 문장은 **근거의 출처**를 밝히는 것이지 권유 여부를 말하는 것이 아니다.
BRIEF_NOTICE = "ℹ 내부 참고용 — 보유 종목·고객 상황은 내부 계좌데이터로 공개데이터가 아닙니다."
# F1 대화형 Q&A: CLAUDE.md 표 = "지연시세 명시, 내부 계좌데이터 명시". 문구에 **"지연시세"를
# 그대로 넣어** 자기충족적으로 만든다 — F1 답변에 시세가 실리든 안 실리든 이 고지가 늘
# 붙으므로 QUOTE 게이트가 항상 만족된다(WATERMARK가 "미검증"을 품는 것과 같은 방식).
#
# 뒷문장(보유·배분)은 F1이 포트폴리오 질문까지 받으면서 붙었다. 그 답변의 근거는 DART·뉴스·
# KRX가 아니라 **내부 계좌 보유데이터**라, 가드레일 1("공개데이터 온리")의 명시적 예외다 —
# 예외를 쓰면서 화면에 말하지 않으면 읽는 사람이 공시와 같은 급으로 오해한다.
# ⚠️ 이 문구는 종목만 묻는 답변에도 늘 붙는다(고지는 조건부로 켜지 않는다 — 조건이 생기는
#    순간 "안 붙은 경우"가 버그로 숨는다). 문장별 근거는 각 문장의 출처 배지가 말한다.
# ⚠️ **"본 답변은"을 뺐다**(2026-08-06). 이 고지는 채팅 답변에만 붙던 것이 아니라 **상담 준비
#    메모 PDF**에도 실리는데, 문서를 "답변"이라 부르면 그 자리에서 말이 어긋난다.
# ⚠️ **F1 고지문구를 통째로 걷어냈다**(2026-08-10). 화면에서 답변마다 뜨던
#    "ℹ 시세·주가는 지연시세 기준입니다. 보유·배분 수치는 내부 계좌데이터로…"가 이 값이었다.
#
# **딸려 나간 것이 있다.** 이 문구의 `지연시세`가 QUOTE 규칙을 자기충족적으로 만족시키는
# 장치였다 — 문구가 없으면 시세를 인용한 F1 답변은 **만족시킬 방법이 없는 규칙**에 걸려
# 매번 위반으로 뜬다. 그래서 F1을 그 규칙에서 뺐다(`QUOTE_EXEMPT_FEATURES`). 규칙을
# 엄격하게 두는 것과 **만족 불가능하게 두는 것**은 다르다.
#
# ⚠️ 이 문구는 **상담 준비 메모 PDF에도 실렸다**(`main.export_prep_note_pdf`). 화면에서만
#    빼는 게 아니라 그 문서에서도 빠진다 — 문서에만 남기려면 기능 코드를 갈라야 한다.
# ⚠️ 빈 문자열이라 `check_note`의 고지 검사는 자동으로 통과한다(`"" in content`는 늘 참).
#    되살리려면 문구를 다시 넣고 `QUOTE_EXEMPT_FEATURES`에서 F1을 빼면 된다.
CHAT_NOTICE = ""

# CLAUDE.md "기능별 필수 고지문구" 표를 코드로 옮긴 것. 사용자가 끌 수 없고, LLM 출력에
# 의존하지 않도록 백엔드가 저장 시점에 강제로 붙인다(apply_notice).
# ponytail: 검증 가능한 기능만 넣는다 — F4·F5는 명시적 제외라 그때 가서 한 줄씩 추가한다.
NOTICES = {
    "F1": CHAT_NOTICE,  # 대화형 종목 Q&A
    "F2": BRIEF_NOTICE,  # 상담 전 브리핑
    "F3": WATERMARK,  # 실적·공시 노트 초안
}

# ⚠️ **투자권유 표현 차단을 걷어냈다**(2026-08-10). 이 도구는 PB가 보는 화면이고, 어떤
#    종목을 고객에게 권할지 AI가 말해도 된다는 것이 제품 결정이다. 그래서 아래 일곱을 뺐다:
#      "매수 추천" · "매도 추천" · "강력 매수" · "적극 매수" · "목표주가" ·
#      "투자의견 매수" · "지금 사세요"
#
# **남긴 둘은 권유가 아니라 단정이다.** "무조건 오릅니다"·"수익을 보장"은 어느 종목을
# 권하느냐와 무관하게 **없는 확실성을 만드는 문장**이고, 그건 추천을 허용한 것과 다른
# 문제다(가드레일 3 "지어내지 않는다"와 같은 계열). 이 둘까지 빼려면 목록을 비우면 된다.
#
# ⚠️ 목록을 비워도 **구조는 살아 있다** — `forbidden_carriers`·`forbidden_hits`·발행 예외
#    (waiver) 경로는 그대로다. 되살릴 때 문구만 다시 넣으면 된다.
FORBIDDEN_PHRASES = [
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
# 고지문구를 걷어낸 기능 — 지연시세 규칙을 걸 수 없다(위 `CHAT_NOTICE` 주석).
QUOTE_EXEMPT_FEATURES = frozenset({"F1"})
# "244,000원"뿐 아니라 "7만원"·"1.7조원"처럼 단위를 끼워 쓰는 표기도 가격으로 본다.
_PRICE_RE = re.compile(r"\d[\d,]*(?:\.\d+)?\s*[천만억조]?\s*원")
_PERCENT_RE = re.compile(r"-?\d+(?:\.\d+)?\s*%")


def quotes_market_data(sentence: dict) -> bool:
    """이 **문장**이 시세를 인용했는가(순수).

    판정 근거 둘:
      ① 출처가 시세 그 자체(`[^krx]`) — 수치 표기를 어떻게 하든 시세 인용이다.
      ② 시세 낱말과 수치가 **같은 문장** 안에 있다 — 뉴스에서 옮긴 "주가 7만원 돌파"처럼
         출처가 krx가 아니어도 값을 실었으면 고지 대상이다(옛 주석이 남긴 판단 그대로).
    """
    text = sentence.get("text") or ""
    sources = sentence.get("sources") or (
        [sentence["source"]] if sentence.get("source") else []
    )
    if any((s or {}).get("type") == "krx" for s in sources):
        return True
    # ⚠️ `목표주가`를 여기서 가리던 줄을 걷어냈다(2026-08-10). 가린 근거가 "그 문장은
    #    FORBIDDEN_PHRASES가 이미 본다"였는데, 투자권유 차단을 걷어내면서 그 규칙이 더는
    #    보지 않는다 — 가린 채로 두면 "목표주가 49만원"이 **어느 규칙에도 안 걸린다.**
    #    지금은 시세 낱말 + 수치로 잡혀 지연시세 고지를 요구한다. 전망치라도 값을 실었으면
    #    무엇을 기준으로 한 값인지는 밝혀야 한다는 쪽이다.
    if not any(t in text for t in QUOTE_TERMS):
        return False
    return bool(_PRICE_RE.search(text) or _PERCENT_RE.search(text))


def forbidden_carriers(sentences: list[dict], removed: set[int] | None = None) -> list[dict]:
    """금지 표현을 담고 있는 **문장 목록** — `[{"index": i, "phrase": "목표주가"}, ...]`.

    화면이 "어느 문장이 발행을 막고 있나"를 스스로 찾지 않게 하려고 백엔드가 준다.
    ⚠️ 금지 표현 목록을 프론트로 복사하지 말 것 — 컴플라이언스 어휘가 두 곳으로 갈린다
       (미인용 확인 유효성을 `live_acks` 한 곳에서만 판정하는 것과 같은 규칙, §1-2).
    """
    out: list[dict] = []
    for i, s in enumerate(sentences or []):
        if removed and i in removed:
            continue
        text = s.get("text") or ""
        for phrase in FORBIDDEN_PHRASES:
            if phrase in text:
                out.append({"index": i, "phrase": phrase})
    return out


def forbidden_hits(
    content_md: str,
    sentences: list[dict],
    waived: set[int] | None = None,
    removed: set[int] | None = None,
) -> list[str]:
    """본문에 남아 있는 금지 표현. 예외(waiver)가 걸린 문장의 것은 빼고 센다.

    ⚠️ **예외는 문장 단위다.** 같은 표현이 다른 문장에도 있으면 그건 그대로 위반이다 —
       한 문장을 통과시킨 판단이 본문 전체에 번지면 예외가 아니라 규칙 해제가 된다.
    ⚠️ **문장 목록에서 못 찾은 표현은 그대로 위반이다.** 본문에는 있는데 문장 배열에 없다는
       건 소제목·고지문구처럼 파서가 다르게 담았다는 뜻이라, 면제할 근거가 없다(막는 쪽).
    """
    waived = waived or set()
    hits: list[str] = []
    for phrase in FORBIDDEN_PHRASES:
        if phrase not in content_md:
            continue
        carriers = [
            c["index"] for c in forbidden_carriers(sentences, removed) if c["phrase"] == phrase
        ]
        if not carriers or any(i not in waived for i in carriers):
            hits.append(phrase)
    return hits


def _quoted_term(
    content_md: str, sentences: list[dict], removed: set[int] | None = None
) -> str | None:
    """지연시세 고지가 필요하면 그 근거가 된 낱말을, 아니면 None.

    ⚠️ **문서 단위 공존으로 판정하지 않는다**(2026-08-06 수정). 예전에는 「시세 낱말이
       어딘가 있다」 + 「가격·퍼센트가 어딘가 있다」였는데, 그러면 시세를 한 줄도 인용하지
       않은 노트가 **자기 실적 수치 때문에** 막힌다 — 실측: 노트 #33의 "주가가 최근 큰 폭
       하락했으나…"(수치 없음)가 다른 문단의 "매출액 300조8,709억원"과 만나 걸렸다.
       규칙의 뜻은 "시세를 실었으면 지연시세임을 밝혀라"이므로 **문장 단위**로 본다.
    ⚠️ 뺀 문장(`제거`)은 최종본에 없으므로 세지 않는다 — 다만 **인덱스로 받는다.**
       본문에 그 문장 원문이 남아 있는지로 추론하면, 본문과 문장 목록이 어긋나는 순간
       규칙이 **조용히 꺼진다**(그 방향으로 틀리면 안 된다, §1-1). 확인(ack)과 달리
       제거만 뺀다 — 확인은 미인용 규칙 하나만 푼다.
    ⚠️ 문장 목록이 비면 **문서 단위로 되돌아간다.** 파싱이 실패했을 때 규칙이 조용히
       꺼지는 것보다 과검출이 낫다.
    """
    for i, s in enumerate(sentences or []):
        if removed and i in removed:
            continue
        if quotes_market_data(s):
            text = s.get("text") or ""
            return next((t for t in QUOTE_TERMS if t in text), "시세")
    if sentences:
        return None
    if any(t in content_md for t in QUOTE_TERMS) and (
        _PRICE_RE.search(content_md) or _PERCENT_RE.search(content_md)
    ):
        return next(t for t in QUOTE_TERMS if t in content_md)
    return None

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


# --- 반출 가드(egress) ------------------------------------------------------
# `input_guard`가 **들어오는** 자유 텍스트의 문지기라면, 이쪽은 **나가는** 프롬프트의
# 문지기다. 비식별화(`redact.py`)가 제 일을 했는지 그 뒤에서 한 번 더 확인한다 —
# 변환기가 규칙이든 모델이든, 새 기능이 원본을 얹었든, 경계를 지나는 건 여기서 걸린다.
#
# ⚠️ **큰 정수 규칙은 payload에만 건다. 프롬프트 전체에 걸면 안 된다.**
#    프롬프트에는 KRX 종가·DART 재무수치가 **공개데이터로서** 정상적으로 들어 있다
#    (`10737700000000원` 같은 값). 전체에 걸면 종목 질문 답변이 통째로 막힌다.
#    가려야 하는 건 고객 계좌 금액이고, 그건 payload 안에만 있다.
_BIG_INT_RE = re.compile(r"\d{7,}")  # 100만 이상. 종목코드(6자리)는 안 걸린다.


def egress_guard(
    prompt: str,
    payload: dict | None,
    customer_names: list[str] | tuple[str, ...] = (),
    *,
    watch: list[dict] | None = None,
) -> list[str]:
    """외부 모델로 나가기 직전 검사. 빈 리스트면 통과.

    prompt: 실제로 전송될 문자열 전체(사용자 질문 포함).
    payload: 경계를 지나는 고객 데이터(`redact.redact_portfolio`의 결과). None이면 종목 질문.
    customer_names: 담당 고객 명단. 자유 텍스트에 이름이 섞이는 걸 여기서 잡는다 —
        `PII_PATTERNS`는 **숫자 형식**만 봐서 한글 이름을 못 잡았다(HANDOFF §7).
    watch: F2 브리핑이 종목마다 내보내는 보유 맥락 목록(`redact.redact_watch`의 결과).
        `payload`와 **모양도 허용 키도 다르다** — 저쪽은 고객 하나(가명 있음), 이쪽은 종목
        하나에 붙은 집계(가명조차 없음). 같은 키셋으로 검사하면 둘 중 하나가 반드시
        헐거워지므로 인자를 나눴다.

    ⚠️ 위반이면 **차단**이고 에이전트는 돌지 않는다(크레딧 0). 지우고 진행하지 않는 이유:
       무엇이 지워졌는지 모른 채 나온 답은 PB가 검증할 수 없다.
    """
    from backend import redact  # 순환 import 방지 — redact는 compliance를 안 쓴다

    violations: list[str] = []

    if payload is not None:
        extra = set(payload) - redact.SANITIZED_KEYS
        if extra:
            violations.append(
                f"반출 허용 목록에 없는 항목: {', '.join(sorted(extra))} "
                "(비식별화를 거치지 않은 원본으로 보입니다)"
            )
        for row in payload.get("holdings") or []:
            extra_h = set(row) - redact.SANITIZED_HOLDING_KEYS
            if extra_h:
                violations.append(f"보유 종목에 허용되지 않은 항목: {', '.join(sorted(extra_h))}")
                break
        # 상황·상담 이력도 **중첩까지** 본다(2026-08-07). 바깥 키만 검사하면 `scenario`를
        # 통째로 얹은 코드가 그대로 통과한다 — 보유 종목에서 이미 같은 처방을 쓰고 있다.
        extra_s = set(payload.get("scenario") or {}) - redact.SANITIZED_SCENARIO_KEYS
        if extra_s:
            violations.append(f"고객 상황에 허용되지 않은 항목: {', '.join(sorted(extra_s))}")
        for asset in (payload.get("scenario") or {}).get("assets") or []:
            extra_a = set(asset) - redact.SANITIZED_ASSET_KEYS
            if extra_a:
                violations.append(f"보유 자산에 허용되지 않은 항목: {', '.join(sorted(extra_a))}")
                break
        for row in payload.get("history") or []:
            extra_hi = set(row) - redact.SANITIZED_HISTORY_KEYS
            if extra_hi:
                violations.append(f"상담 이력에 허용되지 않은 항목: {', '.join(sorted(extra_hi))}")
                break
        # 금액이 새는 마지막 그물. 비중(50.9)·수익률(-2.3)·종목코드(005930)는 안 걸린다.
        blob = json.dumps(payload, ensure_ascii=False)
        if _BIG_INT_RE.search(blob):
            violations.append("계좌 금액으로 보이는 수치가 남아 있습니다 (100만 이상 정수)")

    # F2 보유 맥락 — 허용 키 대조와 금액 그물을 `payload`와 **똑같이** 건다. 다른 문으로
    # 나가는 데이터에 다른 기준을 적용하면, 넓은 쪽이 곧 실제 경계가 된다.
    for w in watch or []:
        extra_w = set(w) - redact.SANITIZED_WATCH_KEYS
        if extra_w:
            violations.append(
                f"보유 맥락에 허용되지 않은 항목: {', '.join(sorted(extra_w))} "
                "(비식별화를 거치지 않은 원본으로 보입니다)"
            )
            break
    if watch and _BIG_INT_RE.search(json.dumps(watch, ensure_ascii=False)):
        violations.append("계좌 금액으로 보이는 수치가 남아 있습니다 (100만 이상 정수)")

    for name in customer_names:
        # 2글자 이름은 대조하지 않는다 — 일반 낱말과 겹쳐 오탐이 크다. 못 잡는 건 한계로
        # 남기고 지어내지 않는다(지금 목업 고객 50명은 전원 3글자다).
        if len(name) >= 3 and name in prompt:
            violations.append(f"고객 이름이 그대로 들어 있습니다: {name}")

    for pattern in PII_PATTERNS:
        if re.search(pattern, prompt):
            violations.append("PII(주민·계좌번호 등)로 보이는 값이 들어 있습니다")
            break

    return violations


def live_acks(acks: list[dict], sentences: list[dict]) -> list[dict]:
    """확인 기록 중 **지금 문장과 여전히 맞는 것**만 (HANDOFF §1-2).

    확인은 문장 **인덱스**로 저장되는데, 분류기를 고치고 재파싱하면(`scripts/reparse_notes.py`)
    그 인덱스가 다른 문장을 가리킬 수 있다. 그래서 저장할 때 원문 앞 60자를 같이 남기고
    여기서 대조한다 — 어긋나면 무효다. 컴플라이언스 판정은 어긋날 때 **막히는** 쪽으로
    틀려야 한다(통과하는 쪽으로 틀리면 아무도 모르게 확인되지 않은 문장이 발행된다).

    ⚠️ **이 판정이 사는 곳은 여기 하나여야 한다.** 게이트(`check_note`의 `acked_indices`)와
       화면에 보내는 목록이 **같은 함수**에서 나와야, "화면은 확인됐다는데 발행은 막히는"
       상태가 생기지 않는다(2026-07-30에 실제로 그랬다 — 화면이 저장된 목록을 그대로 셌다).
    ⚠️ **저장은 건드리지 않는다**(`notes.acks_json`은 지금 상태만 들고, 이력은 감사로그에
       `ack_added`/`ack_removed`로 남는다). 여기서 걸러도 잃는 기록이 없고, 재파싱을 되돌리면
       다시 유효해진다.
    """
    out: list[dict] = []
    for a in acks:
        i = a.get("index")
        if not isinstance(i, int) or not 0 <= i < len(sentences):
            continue
        if sentences[i].get("text", "")[:60] == a.get("text"):
            out.append(a)
    return out


def check_note(
    content_md: str,
    sentences: list[dict],
    feature: str = "F3",
    acked_indices: set[int] | None = None,
    removed_indices: set[int] | None = None,
    waived_indices: set[int] | None = None,
) -> list[str]:
    """위반 사유 목록을 반환한다. 빈 리스트면 게이트 통과.

    feature: 기능 코드(NOTICES의 키). 기능마다 요구되는 고지문구가 다르므로 필수다 —
    기본값 F3는 기존 노트 경로가 그대로 동작하도록 둔 것이다.

    acked_indices: 관리자가 **사유를 적어 확인한** 문장의 인덱스(F3 심의 단계).
    각주를 붙일 수 없는 문장(해석·전망, 고지·면책, 데이터 설명)이 실제로 있기 때문에,
    게이트가 그걸 전부 잠그면 사람이 열 방법이 없어진다 — 그래서 '누가 왜 확인했는가'가
    기록된 문장만 미인용 집계에서 뺀다(판단은 사람, 근거는 감사로그).

    ⚠️ **면제되는 건 미인용 규칙 하나뿐이다.** 단정 표현, MNPI 패턴,
    지연시세 고지 누락은 확인으로 풀 수 없다 — 그건 문장을 고쳐야 하는 위반이다.

    removed_indices: **최종본에서 뺀** 문장(PB `제거`·관리자 `제거`). 확인과 달리 본문에
    남지 않으므로 시세 인용 판정에서 뺀다. `content_md`도 그 문장이 빠진 본문이 온다
    (`main._effective_md`) — 인덱스를 따로 받는 이유는 `_quoted_term` 주석에 있다.

    waived_indices: 관리자가 **사유를 직접 적어** 금지 표현 위반을 통과시킨 문장(2026-08-06).
    ⚠️ **금지 표현 규칙 하나만 연다.** 미인용은 확인(ack)이, 시세 고지는 문장 수정·제거가
       푼다 — 셋을 한 조작으로 묶으면 "무엇을 판단했는지"가 기록에서 사라진다.
    ⚠️ MNPI는 어떤 예외로도 안 열린다. 그건 판단의 문제가 아니라 정보장벽이다.
    """
    violations: list[str] = []

    notice = required_notice(feature)
    if notice not in content_md:
        violations.append(f"{feature} 필수 고지문구 누락: \"{notice}\"")

    for phrase in forbidden_hits(content_md, sentences, waived_indices, removed_indices):
        violations.append(f"단정적 표현 감지: '{phrase}'")

    for pattern in MNPI_PATTERNS:
        if re.search(pattern, content_md):
            violations.append(f"MNPI 의심 패턴 감지 (정규식: {pattern})")

    # "지연시세" 자체가 QUOTE_TERMS의 "시세"를 포함하므로, 고지가 있으면 자연히 통과한다.
    # ⚠️ 고지를 걷어낸 기능은 **만족시킬 문구가 없으므로** 이 규칙을 걸지 않는다
    #    (`QUOTE_EXEMPT_FEATURES` — 엄격한 것과 만족 불가능한 것은 다르다).
    if feature not in QUOTE_EXEMPT_FEATURES and "지연시세" not in content_md:
        term = _quoted_term(content_md, sentences, removed_indices)
        if term:
            violations.append(
                f"시세 정보 포함('{term}') — 지연시세 고지 누락 (실시간이 아님을 명시해야 함)"
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
    """고지문구는 LLM 출력에 의존하지 않고 백엔드가 저장 시점에 강제로 붙인다.

    ⚠️ 문구가 **빈 값이면 아무것도 붙이지 않는다**(2026-08-10 · F1이 그렇다). 그냥 이어
       붙이면 본문 앞에 빈 줄 둘이 생겨 화면과 PDF 첫 줄이 밀린다.
    """
    notice = required_notice(feature)
    if not notice or notice in content_md:
        return content_md
    return f"{notice}\n\n{content_md}"
