"""발행된 종목 노트 → PDF (**코드가 조립 · LLM 미개입**).

`brief.assemble`과 같은 규칙이다. 다시 쓰게 하면 각주가 문장과 어긋나고(가드레일 3),
그 산출물은 이미 통과한 게이트를 다시 받아야 한다. 여기서 하는 일은 **이미 판정이 끝난
문장들을 문서 형식으로 옮기는 것뿐**이라 결과가 결정론적이고 감사 가능하다.

**이 모듈이 메우는 자리** — `main._effective_md`가 남겨 둔 것:

    ⚠️ 그래서 발행된 노트의 본문에는 뺀 문장이 그대로 들어 있다 — 발행물에서 실제로
       덜어내는 처리는 아직 없다(발행 시 본문 재작성이 필요하다).

PB·준법이 `제거`로 판정한 문장은 지금까지 **게이트 판정용 사본**에서만 빠졌다. PDF가
사람 손에 들어가는 첫 산출물이므로 여기서 실제로 덜어낸다. ⚠️ **저장은 여전히 건드리지
않는다**(`notes.content_md`는 AI가 쓴 그대로) — 무엇을 썼고 사람이 무엇을 뺐는지가 둘 다
남아야 감사가 된다. 뺀 문장은 사라지지 않고 **2면 이력표**에 판정과 함께 남는다.

**각주 번호는 본문 등장 순서**다. 노트 모달(`sources.tsx::buildFootnotes`)은 화면에 보이는
순서로 매기는데, 그 화면은 문장을 검토 등급(`reviewTier`)으로 재정렬한다 — 문장별로 출처를
확인하는 화면이라 그게 맞다. PDF는 문서라서 서술 순서가 정본이고, 두 번호가 다를 수 있다.

⚠️ **출처 표시 어휘는 `frontend/.../sources.tsx`의 복제다**(공시·뉴스·시세·보유 / 접수번호 /
   접수일 미상). 언어가 갈려 공유할 수 없다 — **한쪽을 고치면 다른 쪽도 같이 본다.**
⚠️ 색을 쓰지 않는다. 대시보드의 옐로는 화면에서 1차 CTA를 가리키는 색이고, 인쇄물에서는
   가리킬 조작이 없다. 흑백으로 출력해도 등급이 살아 있어야 한다 — 가르는 건 크기와 선이다.
⚠️ 한글 폰트가 없으면 **조용히 두부(□)로 렌더된다.** 그건 "PDF는 나왔는데 읽을 수 없는"
   가장 나쁜 실패라 폰트를 못 찾으면 **명시적으로 실패**시킨다(`_ensure_fonts`).
"""

from __future__ import annotations

import io
import os
import re
from datetime import datetime
from email.utils import parsedate_to_datetime
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from backend import citations, compliance, f1
from backend.bizdate import BIZ_TZ

# ── 폰트 ────────────────────────────────────────────────────────────────────
# 이미지에 `fonts-nanum`으로 깔린다(backend/Dockerfile). 나눔고딕을 고른 이유는 OFL이고
# 데비안 패키지가 있어서다 — 레포에 4MB 바이너리를 넣지 않아도 된다.
FONT = "NanumGothic"
FONT_BOLD = "NanumGothic-Bold"
_FONT_FILES = {
    FONT: "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
    FONT_BOLD: "/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf",
}
_registered = False


def _ensure_fonts() -> None:
    """한글 글리프가 있는 폰트를 등록한다. 없으면 **여기서 멈춘다.**

    ⚠️ reportlab은 글리프가 없어도 예외 없이 빈 칸을 찍는다. 폰트 없이 진행하면 본문이
       통째로 □가 된 PDF가 감사로그에는 '생성 완료'로 남는다 — 도구 결과가 토큰 한도를
       넘어도 `is_error=False`로 오던 것과 같은 종류의 실패다(HANDOFF §2).
    """
    global _registered
    if _registered:
        return
    missing = [p for p in _FONT_FILES.values() if not os.path.exists(p)]
    if missing:
        raise RuntimeError(
            "PDF용 한글 폰트를 찾지 못했습니다: "
            + ", ".join(missing)
            + " — 이미지에 fonts-nanum이 없습니다(backend/Dockerfile를 고친 뒤 "
            "`docker compose build backend`)."
        )
    for name, path in _FONT_FILES.items():
        pdfmetrics.registerFont(TTFont(name, path))
    pdfmetrics.registerFontFamily(FONT, normal=FONT, bold=FONT_BOLD)
    _registered = True


