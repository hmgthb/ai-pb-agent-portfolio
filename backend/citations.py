"""A5가 쓴 노트 초안 텍스트를 문장 단위로 쪼개 출처 각주를 매칭한다.

A5는 사실 문장에 `[^태그]`를 붙인다 — 태그는 공시 접수번호(rcept_no, 숫자만)
아니면 뉴스 원문 URL 그대로다(둘 다 backend가 A2·A4 결과에서 이미 A5에게 넘겨준 값).
태그가 없거나, 있어도 이미 알려진 출처 목록과 매칭되지 않으면 그 문장은 미인용으로
표시한다 — 원문에 없는 출처를 지어내 채우지 않는다(가드레일 3).

# ponytail: 한국어 문장 분리는 완벽한 파서가 아니라 마침표/느낌표/물음표 기준
# 휴리스틱이다. 문단(줄바꿈) 단위로도 안전하게 쪼개지도록 줄 단위로 먼저 순회한다.

**각주는 문장 끝에만 오지 않는다 (2026-07-21 실측으로 고침).** 예전 파서는 종결부호
바로 뒤에 붙은 각주만 인정했는데, A5는 한국어 연결어미 뒤에도 자연스럽게 각주를 단다
(`...보도가 있어[^URL], 플랫폼 리스크도...`). NAVER 노트(id 6)에서 본문 각주 10개 중
**5개가 이렇게 조용히 버려져** 실제로는 출처가 있는 문장이 미인용으로 집계됐다 —
게이트가 발행을 하드 블록하므로 지표만이 아니라 발행까지 막던 버그다.
이제 **문장 안 어디에 있든 각주를 전부 걷고**, 표시용 텍스트에서는 태그를 지운다.

문장 범주(`kind`)는 출처 부착률의 분모를 정의하기 위해 나눈다 — 아래 `citation_stats`.
"""

import re

_HEADING_RE = re.compile(r"^#{1,6}\s+(.+)$")
_RULE_RE = re.compile(r"^\s*[-*_]{3,}\s*$")  # `---` 같은 구분선
# 마크다운 각주 정의 줄(`[^태그]: URL`) — 모델이 답변 끝에 출처 목록을 붙이면 나온다.
# 문장이 아니라 참조 정의라 통째로 건너뛴다(안 그러면 ": URL"이 문장으로 잡힌다).
_FOOTNOTE_DEF_RE = re.compile(r"^\s*\[\^[^\]]+\]:\s")
_FOOTNOTE_RE = re.compile(r"\s*\[\^([^\]]+)\]")
# 종결부호 뒤에 각주가 0개 이상 붙고 그 다음이 공백/줄끝일 때만 문장 경계로 본다.
# 이 lookahead가 "2.96%"·URL 안의 마침표에서 잘못 쪼개지는 걸 막는다.
_UNIT_RE = re.compile(r"(?P<text>.+?[.!?])(?P<tags>(?:\s*\[\^[^\]]+\])*)(?=\s|$)")

# 본문이 아니라 고지·구분선 같은 구조 텍스트. 사실 주장이 아니므로 분모에도, 게이트의
# 미인용 집계에도 넣지 않는다 — backend가 강제로 붙이는 워터마크(compliance.apply_notice)와
# A5가 스스로 덧붙이는 면책 문구가 여기 걸린다. 예전엔 이것들이 "출처 없는 문장"으로
# 세어져 우리가 붙인 고지문구가 발행을 막는 자기모순이 있었다(실측: NAVER 노트 3문장).
_BOILERPLATE_PREFIXES = ("※", "⚠", "ℹ", "*주)", "주)")

