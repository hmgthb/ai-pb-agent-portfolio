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
# 그래서 "관측된다"·"두드러진다"·"나온다"처럼 사실 서술로도 읽히는 어미는 넣지 않았다.
_INTERPRETATION_RE = re.compile(
    r"(?:필요가 있다|필요하다|확인이 필요|어렵다|어려우|이르다"
    r"|보인다|보이며|보이지만|읽힌다|읽히지만|해석|시사"
    r"|전망|불확실|단정|볼 필요|살펴볼|점검할|모니터링"
    r"|볼 수 있|구분해)"
)


def parse_sentences(
    note_text: str,
    dart_sources: dict[str, dict],
    news_sources: dict[str, dict],
) -> list[dict]:
    """note_text -> [{text, source, sources, is_heading, kind}, ...]

    dart_sources: {rcept_no: {"viewer_url": ..., "rcept_dt": ...}}
    news_sources: {url: {"title": ..., "pub_date": ...}}

    source는 첫 출처(기존 화면 호환), sources는 그 문장이 인용한 출처 전부다 —
    한 문장이 두 건을 인용하면 둘 다 보여야 한다(가드레일 3: 출처 100% 노출).
    """
    sentences: list[dict] = []
    for raw_line in note_text.split("\n"):
        line = raw_line.strip()
        if not line or _RULE_RE.match(line):
            continue

        heading = _HEADING_RE.match(line)
        if heading:
            sentences.append(_make(heading.group(1), [], "heading"))
            continue

        boilerplate = line.startswith(_BOILERPLATE_PREFIXES)

        matched = False
        for m in _UNIT_RE.finditer(line):
            unit = m.group("text") + m.group("tags")
            text, tags = _strip_footnotes(unit)
            if not text:
                continue
            matched = True
            sources = [s for s in (_resolve_source(t, dart_sources, news_sources) for t in tags) if s]
            sentences.append(_make(text, sources, "boilerplate" if boilerplate else None))
        if not matched:
            # 문장부호로 안 끝나는 줄(마지막 줄 등)도 통째로 한 단위로 취급한다.
            text, tags = _strip_footnotes(line)
            sources = [s for s in (_resolve_source(t, dart_sources, news_sources) for t in tags) if s]
            sentences.append(_make(text, sources, "boilerplate" if boilerplate else None))

    return sentences


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
    tag: str | None, dart_sources: dict[str, dict], news_sources: dict[str, dict]
) -> dict | None:
    if not tag:
        return None
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