def _renderable(text: str) -> str:
    """폰트에 없는 글자를 **뺀다.** 빈 칸으로 찍히는 것보다 없는 편이 낫다.

    나눔고딕에 `⚠`(U+26A0)가 없어서 필수 고지가 `  AI 초안 …`처럼 앞이 벌어진 채 나갔다.
    폭만 남은 자리는 오탈자로 읽힌다 — 고지에서 제일 나쁜 종류의 흠이다.

    ⚠️ **문구를 고치는 게 아니다.** 문장은 `compliance.NOTICES`에서 그대로 오고, 여기서
       지우는 건 렌더할 수 없는 **장식 기호 하나**다(`↗`·`▲`·`—`는 폰트에 있어 남는다).
       기호 하나를 위해 폰트를 더 얹지 않는다 — 고지의 무게는 기호가 아니라 **자리**가 진다
       (본문·출처를 다 지난 맨 끝).
    """
    _ensure_fonts()
    cmap = pdfmetrics.getFont(FONT).face.charToGlyph
    kept = "".join(ch for ch in text if ch in "\n\t " or ord(ch) in cmap)
    # 글자가 빠진 자리의 공백까지 접는다 — 기호만 지우고 그 뒤 공백을 남기면 문장이
    # 한 칸 밀려서, 고치려던 "앞이 벌어진" 모양이 그대로 남는다.
    return re.sub(r" {2,}", " ", kept).strip()


def _p(markup: str, style) -> Paragraph:
    """문단 하나. **모든 문자열이 여기를 지난다** — 렌더 못 하는 글자를 거르는 자리가 한
    곳이어야 문구를 새로 넣을 때 빠뜨리지 않는다. 이스케이프는 호출부의 몫이다(일부
    문자열은 `<super>`·`<link>` 마크업을 일부러 담고 있다)."""
    return Paragraph(_renderable(markup), style)


# ── 스타일 ──────────────────────────────────────────────────────────────────
# ⚠️ `wordWrap="CJK"`가 핵심이다. 기본 줄바꿈은 공백에서만 끊어서, 공백 없이 긴 한글
#    덩어리나 URL이 나오면 오른쪽 여백을 넘어 잘린다(글자가 사라져도 예외는 없다).
_INK = colors.HexColor("#111111")
_INK2 = colors.HexColor("#444444")
_LINE = colors.HexColor("#bbbbbb")


def _styles() -> dict[str, ParagraphStyle]:
    base = ParagraphStyle(
        "base", fontName=FONT, fontSize=10, leading=16, textColor=_INK, wordWrap="CJK"
    )
    return {
        "title": ParagraphStyle(
            "title", parent=base, fontName=FONT_BOLD, fontSize=17, leading=24, spaceAfter=2
        ),
        "meta": ParagraphStyle("meta", parent=base, fontSize=8.5, leading=13, textColor=_INK2),
        "h2": ParagraphStyle(
            "h2", parent=base, fontName=FONT_BOLD, fontSize=12, leading=18,
            spaceBefore=12, spaceAfter=4,
        ),
        "body": ParagraphStyle("body", parent=base, spaceAfter=7),
        "srcnum": ParagraphStyle("srcnum", parent=base, fontSize=9, leading=14),
        "src": ParagraphStyle("src", parent=base, fontSize=9, leading=14),
        "url": ParagraphStyle("url", parent=base, fontSize=8, leading=12, textColor=_INK2),
        # 필수 고지 — **테두리 없이 작은 한 줄**(2026-08-06). 상자를 두르면 문서에서 가장
        # 눈에 띄는 덩어리가 되는데, 이 문장은 강조가 아니라 **문서를 닫는 말**이다
        # (화면의 `.wm`도 면 없는 한 줄이다). ⚠️ 색은 본문색 그대로 둔다 — 크기를 줄인 위에
        # 색까지 내리면 읽히지 않고, 읽히지 않는 고지는 고지가 아니다.
        # ⚠️ **종목 노트와 상담 메모가 같이 쓰는 스타일이다** — 여기 크기를 바꾸면 두 문서의
        #    고지가 같이 바뀐다(같은 급의 문장이라 그게 맞다). 본문 10 · 출처 9 아래로 두되
        #    더 줄이지 말 것: 읽히지 않는 고지는 고지가 아니다.
        "notice": ParagraphStyle(
            "notice", parent=base, fontSize=7.5, leading=11, textColor=_INK
        ),
        "cell": ParagraphStyle("cell", parent=base, fontSize=8.5, leading=13),
        # 숫자 열 — 화면 보유 표(`.holdings .num`)와 같이 오른쪽 정렬이다. 정렬이 다르면
        # 같은 표를 화면과 문서에서 각각 다른 방식으로 훑게 된다.
        "cellnum": ParagraphStyle(
            "cellnum", parent=base, fontSize=8.5, leading=13, alignment=TA_RIGHT
        ),
        "cellnumhead": ParagraphStyle(
            "cellnumhead", parent=base, fontName=FONT_BOLD, fontSize=8.5, leading=13,
            alignment=TA_RIGHT,
        ),
        "cellhead": ParagraphStyle(
            "cellhead", parent=base, fontName=FONT_BOLD, fontSize=8.5, leading=13
        ),
        "foot": ParagraphStyle("foot", parent=base, fontSize=8, leading=12, textColor=_INK2),
    }


