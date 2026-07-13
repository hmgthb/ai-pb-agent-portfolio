"""A5가 쓴 노트 초안 텍스트를 문장 단위로 쪼개 출처 각주를 매칭한다.

A5는 사실 문장 끝에 `[^태그]`를 붙인다 — 태그는 공시 접수번호(rcept_no, 숫자만)
아니면 뉴스 원문 URL 그대로다(둘 다 O가 A2·A4 결과에서 이미 A5에게 넘겨준 값).
태그가 없거나, 있어도 이미 알려진 출처 목록과 매칭되지 않으면 그 문장은 미인용으로
표시한다 — 원문에 없는 출처를 지어내 채우지 않는다(가드레일 3).

# ponytail: 한국어 문장 분리는 완벽한 파서가 아니라 마침표/느낌표/물음표 기준
# 휴리스틱이다. 문단(줄바꿈) 단위로도 안전하게 쪼개지도록 줄 단위로 먼저 순회한다.
"""

import re

_HEADING_RE = re.compile(r"^#{1,6}\s+(.+)$")
_UNIT_RE = re.compile(r"(?P<text>.+?[.!?])(?:\[\^(?P<tag>[^\]]+)\])?(?=\s|$)")


def parse_sentences(
    note_text: str,
    dart_sources: dict[str, dict],
    news_sources: dict[str, dict],
) -> list[dict]:
    """note_text -> [{text, source, is_heading}, ...]

    dart_sources: {rcept_no: {"viewer_url": ..., "rcept_dt": ...}}
    news_sources: {url: {"title": ..., "pub_date": ...}}
    """
    sentences: list[dict] = []
    for raw_line in note_text.split("\n"):
        line = raw_line.strip()
        if not line:
            continue

        heading = _HEADING_RE.match(line)
        if heading:
            sentences.append({"text": heading.group(1), "source": None, "is_heading": True})
            continue

        matched = False
        for m in _UNIT_RE.finditer(line):
            text = m.group("text").strip()
            if not text:
                continue
            matched = True
            tag = m.group("tag")
            sentences.append(
                {"text": text, "source": _resolve_source(tag, dart_sources, news_sources), "is_heading": False}
            )
        if not matched:
            # 문장부호로 안 끝나는 줄(마지막 줄 등)도 통째로 한 단위로 취급한다.
            sentences.append({"text": line, "source": None, "is_heading": False})

    return sentences


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


def unsourced_count(sentences: list[dict]) -> int:
    return sum(1 for s in sentences if not s["is_heading"] and s["source"] is None)