# 해석·전망·판단유보 문장. 규칙상 각주를 붙이지 않는 게 정상이라(a5.md) 분모에서 뺀다.
# ponytail: **애매하면 사실 주장으로 남긴다** — 분류가 헐거우면 미인용 문장이 분모에서
# 빠져나가 부착률이 실제보다 좋아 보인다. 컴플라이언스 지표는 그 방향으로 틀리면 안 된다.
# 그래서 "관측된다"·"두드러진다"·"나온다"·"언급된다"·"집중되어 있다"처럼 사실 서술로도
# 읽히는 어미는 지금도 넣지 않는다(사람 검토에 올린다).
#
# 아래 2·3번째 줄은 5종목 라이브 eval에서 실측한, **명백히 해석인데 못 잡던 어미**다
# (§1-3 후속). 이걸 빼면 "…근거가 없다/부족하다", "…확인되지 않는다", "…바람직하다",
# "…볼 여지가 있다", "…가능성이 있다" 같은 판단유보 문장이 사실 주장으로 집계돼 부착률을
# 65.8%까지 끌어내렸다. 전부 낮은 오탐 위험의 특정 표현만 추가한다(bare "없다"는 안 쓴다 —
# "매출이 없다"류 사실 주장까지 삼킨다).
# F1 답변은 대화형이라 존댓말(보입니다·어렵습니다·필요가 있습니다)을 쓰고, F3 노트는
# 평서형(보인다·어렵다)을 쓴다. 같은 해석 문장이 어미만 다르므로 **두 어형을 다 잡아야**
# 한다 — 안 그러면 F1의 해석 문장이 사실 주장으로 집계돼 부착률을 끌어내리고 화면에
# 빨간 UNSOURCED로 뜬다(실측). 다만 stem을 너무 넓히면 "선보이며"의 "보이"까지 삼키므로
# (사실 주장을 분모에서 빼는 잘못된 방향), 어형은 명시적으로 나열한다.
_INTERPRETATION_RE = re.compile(
    r"(?:필요가 있다|필요가 있습니다|필요하다|필요합니다|확인이 필요"
    r"|어렵다|어렵습니다|어려우|어려운|이르다|이릅니다"
    # '보이다(seem)'는 '것으로/으로/게 보이…' 문맥일 때만. 안 그러면 '선보이며'(unveil)의
    # '보이'까지 삼켜 사실 주장을 분모에서 빼버린다(실측).
    r"|(?:것으로|으로|게)\s?보(?:인다|입니다|이며|이지만)"
    r"|읽힌다|읽힙니다|읽히지만|해석|시사"
    r"|전망|불확실|단정|볼 필요|살펴볼|점검할|모니터링|유의|판단하기"
    r"|볼 수 있|구분해"
    r"|근거가 없|근거가 부족|근거는 없|확인되지 않|확인할 수 없"
    r"|바람직|가능성이 있|가능성도|여지가 있|여지도|감안|대목|유보"
    # F1 제안형에서 실측한 판단유보 어미(2026-08-04). 선택지를 내면 답변이 "어느 쪽이
    # 나은지는 …에 달려 있고, 고르는 건 PB 몫이다"로 닫히는데, 이게 사실 주장으로 집계돼
    # 각주 없는 문장으로 게이트에 올라갔다. 둘 다 판단을 사람에게 넘기는 표현이라
    # 사실 서술로 쓰이는 일이 없다(§1-1 "애매하면 사실 주장" 원칙을 좁게 지킨다).
    r"|몫이다|몫입니다|달려 있|달려있"
    # "그 근거는 이 **데이터에 없다**" — 입력에 무엇이 없는지를 말하는 문장이다. 맨 `없다`는
    # 여전히 안 넣는다("매출이 없다"류 사실 주장을 삼킨다) — 앞에 데이터/입력이 붙은 것만.
    r"|데이터에 없|데이터엔 없|데이터에는 없|입력에 없|입력엔 없"
    # 입력에 무엇이 안 왔는지를 말하는 문장(2026-08-04 실측). 프롬프트가 이런 문장을 아예
    # 안 쓰게 막았지만, 모델이 어형을 바꿔 빠져나가는 일이 반복돼 왔다(_BOILERPLATE_RE의
    # 전례) — 그물을 하나 더 둔다.
    # ⚠️ 어미만 보면 **사실 주장을 삼킨다**: "이번 공시에 실적 수치가 포함되지 않았다"·
    #    "회사가 가이던스를 제공하지 않았다"는 진짜 사실 주장인데 `포함되지 않`·`제공되지 않`에
    #    걸렸다(실측). 그래서 **앞에 `입력`이나 `데이터`가 있을 때만** 잡는다 — 바깥 세상이
    #    아니라 이 파이프라인의 입력을 가리키는 문장만 해석으로 뺀다.
    r"|(?:입력|데이터)[^.]{0,25}?(?:오지 않|주어지지 않|제공되지 않|포함되지 않|담기지 않))"
)