# ── 출처 표시 (sources.tsx의 복제 — 위 docstring 참조) ───────────────────────

def source_key(src: dict) -> str:
    """같은 출처인지 가르는 값. **URL·접수번호까지 본다** — 날짜로 뭉치면 서로 다른 기사가
    하나로 합쳐져 한쪽 링크가 사라진다(가드레일 3 위반)."""
    t = src.get("type")
    if t == "dart":
        return f"dart:{src.get('rcept_no')}"
    if t == "news":
        return f"news:{src.get('url')}"
    if t == "krx":
        return f"krx:{src.get('as_of')}"
    return "holdings"


def _source_kind(src: dict) -> str:
    return {"dart": "공시", "news": "뉴스", "krx": "시세"}.get(src.get("type"), "보유")


def _fmt_day(value: str | None) -> str:
    """공시 `20260722`·뉴스 RFC 2822·ISO를 `2026-07-22`로. **못 읽으면 원문을 돌려준다** —
    화면에서 잘라 쓰다 `뉴스 Wed, 22 Ju`가 사용자에게 나간 적이 있다(HANDOFF §0-1)."""
    if not value:
        return ""
    s = str(value).strip()
    if re.fullmatch(r"\d{8}", s):
        return f"{s[:4]}-{s[4:6]}-{s[6:]}"
    try:
        return parsedate_to_datetime(s).astimezone(BIZ_TZ).strftime("%Y-%m-%d")
    except (TypeError, ValueError):
        pass
    try:
        return datetime.fromisoformat(s).astimezone(BIZ_TZ).strftime("%Y-%m-%d")
    except ValueError:
        return s


def _source_date(src: dict) -> str:
    t = src.get("type")
    if t == "dart":
        return _fmt_day(src.get("rcept_dt")) or "접수일 미상"
    if t == "news":
        return _fmt_day(src.get("pub_date")) or "시점 미상"
    if t == "krx":
        return _fmt_day(src.get("as_of"))
    return _fmt_day(src.get("as_of"))


def _source_detail(src: dict) -> str:
    """**없는 것을 지어내지 않는다** — 공시에는 문서명이 없다(저장된 출처가 접수번호·URL·
    접수일뿐이라 `dart_search`의 `report_nm`이 안 들어 있다)."""
    t = src.get("type")
    if t == "dart":
        return f"전자공시 접수번호 {src.get('rcept_no')}"
    if t == "news":
        return src.get("title") or "뉴스 원문"
    return src.get("label") or ""


def _source_line(n: int, src: dict) -> str:
    """출처 목록의 한 줄. **빈 조각은 빼고 잇는다** — 보유데이터처럼 날짜가 없는 출처에서
    `[1] 보유 · · 계좌 보유데이터`처럼 가운뎃점이 겹쳐 나온다(실측)."""
    parts = [_source_kind(src), _source_date(src), escape(_source_detail(src))]
    return f"[{n}] " + " · ".join(x for x in parts if x)


def _source_href(src: dict) -> str | None:
    """시세·보유는 사람이 볼 페이지가 없어 링크가 아니다."""
    t = src.get("type")
    if t == "dart":
        return src.get("viewer_url") or None
    if t == "news":
        return src.get("url") or None
    return None


# ── 본문 조립 ───────────────────────────────────────────────────────────────

_FOOTNOTE_RE = re.compile(r"\[\^[^\]]*\]")


def _norm(text: str) -> str:
    """각주 태그를 걷고 공백을 접는다. 문장과 원문 줄을 맞춰 볼 때 쓴다."""
    return re.sub(r"\s+", " ", _FOOTNOTE_RE.sub("", text or "")).strip()


def blocks(content_md: str, sentences: list[dict], drop: set[int]) -> list[dict]:
    """문장 목록을 **원문의 문단 구조에 다시 얹는다.**

    반환: [{"kind": "heading"|"para", "text": ...} | {"kind": "para", "idx": [i, ...]}]

    `parse_sentences`가 줄 단위로 돌기 때문에 문장 배열은 문서 순서지만 **줄바꿈이 없다.**
    한 절을 한 문단으로 뭉치면 두 문단짜리 절이 벽이 된다. 그래서 원문 줄을 훑으며 그 줄에
    들어 있는 문장을 차례로 소비해 문단 경계를 되찾는다.

    ⚠️ 어긋나면(파서 규칙이 바뀌었거나 본문이 손질됐거나) **남은 문장을 통째로 한 문단에
       담아 되돌려 준다.** 문단이 덜 예쁜 것과 문장이 사라지는 것은 급이 다르다.
    """
    out: list[dict] = []
    i = 0
    n = len(sentences)
    for raw in (content_md or "").split("\n"):
        line = _norm(raw)
        if not line:
            continue
        taken: list[int] = []
        while i < n:
            text = _norm(sentences[i].get("text", ""))
            if not text or text not in line:
                break
            taken.append(i)
            i += 1
        for idx in taken:
            s = sentences[idx]
            if s.get("is_heading") or s.get("kind") == "heading":
                out.append({"kind": "heading", "text": s.get("text", "")})
            elif idx not in drop and citations.is_body(s):
                # 고지문구(boilerplate)는 본문에서 뺀다 — 규정 고지는 문서 끝에 한 번만
                # 서고, 모델이 회차마다 다르게 붙이는 자기 고지는 그 자리의 것이 아니다
                # (노트 모달도 `kind !== 'boilerplate'`로 거른다).
                if out and out[-1]["kind"] == "para" and out[-1].get("open"):
                    out[-1]["idx"].append(idx)
                else:
                    out.append({"kind": "para", "idx": [idx], "open": True})
        # 줄이 끝나면 문단도 끝난다 — 다음 줄은 새 문단이다.
        for b in out:
            b.pop("open", None)
    if i < n:  # 폴백: 못 맞춘 나머지
        rest = [
            j for j in range(i, n)
            if j not in drop and citations.is_body(sentences[j]) and not sentences[j].get("is_heading")
        ]
        if rest:
            out.append({"kind": "para", "idx": rest})
    return [b for b in out if b["kind"] == "heading" or b["idx"]]


