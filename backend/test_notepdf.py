"""종목 노트 PDF 조립 자체 점검 (크레딧 불필요 — LLM 호출 없음).

실행: docker compose exec -T backend python -m backend.test_notepdf

여기서 고정하는 건 **문서에 무엇이 남고 무엇이 빠지는가**다. 레이아웃은 눈으로 보지만,
"뺀 문장이 본문에 남아 있지 않다"·"각주 번호가 본문과 목록에서 같다"는 눈으로 놓친다.
"""

from datetime import datetime

from backend import compliance, notepdf
from backend.bizdate import BIZ_TZ

_DART = {"type": "dart", "rcept_no": "20250313001390",
         "viewer_url": "https://dart.fss.or.kr/x?rcpNo=20250313001390", "rcept_dt": "20250313"}
_NEWS = {"type": "news", "url": "https://example.com/a",
         "title": "기아 7월 판매 13.4% 증가", "pub_date": "Mon, 03 Aug 2026 16:00:30 +0900"}

_CONTENT = """⚠ AI 초안 · 미검증 — 사람의 검토·심의·승인 없이는 발행되지 않습니다.

## 실적 요약

2024 연결기준 매출액은 107조원이다.[^20250313001390] 영업이익은 12조원이다.[^20250313001390]

수익성 지표도 개선된 흐름으로 볼 수 있다.

## 뉴스

7월 판매가 13.4% 늘었다.[^https://example.com/a] 이 문장은 최종본에서 뺀다.
"""


def _sentence(text, sources=(), kind="claim"):
    return {"text": text, "source": (sources or [None])[0], "sources": list(sources),
            "is_heading": kind == "heading", "kind": kind}


def _note(**over):
    sentences = [
        _sentence("⚠ AI 초안 · 미검증 — 사람의 검토·심의·승인 없이는 발행되지 않습니다.",
                  kind="boilerplate"),
        _sentence("실적 요약", kind="heading"),
        _sentence("2024 연결기준 매출액은 107조원이다.", [_DART]),
        _sentence("영업이익은 12조원이다.", [_DART]),
        _sentence("수익성 지표도 개선된 흐름으로 볼 수 있다.", kind="interpretation"),
        _sentence("뉴스", kind="heading"),
        _sentence("7월 판매가 13.4% 늘었다.", [_NEWS]),
        _sentence("이 문장은 최종본에서 뺀다.", kind="interpretation"),
    ]
    note = {
        "id": 23, "stock_code": "000270", "corp_name": "기아", "status": "published",
        "content_md": _CONTENT, "sentences": sentences, "violations": [],
        "acks": [{"index": 4, "reason": "해석·전망", "actor": "준법",
                  "ts": "2026-08-05T01:20:00+00:00", "text": "수익성 지표도"}],
        "marks": [{"index": 7, "mark": "remove", "actor": "PB",
                   "ts": "2026-08-05T01:10:00+00:00", "text": "이 문장은"}],
        "reviewer": "PB", "deliberator": "PB", "publisher": "준법",
        "audit_log": [
            {"event_type": "note_created", "actor": "AI", "ts": "2026-08-04T02:00:00+00:00", "detail": {}},
            {"event_type": "deliberation_started", "actor": "PB", "ts": "2026-08-05T01:15:00+00:00", "detail": {}},
            {"event_type": "published", "actor": "준법", "ts": "2026-08-05T01:30:00+00:00", "detail": {}},
        ],
    }
    note.update(over)
    return note


# ── 본문 조립 ────────────────────────────────────────────
def test_blocks_keep_paragraph_breaks_from_the_source_markdown():
    """한 절을 한 문단으로 뭉치지 않는다 — 원문의 빈 줄이 문단 경계다."""
    note = _note()
    bs = notepdf.blocks(note["content_md"], note["sentences"], drop=set())
    kinds = [b["kind"] for b in bs]
    assert kinds == ["heading", "para", "para", "heading", "para"], kinds
    assert bs[1]["idx"] == [2, 3]  # 같은 줄의 두 문장은 한 문단
    assert bs[2]["idx"] == [4]  # 빈 줄 뒤는 새 문단