# a5가 스스로 덧붙이는 자기 고지문구. 접두 기호가 회차마다 다르다 — 노트 6은 "※ 본 문서는
# AI가 생성한 초안…", 기아·LG화학 노트는 "*본 노트는 AI가 작성한 초안이며 미검증 상태입니다.*"
# (마크다운 이탤릭)로 썼다. 접두 기호 목록(_BOILERPLATE_PREFIXES)만으로는 "*"를 못 잡아
# 이 고지문구가 "출처 없는 문장"으로 게이트에 올라갔다(실측 버그, §1-3 후속). 문구 자체의
# 서명으로 잡는다 — 접두가 무엇이든 이 표현이 있으면 boilerplate로 본다.
#
# ⚠️ **같은 버그가 2026-07-29에 또 났다.** a5가 이번엔
#   "*(이 노트는 AI가 작성한 미검증 초안이며, 투자권유·광고가 아닌 내부 참고용입니다.)*"
# 라고 썼는데, 위 패턴이 `작성한` **바로 뒤**에 `초안`이 붙기를 기대해서(`작성한\s*초안`)
# 사이에 낀 "미검증"에 걸려 안 잡혔다 → 또 UNSOURCED로 올라갔다.
# 어형을 하나씩 따라가면 a5가 문장을 바꿀 때마다 같은 버그가 반복된다. 그래서 **뜻의 서명**
# 세 갈래로 잡는다:
#   ① 노트가 자기 자신을 가리키는 말("이/본 노트·문서는 … AI/초안/미검증")
#   ② 접두 기호 없이 쓰인 AI 초안 서명(수식어가 끼어도 통과)
#   ③ 순수 면책 표현(투자권유 아님 · 내부 참고용) — 사실 주장에는 나타나지 않는 말이다
# ⚠️ 넓히는 방향이라 §1-1의 "보수적으로" 원칙과 반대다. 그래서 **고지에만 쓰이는 표현**으로만
#    넓혔다: 종목·수치를 말하는 문장이 "투자권유"나 "내부 참고용"을 담는 일은 없다.
#    새 어형이 또 나오면 여기 갈래를 늘리지 말고 a5.md에서 고지문구를 아예 빼는 쪽을 볼 것
#    (compliance.WATERMARK를 백엔드가 이미 강제 삽입하므로 a5의 자기 고지는 중복이다).
_BOILERPLATE_RE = re.compile(
    r"(?:이|본)\s*(?:노트|문서)는?[^.]{0,40}?(?:AI|초안|미검증)"
    r"|AI가?\s*(?:작성|생성)한?\s*(?:미검증\s*)?초안"
    r"|미검증\s*(?:상태|초안)"
    r"|본\s*(?:노트|문서)는?\s*AI"
    r"|투자권유[^.]{0,12}?아[닙니닌]"
    r"|내부\s*참고용"
    # ④ 근거의 출처가 공개데이터가 아님을 밝히는 말(2026-08-11). F2 고지에서 `내부 참고용`이
    #    빠지면서(`compliance.BRIEF_NOTICE`) 위 ③으로 안 잡히게 됐다 — 그대로 두면 **고지문이
    #    자기 게이트에 미인용 문장으로 걸린다.** 사실 주장이 "공개데이터가 아니다"라고
    #    말하는 일은 없으므로 ③과 같은 계열의 안전한 서명이다.
    r"|공개데이터가?\s*아[닙니닌]"
)


def parse_sentences(
    note_text: str,
    dart_sources: dict[str, dict],
    news_sources: dict[str, dict],
    quote_source: dict | None = None,
    holdings_source: dict | None = None,
) -> list[dict]:
    """note_text -> [{text, source, sources, is_heading, kind}, ...]

    dart_sources: {rcept_no: {"viewer_url": ..., "rcept_dt": ...}}
    news_sources: {url: {"title": ..., "pub_date": ...}}
    quote_source: F1 시세 답변용 — `[^krx]` 태그를 이 메타로 해석한다(있을 때만).
      {"as_of": ..., "close": ..., "label": ...}. 기본값 None이라 F2·F3 경로는 영향 없다.
    holdings_source: F1 포트폴리오 답변용 — `[^hold]` 태그를 이 메타로 해석한다(있을 때만).
      {"label": ..., "as_of": ...}. **이 출처만 공개데이터가 아니다**(내부 계좌 보유데이터) —
      가드레일 1의 명시적 예외라 화면 배지도 `보유(내부)`로 따로 낸다(CLAUDE.md 참조).
      기본값 None이라 F2·F3와 포트폴리오 없는 F1 경로는 영향 없다.

    source는 첫 출처(기존 화면 호환), sources는 그 문장이 인용한 출처 전부다 —
    한 문장이 두 건을 인용하면 둘 다 보여야 한다(가드레일 3: 출처 100% 노출).
    """
    sentences: list[dict] = []
    for raw_line in note_text.split("\n"):
        line = raw_line.strip()
        if not line or _RULE_RE.match(line) or _FOOTNOTE_DEF_RE.match(line):
            continue

        heading = _HEADING_RE.match(line)
        if heading:
            sentences.append(_make(heading.group(1), [], "heading"))
            continue

        boilerplate = line.startswith(_BOILERPLATE_PREFIXES) or bool(_BOILERPLATE_RE.search(line))

        matched = False
        for m in _UNIT_RE.finditer(line):
            unit = m.group("text") + m.group("tags")
            text, tags = _strip_footnotes(unit)
            if not text:
                continue
            matched = True
            sources = _resolve_all(tags, dart_sources, news_sources, quote_source, holdings_source)
            sentences.append(_make(text, sources, "boilerplate" if boilerplate else None))
        if not matched:
            # 문장부호로 안 끝나는 줄(마지막 줄 등)도 통째로 한 단위로 취급한다.
            text, tags = _strip_footnotes(line)
            sources = _resolve_all(tags, dart_sources, news_sources, quote_source, holdings_source)
            sentences.append(_make(text, sources, "boilerplate" if boilerplate else None))

    return sentences