def footnotes(sentences: list[dict], body_blocks: list[dict]) -> tuple[dict[str, int], list[dict]]:
    """(sourceKey → 번호, [출처, ...]). **본문에 실제로 남은 문장의 출처만** 번호를 받는다 —
    뺀 문장이 유일하게 인용하던 출처가 목록에 남으면 본문 어디에도 없는 각주가 생긴다."""
    number_of: dict[str, int] = {}
    items: list[dict] = []
    for b in body_blocks:
        if b["kind"] != "para":
            continue
        for idx in b["idx"]:
            s = sentences[idx]
            for src in s.get("sources") or ([s["source"]] if s.get("source") else []):
                key = source_key(src)
                if key in number_of:
                    continue
                number_of[key] = len(items) + 1
                items.append(src)
    return number_of, items


def _refs(sentence: dict, number_of: dict[str, int]) -> str:
    ns: list[int] = []
    for src in sentence.get("sources") or ([sentence["source"]] if sentence.get("source") else []):
        n = number_of.get(source_key(src))
        if n and n not in ns:
            ns.append(n)
    return f"<super>{','.join(str(n) for n in ns)}</super>" if ns else ""


# ── 이력 ────────────────────────────────────────────────────────────────────

def _fmt_ts(value: str | None) -> str:
    """감사로그 시각 → `2026-08-06 14:20`(KST). ⚠️ 컨테이너가 UTC라 변환 없이 자르면
    KST 00~09시 사건이 하루 전으로 찍힌다(HANDOFF §2)."""
    if not value:
        return "—"
    try:
        return datetime.fromisoformat(value).astimezone(BIZ_TZ).strftime("%Y-%m-%d %H:%M")
    except (TypeError, ValueError):
        return str(value)


def _first_ts(audit: list[dict], event: str) -> str | None:
    """그 사건이 **처음** 일어난 시각. 반려로 되돌아온 노트는 같은 사건이 여러 번 찍힌다."""
    hits = [a["ts"] for a in audit if a.get("event_type") == event]
    return min(hits) if hits else None


def _stage_rows(note: dict) -> list[tuple[str, str, str]]:
    audit = note.get("audit_log") or []
    return [
        ("작성", note.get("created_by") or "AI", _fmt_ts(_first_ts(audit, "note_created"))),
        ("사실 확인 · 심의 요청", note.get("deliberator") or "—",
         _fmt_ts(_first_ts(audit, "deliberation_started"))),
        ("발행", note.get("publisher") or "—", _fmt_ts(_first_ts(audit, "published"))),
    ]


# ── 문서 ────────────────────────────────────────────────────────────────────

def _page_furniture(note: dict):
    """페이지마다 도는 꼬리말. 낱장으로 흩어져도 어느 노트의 몇 쪽인지 알아야 한다."""
    tag = f"노트 #{note['id']} · {note.get('corp_name', '')}({note.get('stock_code', '')}) · 내부 참고용"

    def draw(canvas, doc):
        canvas.saveState()
        canvas.setFont(FONT, 7.5)
        canvas.setFillColor(_INK2)
        canvas.drawString(20 * mm, 12 * mm, tag)
        canvas.drawRightString(A4[0] - 20 * mm, 12 * mm, str(canvas.getPageNumber()))
        canvas.setStrokeColor(_LINE)
        canvas.setLineWidth(0.4)
        canvas.line(20 * mm, 15 * mm, A4[0] - 20 * mm, 15 * mm)
        canvas.restoreState()

    return draw


def _table(rows: list[list], widths: list[float]) -> Table:
    t = Table(rows, colWidths=widths, hAlign="LEFT")
    t.setStyle(
        TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("RIGHTPADDING", (0, 0), (-1, -1), 8),
            ("LINEBELOW", (0, 0), (-1, 0), 0.6, _INK2),
            ("LINEBELOW", (0, 1), (-1, -2), 0.3, _LINE),
        ])
    )
    return t