def test_boilerplate_is_dropped_from_the_body():
    """모델이 스스로 붙인 고지는 본문에서 뺀다 — 규정 고지는 문서 끝에 한 번만 선다."""
    note = _note()
    bs = notepdf.blocks(note["content_md"], note["sentences"], drop=set())
    assert all(0 not in b.get("idx", []) for b in bs)


def test_removed_sentences_do_not_reach_the_body():
    """⚠️ 이 기능의 존재 이유 — `제거` 판정이 산출물에서 실제로 빠지는 자리는 여기다."""
    note = _note()
    bs = notepdf.blocks(note["content_md"], note["sentences"], drop={7})
    assert all(7 not in b.get("idx", []) for b in bs)
    # 그래도 절 제목은 남는다(뺀 문장이 그 절의 전부여도 구조는 문서의 것이다)
    assert any(b["kind"] == "heading" and b["text"] == "뉴스" for b in bs)


def test_blocks_never_lose_sentences_when_the_markdown_does_not_match():
    """폴백 — 본문과 문장이 어긋나도 문장은 사라지지 않는다(문단만 덜 예뻐진다)."""
    note = _note()
    bs = notepdf.blocks("전혀 다른 본문", note["sentences"], drop=set())
    kept = {i for b in bs if b["kind"] == "para" for i in b["idx"]}
    assert kept == {2, 3, 4, 6, 7}  # 고지(0)·소제목(1·5)만 빠진다


# ── 각주 ────────────────────────────────────────────────
def test_footnote_numbers_follow_the_document_order_and_are_shared():
    """번호는 본문 등장 순서로 매기고, 같은 출처는 번호를 공유한다."""
    note = _note()
    bs = notepdf.blocks(note["content_md"], note["sentences"], drop={7})
    number_of, items = notepdf.footnotes(note["sentences"], bs)
    assert [notepdf.source_key(s) for s in items] == [
        notepdf.source_key(_DART), notepdf.source_key(_NEWS)]
    assert number_of[notepdf.source_key(_DART)] == 1  # 두 문장이 같은 번호를 쓴다


def test_sources_only_cited_by_removed_sentences_leave_the_list():
    """뺀 문장이 유일하게 인용하던 출처는 목록에서도 빠진다 — 본문 어디에도 없는 각주가
    남으면 목록이 문서를 설명하지 못한다."""
    note = _note()
    bs = notepdf.blocks(note["content_md"], note["sentences"], drop={6})
    _, items = notepdf.footnotes(note["sentences"], bs)
    assert [notepdf.source_key(s) for s in items] == [notepdf.source_key(_DART)]


def test_source_labels_match_the_screen_vocabulary():
    """`sources.tsx`의 복제라 어휘가 갈리면 안 된다(공시·뉴스 / 접수번호 / 날짜 형식)."""
    assert notepdf._source_kind(_DART) == "공시"
    assert notepdf._source_date(_DART) == "2025-03-13"
    assert notepdf._source_detail(_DART) == "전자공시 접수번호 20250313001390"
    assert notepdf._source_date(_NEWS) == "2026-08-03"  # RFC 2822도 같은 형식으로
    assert notepdf._source_date({"type": "dart", "rcept_dt": None}) == "접수일 미상"
    assert notepdf._source_href({"type": "krx", "as_of": "20260804"}) is None


# ── 문서 ────────────────────────────────────────────────
def test_build_produces_a_pdf_with_the_mandated_notice():
    """게이트가 보는 문구와 인쇄물의 문구는 같은 상수에서 온다."""
    pdf = notepdf.build(_note(), removed={7}, now=datetime(2026, 8, 6, 15, 0, tzinfo=BIZ_TZ))
    assert pdf[:5] == b"%PDF-"
    assert len(pdf) > 3000  # 폰트가 임베드된 실제 문서
    assert compliance.NOTICES["F3"] == compliance.WATERMARK  # 문구 출처가 하나다