def _resolve_all(tags, dart_sources, news_sources, quote_source, holdings_source=None) -> list[dict]:
    return [
        s
        for s in (
            _resolve_source(t, dart_sources, news_sources, quote_source, holdings_source)
            for t in tags
        )
        if s
    ]


def _make(text: str, sources: list[dict], kind: str | None) -> dict:
    """kind가 None이면 본문 문장 — 각주 유무와 어미로 사실/해석을 가른다."""
    if kind is None:
        # 출처가 붙은 문장은 무조건 사실 주장이다. A5가 근거를 대고 쓴 문장이므로
        # 어미가 해석처럼 보여도(“…시사한다[^rcpNo]”) 분모에 남겨야 한다.
        kind = "claim" if sources or not _INTERPRETATION_RE.search(text) else "interpretation"
    return {
        "text": text,
        "source": sources[0] if sources else None,
        "sources": sources,
        "is_heading": kind == "heading",
        "kind": kind,
    }


def _strip_footnotes(unit: str) -> tuple[str, list[str]]:
    """문장 안 어디에 있든 각주를 전부 걷어내고 (표시용 텍스트, 태그 목록)을 준다."""
    tags = _FOOTNOTE_RE.findall(unit)
    text = _FOOTNOTE_RE.sub("", unit).strip()
    return text, tags


def _resolve_source(
    tag: str | None,
    dart_sources: dict[str, dict],
    news_sources: dict[str, dict],
    quote_source: dict | None = None,
    holdings_source: dict | None = None,
) -> dict | None:
    if not tag:
        return None
    if tag == "krx" and quote_source:
        return {"type": "krx", **quote_source}
    if tag == "hold" and holdings_source:
        return {"type": "holdings", **holdings_source}
    if tag in dart_sources:
        return {"type": "dart", "rcept_no": tag, **dart_sources[tag]}
    if tag in news_sources:
        return {"type": "news", "url": tag, **news_sources[tag]}
    return None


def _kind(sentence: dict) -> str:
    """kind가 붙기 전에 저장된 문장(DB의 옛 노트·기존 테스트)도 읽을 수 있게 한다 —
    그때는 is_heading만 있었으므로 나머지는 전부 사실 주장으로 본다."""
    kind = sentence.get("kind")
    if kind:
        return kind
    return "heading" if sentence.get("is_heading") else "claim"


def is_body(sentence: dict) -> bool:
    """게이트·지표가 보는 본문 문장 — 소제목과 고지·구분선은 뺀다."""
    return _kind(sentence) not in ("heading", "boilerplate")


def is_claim(sentence: dict) -> bool:
    """사실 주장 문장. 각주 없는 사실 주장 = 날조 위험이라 어느 기능에서든 잡아야 한다."""
    return _kind(sentence) == "claim"


def unsourced_count(sentences: list[dict]) -> int:
    """게이트용 미인용 집계 — 해석 문장도 **뺀 게 아니라 그대로 센다**.

    각주 없는 해석 문장을 사람이 검토에서 판단하도록 올리는 건 설계대로다(HANDOFF §1-1).
    지표(citation_stats)와 정의가 다른 건 의도된 것 — 게이트는 넓게 잡고, 지표는
    규칙상 각주가 필요한 문장만 센다.
    """
    return sum(1 for s in sentences if is_body(s) and s["source"] is None)


def citation_stats(sentences: list[dict]) -> tuple[int, int, int]:
    """출처 부착률용 (부착, 분모=사실 주장 문장, 해석 문장 수).

    **분모는 사실 주장 문장만이다.** 해석·전망 문장은 규칙상 각주를 붙이지 않으므로
    (a5.md) 분모에 넣으면 A5가 해석을 몇 문장 쓰느냐에 따라 지표가 흔들린다 —
    실측으로 같은 종목 2회 실행이 10/14 ↔ 7/14로 갈렸다(HANDOFF §1-1).
    해석 문장 수를 같이 돌려주는 건 분모에서 뺀 만큼을 감추지 않기 위해서다.
    """
    sourced = claims = interpretations = 0
    for s in sentences:
        kind = _kind(s)
        if kind == "interpretation":
            interpretations += 1
        elif kind == "claim":
            claims += 1
            if s["source"]:
                sourced += 1
    return sourced, claims, interpretations