def build(note: dict, removed: set[int] | None = None, now: datetime | None = None) -> bytes:
    """노트 상세(`main._note_to_dict`) → PDF 바이트.

    removed: 최종본에서 뺄 문장 인덱스(`main._removed_indices`). 판정은 호출자가 한다 —
             `live_acks` 대조가 백엔드 한 곳(§1-2)이라 여기서 다시 세면 두 곳으로 갈린다.
    now: 생성 시각(주입 가능 — 테스트가 시각을 고정한다).
    """
    _ensure_fonts()
    st = _styles()
    drop = set(removed or ())
    sentences = note.get("sentences") or []
    body = blocks(note.get("content_md", ""), sentences, drop)
    number_of, items = footnotes(sentences, body)
    now = now or datetime.now(BIZ_TZ)

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm, topMargin=18 * mm, bottomMargin=20 * mm,
        title=f"{note.get('corp_name', '')}({note.get('stock_code', '')}) 종목 노트 #{note['id']}",
        author="AI PB 어시스턴트",
        subject="내부 참고용 · 투자권유 아님",
    )

    flow: list = []
    flow.append(_p(
        f"{escape(note.get('corp_name', ''))}({escape(note.get('stock_code', ''))}) 종목 노트",
        st["title"],
    ))
    stages = _stage_rows(note)
    # 머리말은 "언제·누가"까지만. 단계별 시각은 2면 표가 말한다 — 여기서 되풀이하면
    # 제목 아래가 표가 된다. ⚠️ 곁말은 괄호로 적는다(`—`를 접속사로 쓰지 않는다).
    flow.append(_p(
        " · ".join([
            f"노트 #{note['id']}",
            f"{stages[2][2]} 발행({stages[2][1]})",
            f"확인({stages[1][1]})",
        ]),
        st["meta"],
    ))
    flow.append(Spacer(1, 10))

    for b in body:
        if b["kind"] == "heading":
            flow.append(_p(escape(b["text"]), st["h2"]))
            continue
        text = " ".join(
            escape(sentences[i].get("text", "").strip()) + _refs(sentences[i], number_of)
            for i in b["idx"]
        )
        flow.append(_p(text, st["body"]))

    # 출처 — 각주 번호와 원문 주소. 링크는 목록 쪽에만 둔다(sources.tsx와 같은 규칙).
    flow.append(Spacer(1, 6))
    flow.append(_p("출처", st["h2"]))
    if items:
        for n, src in enumerate(items, 1):
            parts = [_p(_source_line(n, src), st["src"])]
            href = _source_href(src)
            if href:
                # 주소는 공시·뉴스에서 온 값이라 우리가 통제하는 문자열이 아니다 —
                # 속성 안에 들어가므로 따옴표까지 이스케이프한다.
                safe = escape(href, {'"': "&quot;"})
                parts.append(_p(f'<link href="{safe}">{escape(href)}</link>', st["url"]))
            flow.append(KeepTogether(parts))
    else:
        flow.append(_p("본문에 인용된 출처가 없습니다.", st["src"]))

    # 필수 고지 — 본문·출처를 다 지난 자리(모달의 `.wm`과 같은 배치).
    # ⚠️ 문구는 `compliance.NOTICES["F3"]`에서 그대로 가져온다. 여기에 다시 적으면
    #    게이트가 보는 문구와 인쇄물의 문구가 갈린다.
    flow.append(Spacer(1, 12))
    flow.append(_p(escape(compliance.NOTICES["F3"]), st["notice"]))

    # ── 2면: 이력 ───────────────────────────────────────────────────────────
    flow.append(PageBreak())
    flow.append(_p("검토 이력", st["h2"]))
    flow.append(_p(
        "이 문서는 노트 #%d의 발행 시점 기록을 코드가 그대로 옮긴 것이며, "
        "문장을 다시 쓰거나 요약하지 않습니다." % note["id"],
        st["foot"],
    ))
    flow.append(Spacer(1, 8))

    def head(text: str) -> Paragraph:
        return _p(escape(text), st["cellhead"])

    def cell(text) -> Paragraph:
        return _p(escape(str(text)), st["cell"])

    flow.append(_table(
        [[head("단계"), head("담당"), head("시각")]]
        + [[cell(a), cell(b), cell(c)] for a, b, c in stages],
        [55 * mm, 40 * mm, 55 * mm],
    ))

    acks = [a for a in (note.get("acks") or []) if a.get("reason") != "제거"]
    if acks:
        flow.append(Spacer(1, 14))
        flow.append(_p("준법 확인: 각주를 붙일 수 없는 문장", st["h2"]))
        flow.append(_table(
            [[head("문장"), head("사유"), head("담당 · 시각")]]
            + [[cell(a.get("text", "")), cell(a.get("reason", "")),
                cell(f"{a.get('actor', '')} · {_fmt_ts(a.get('ts'))}")] for a in acks],
            [85 * mm, 30 * mm, 55 * mm],
        ))

    # 뺀 문장 — **사라지지 않는다.** 무엇을 뺐는지가 감사 대상이라 여기 남긴다.
    if drop:
        by_index = {}
        for m in note.get("marks") or []:
            if m.get("mark") == "remove":
                by_index[m["index"]] = ("PB 제거", m.get("actor", ""), m.get("ts"))
        for a in note.get("acks") or []:
            if a.get("reason") == "제거":
                by_index[a["index"]] = ("준법 제거", a.get("actor", ""), a.get("ts"))
        rows = [
            [cell(sentences[i].get("text", "")), cell(by_index.get(i, ("제거", "", None))[0]),
             cell(f"{by_index.get(i, ('', '', None))[1]} · {_fmt_ts(by_index.get(i, ('', '', None))[2])}")]
            for i in sorted(drop) if 0 <= i < len(sentences)
        ]
        if rows:
            flow.append(Spacer(1, 14))
            flow.append(_p("최종본에서 뺀 문장", st["h2"]))
            flow.append(_table(
                [[head("문장"), head("판정"), head("담당 · 시각")]] + rows,
                [85 * mm, 30 * mm, 55 * mm],
            ))

    flow.append(Spacer(1, 16))
    # 꼬리말은 **생성 시각과 만든 것**까지다. "코드가 조립했다(LLM 미개입)"는 바로 위
    # 설명문이 이미 같은 말을 하고 있어서 뺐다(2026-08-06) — 한 면에 같은 사실이 두 번 적히면
    # 그 사실이 아니라 그 반복이 읽힌다.
    flow.append(_p(
        f"생성 {now.astimezone(BIZ_TZ).strftime('%Y-%m-%d %H:%M')} (KST) · AI PB 어시스턴트",
        st["foot"],
    ))

    draw = _page_furniture(note)
    doc.build(flow, onFirstPage=draw, onLaterPages=draw)
    return buf.getvalue()