def test_missing_glyphs_are_dropped_not_blanked():
    """⚠️ 회귀 고정 — 나눔고딕에 없는 `⚠`가 빈 칸으로 남으면 고지 앞이 벌어져 오탈자로
    읽힌다. 지우는 건 그 기호뿐이고 한글·`—`·`·`는 그대로 남아야 한다."""
    assert notepdf._renderable(compliance.WATERMARK) == compliance.WATERMARK.replace("⚠ ", "")
    assert notepdf._renderable("가나다 · ABC — 123 ↗") == "가나다 · ABC — 123 ↗"


def test_filename_is_safe_and_identifies_the_note():
    assert notepdf.filename(_note()) == "기아_000270_노트23.pdf"
    assert "/" not in notepdf.filename(_note(corp_name="에이/비 홀딩스"))


# ── 상담 준비 메모 ──────────────────────────────────
_PREP = [
    {"kind": "sentence", "text": "보유 주식 내 삼성전자 비중이 50.9%입니다.",
     "sentence_kind": "claim",
     "sources": [{"type": "holdings", "label": "계좌 보유데이터 (내부·공개데이터 아님)", "as_of": None}]},
    {"kind": "option", "label": "단일 종목 집중", "targets": ["삼성전자"],
     "basis": [{"text": "삼성전자가 보유주식 내 50.9%", "src": "hold"},
               {"text": "이 종목들을 반도체로 분류했을 때의 합계다", "src": "none"}],
     "keeps": "국내주식 자산군 비중 74%는 그대로 남는다"},
    {"kind": "memo", "text": "고객이 반도체를 더 늘리고 싶다고 했음."},
]


def test_prep_sentences_keep_who_wrote_what():
    """PB가 쓴 줄도 문장으로 넘어간다 — **규정 검사를 똑같이 받아야** 하기 때문이다.
    다만 `interpretation`이라 미인용 집계에는 안 들어간다(사람 메모에 각주를 요구하지 않는다)."""
    ss = notepdf.prep_sentences(_PREP)
    assert [s["kind"] for s in ss] == [
        "claim",          # 출처 있는 AI 문장
        "claim",          # 보유데이터 근거
        "interpretation",  # 출처 없는 근거(이 저장소의 업종 분류)
        "interpretation",  # 바꾸지 않는 것
        "interpretation",  # PB 메모
    ]
    assert ss[1]["source"]["type"] == "holdings"
    assert ss[2]["source"] is None  # `none` 태그에는 각주를 붙이지 않는다


def test_prep_markdown_carries_the_pb_memo_into_the_gate():
    """⚠️ PB가 손으로 쓴 줄이 게이트를 비켜 가면 안 된다 — 본문에 들어가야 잡힌다."""
    md = notepdf.prep_markdown(_PREP)
    assert "고객이 반도체를 더 늘리고 싶다고 했음." in md


def test_pb_memo_is_checked_like_everything_else():
    """사람이 썼다고 규정을 비켜 가지 않는다 — 금지 표현은 그대로 막힌다."""
    bad = [{"kind": "memo", "text": "목표주가 12만원 잡고 매수 추천할 것."}]
    v = compliance.check_note(
        compliance.apply_notice(notepdf.prep_markdown(bad), "F1"),
        notepdf.prep_sentences(bad),
        "F1",
    )
    assert any("투자권유" in x for x in v), v


def test_build_prep_and_filename():
    cust = {"id": 19, "name": "권명희", "age": 53, "risk_label": "안정형", "balance": 570_000_000}
    pdf = notepdf.build_prep(cust, _PREP, now=datetime(2026, 8, 6, 15, 0, tzinfo=BIZ_TZ))
    assert pdf[:5] == b"%PDF-" and len(pdf) > 3000
    # ⚠️ 파일명에 이름을 쓰지 않는다 — 목록·메일 제목처럼 본문을 열지 않고 보이는 자리다.
    name = notepdf.prep_filename(cust, datetime(2026, 8, 6, 15, 0, tzinfo=BIZ_TZ))
    assert name == "상담메모_고객19_0806.pdf" and "권명희" not in name


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