def filename(note: dict) -> str:
    """`기아_000270_노트23.pdf`. 공백·경로 구분자는 뺀다(내려받는 쪽 파일명이 된다)."""
    corp = re.sub(r"[^\w가-힣]+", "", note.get("corp_name") or "노트")
    return f"{corp}_{note.get('stock_code', '')}_노트{note['id']}.pdf"


# ── 상담 준비 메모 (F1 채팅에서 PB가 담은 것) ────────────────────────────────
#
# 종목 노트 PDF와 **성격이 다른 문서**라 조립도 따로 한다:
#   · 종목 노트 = AI가 쓰고 사람이 통과시킨 것. 저장된 노트에서 조립한다.
#   · 상담 준비 메모 = AI가 낸 것 중 **PB가 고른 것**. 저장하지 않고 요청 때 조립한다.
#     (고를 자리를 화면에 만드는 게 이 기능의 요점이다 — 고객 카드 채팅.)
#
# ⚠️ **고객 단위 문서다.** 이름은 싣되 계좌번호·생년월일은 싣지 않고, 파일명에도 이름을
#    쓰지 않는다(`상담메모_고객19_0806.pdf`). 페이지 꼬리말에도 이름을 반복하지 않는다 —
#    낱장이 흩어질 때 이름이 여러 번 나오면 그만큼 새어 나갈 자리가 는다.
# ⚠️ **고객에게 주는 문서가 아니다.** 그 말은 **페이지 꼬리말**이 한다(`상담 준비 메모 ·
#    내부 참고용 · 고객 제공용 아님`) — 매 페이지에 있고 낱장이 흩어져도 따라간다.
#    머리말에 같은 뜻의 한 줄을 또 두었다가 걷어냈다(2026-08-06): 한 면에 같은 말이 두 번
#    있으면 읽는 사람은 둘 다 안 읽는다.

# 근거 줄의 출처 태그(`f1._basis`의 src) → 출처 메타. `none`은 이 저장소가 정한 분류라
# 출처가 없다(각주를 안 붙인다) — f1.SECTORS 주석과 같은 규칙이다.
_BASIS_SRC = {
    "hold": {"type": "holdings", "label": "계좌 보유데이터 (내부·공개데이터 아님)", "as_of": None},
    "krx": {"type": "krx", "label": "KRX 지연시세", "as_of": None, "close": ""},
}


def prep_sentences(items: list[dict]) -> list[dict]:
    """메모 항목 → **게이트가 볼 문장 목록**(순수).

    ⚠️ PB가 쓴 줄(`memo`)도 문장으로 넘긴다. 금지 표현·시세 규칙을 **똑같이** 받아야 하기
       때문이다 — 사람이 썼다고 규정을 비켜 가지 않는다. 다만 `kind`는 `interpretation`이라
       미인용 집계에는 안 들어간다(사람의 메모에 각주를 요구하는 건 규칙이 아니다).
    ⚠️ AI 문장의 `kind`는 **답변이 준 값을 그대로** 쓴다. 여기서 다시 분류하면 화면이 말한
       것과 문서가 세는 것이 갈린다(§1-1의 분류가 단일 출처다).
    """
    out: list[dict] = []
    for it in items:
        kind = it.get("kind")
        if kind == "sentence":
            srcs = it.get("sources") or []
            out.append({
                "text": it.get("text", ""),
                "source": srcs[0] if srcs else None,
                "sources": srcs,
                "is_heading": False,
                "kind": "claim" if srcs else (it.get("sentence_kind") or "interpretation"),
            })
        elif kind == "option":
            for b in it.get("basis") or []:
                src = _BASIS_SRC.get(b.get("src"))
                out.append({
                    "text": b.get("text", ""),
                    "source": src,
                    "sources": [src] if src else [],
                    "is_heading": False,
                    "kind": "claim" if src else "interpretation",
                })
            if it.get("keeps"):
                out.append({"text": it["keeps"], "source": None, "sources": [],
                            "is_heading": False, "kind": "interpretation"})
        elif kind == "memo":
            out.append({"text": it.get("text", ""), "source": None, "sources": [],
                        "is_heading": False, "kind": "interpretation"})
    return out


def prep_markdown(items: list[dict]) -> str:
    """게이트가 볼 본문. 화면 조립물이라 마크다운 구조가 없어 **문장을 줄로 잇는다** —
    금지 표현·MNPI는 문자열에서 찾으므로 이 형태로 충분하다."""
    return "\n".join(s["text"] for s in prep_sentences(items) if s["text"])


def _balance_text(balance) -> str:
    """`₩14.3억`. 화면(`api.ts::fmtKRW`)과 같은 눈금이다 — 두 곳이 다르면 같은 고객의
    잔고가 화면과 문서에서 다르게 읽힌다. ⚠️ 한쪽을 고치면 다른 쪽도 본다."""
    if not isinstance(balance, (int, float)):
        return ""
    if balance >= 100_000_000:
        return f"₩{round(balance / 100_000_000, 1)}억"
    return f"₩{round(balance / 10_000):,}만"


def build_prep(customer: dict, items: list[dict], now: datetime | None = None) -> bytes:
    """상담 준비 메모 PDF. `customer`는 **서버가 DB에서 읽은 것**이고(스코핑이 걸린 자리),
    `items`는 화면이 조립한 목록이다."""
    _ensure_fonts()
    st = _styles()
    now = now or datetime.now(BIZ_TZ)
    sentences = prep_sentences(items)
    number_of, sources = footnotes(sentences, [{"kind": "para", "idx": list(range(len(sentences)))}])

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=20 * mm, rightMargin=20 * mm, topMargin=18 * mm, bottomMargin=20 * mm,
        title=f"상담 준비 메모 (고객 #{customer.get('id')})",
        author="AI PB 어시스턴트",
        subject="내부 참고용 · 고객 제공용 아님",
    )

    flow: list = [_p("상담 준비 메모", st["title"])]
    facts = [
        # 번호가 앞에 선다 — 화면·감사로그가 고객을 가리키는 식별자가 id이고, 이름만으로는
        # 동명이인을 가를 수 없다. 파일명에 이름을 안 쓰는 것과 짝이다(파일명도 번호다).
        f"#{customer.get('id')}",
        escape(str(customer.get("name") or "")),
        f"{customer.get('age')}세" if customer.get("age") else "",
        escape(str(customer.get("risk_label") or "")),
        _balance_text(customer.get("balance")),
    ]
    flow.append(_p(" · ".join(x for x in facts if x), st["meta"]))

    # 자산 구성 — 화면 고객 상세(도넛 범례 + 보유 표)와 **같은 값·같은 순서**다.
    # 담은 문장이 "삼성전자 50.9%"라고 말할 때 그 분모가 무엇인지 문서 안에서 확인되려면
    # 이 표가 같은 장에 있어야 한다.
    # ⚠️ 비중을 여기서 다시 계산하지 않는다 — 분모와 반올림은 `f1.portfolio_facts`가 단일
    #    출처이고, 라우트가 그 값을 그대로 실어 준다(`_customer_to_dict`).
    alloc = customer.get("alloc") or {}
    ordered = [k for k in f1.ALLOC_ORDER if k in alloc] + [
        k for k in alloc if k not in f1.ALLOC_ORDER  # 사전에 없는 자산군도 버리지 않는다
    ]
    if ordered:
        flow.append(Spacer(1, 6))
        # 라벨을 떼고 값만 둔다 — 바로 아래 표가 종목이고 이 줄이 자산군이라, 형태가
        # 이미 둘을 가른다(화면 도넛 범례에도 라벨이 없다).
        flow.append(_p(
            " · ".join(f"{escape(k)} {alloc[k]}%" for k in ordered),
            st["meta"],
        ))

    holdings = customer.get("holdings") or []
    if holdings:
        flow.append(Spacer(1, 6))
        rows = [[
            _p("종목", st["cellhead"]),
            _p("평가금액", st["cellnumhead"]),
            _p("주식 내", st["cellnumhead"]),
        ]]
        for h in holdings:
            pct = h.get("pct_of_equity")
            rows.append([
                _p(f"{escape(str(h.get('name') or ''))} {escape(str(h.get('code') or ''))}", st["cell"]),
                _p(_balance_text(h.get("amt")), st["cellnum"]),
                # 비중이 없으면 빈칸이 아니라 `—`(화면과 같은 규칙) — 빈칸은 "0%"로도
                # "아직 안 셌다"로도 읽힌다.
                _p("—" if pct is None else f"{pct}%", st["cellnum"]),
            ])
        flow.append(_table(rows, [90 * mm, 40 * mm, 25 * mm]))

    flow.append(Spacer(1, 12))

    # 항목은 **PB가 담은 순서 그대로** 간다. 정렬하지 않는 이유: 무엇을 먼저 꺼낼지가
    # 이미 그 사람의 판단이고, 문서가 그걸 다시 정하면 고른 의미가 줄어든다.
    i = 0
    for it in items:
        kind = it.get("kind")
        if kind == "sentence":
            flow.append(_p(escape(sentences[i]["text"]) + _refs(sentences[i], number_of), st["body"]))
            i += 1
        elif kind == "option":
            targets = " · ".join(escape(t) for t in (it.get("targets") or []))
            head = f"선택지: {escape(it.get('label', ''))}"
            flow.append(_p(head + (f" ({targets})" if targets else ""), st["h2"]))
            for _ in it.get("basis") or []:
                flow.append(_p("· " + escape(sentences[i]["text"]) + _refs(sentences[i], number_of), st["src"]))
                i += 1
            if it.get("keeps"):
                flow.append(_p("바꾸지 않는 것: " + escape(sentences[i]["text"]), st["src"]))
                i += 1
        elif kind == "memo":
            # PB가 쓴 줄 — AI 문장과 **한눈에 갈려야** 한다. 라벨을 앞에 두고 색을 내린다
            # (문서가 흑백으로 나가도 라벨은 남는다).
            flow.append(Spacer(1, 4))
            flow.append(_p("[PB 메모] " + escape(sentences[i]["text"]), st["foot"]))
            flow.append(Spacer(1, 2))
            i += 1

    if sources:
        flow.append(Spacer(1, 6))
        flow.append(_p("출처", st["h2"]))
        for n, src in enumerate(sources, 1):
            parts = [_p(_source_line(n, src), st["src"])]
            href = _source_href(src)
            if href:
                safe = escape(href, {'"': "&quot;"})
                parts.append(_p(f'<link href="{safe}">{escape(href)}</link>', st["url"]))
            flow.append(KeepTogether(parts))

    # 규정 고지 — `compliance.NOTICES["F1"]` 그대로다. 위 `PREP_PURPOSE`와 역할이 다르다:
    # 저건 문서 성격, 이건 규정이 요구하는 문구(지연시세·투자권유 아님·내부 계좌데이터).
    flow.append(Spacer(1, 12))
    flow.append(_p(escape(compliance.NOTICES["F1"]), st["notice"]))
    flow.append(Spacer(1, 10))
    flow.append(_p(
        f"생성 {now.astimezone(BIZ_TZ).strftime('%Y-%m-%d %H:%M')} (KST) · AI PB 어시스턴트",
        st["foot"],
    ))

    def draw(canvas, doc_):
        # ⚠️ 꼬리말에 고객 이름을 넣지 않는다(위 주석) — 낱장이 흩어져도 이름은 1면에만 있다.
        canvas.saveState()
        canvas.setFont(FONT, 7.5)
        canvas.setFillColor(_INK2)
        canvas.drawString(20 * mm, 12 * mm, "상담 준비 메모 · 내부 참고용 · 고객 제공용 아님")
        canvas.drawRightString(A4[0] - 20 * mm, 12 * mm, str(canvas.getPageNumber()))
        canvas.setStrokeColor(_LINE)
        canvas.setLineWidth(0.4)
        canvas.line(20 * mm, 15 * mm, A4[0] - 20 * mm, 15 * mm)
        canvas.restoreState()

    doc.build(flow, onFirstPage=draw, onLaterPages=draw)
    return buf.getvalue()


def prep_filename(customer: dict, now: datetime) -> str:
    """`상담메모_고객19_0806.pdf` — **이름을 파일명에 쓰지 않는다.** 파일 목록·메일 제목처럼
    본문을 열지 않고도 보이는 자리에 고객 이름이 남는 걸 피한다."""
    return f"상담메모_고객{customer.get('id')}_{now.astimezone(BIZ_TZ).strftime('%m%d')}.pdf"
