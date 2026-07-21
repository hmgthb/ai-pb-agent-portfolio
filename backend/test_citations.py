"""각주 파싱·문장 범주 자체 점검 (크레딧 불필요 — LLM 호출 없음).

실행: backend/.venv/bin/python -m backend.test_citations
"""

from backend import citations
from backend.citations import citation_stats, parse_sentences, unsourced_count

DART = {"20250318000645": {"viewer_url": "https://dart.fss.or.kr/x", "rcept_dt": "20250318"}}
NEWS = {
    "https://n.news.naver.com/a": {"title": "가", "pub_date": "2026-07-21"},
    "https://n.news.naver.com/b": {"title": "나", "pub_date": "2026-07-21"},
}


def _parse(text):
    return parse_sentences(text, DART, NEWS)


def test_footnote_at_sentence_end():
    s = _parse("매출액은 300조원이다.[^20250318000645]")
    assert len(s) == 1, s
    assert s[0]["source"]["type"] == "dart"
    assert s[0]["text"] == "매출액은 300조원이다.", s[0]["text"]  # 태그는 표시용에서 지운다


def test_footnote_mid_sentence():
    """한국어 연결어미 뒤 각주 — 예전 파서가 통째로 버리던 형태(실측 NAVER 노트).

    여기가 깨지면 출처가 실제로 있는 문장이 미인용으로 잡혀 발행이 하드 블록된다.
    """
    s = _parse("보도가 있어[^https://n.news.naver.com/a], 리스크도 볼 만하다.")
    assert len(s) == 1, s
    assert s[0]["source"]["url"] == "https://n.news.naver.com/a"
    assert "[^" not in s[0]["text"], s[0]["text"]


def test_multiple_sources_in_one_sentence():
    """한 문장이 두 건을 인용하면 둘 다 남긴다 — 가드레일 3(출처 100% 노출)."""
    s = _parse("A라는 보도[^https://n.news.naver.com/a], B라는 보도[^https://n.news.naver.com/b] 등이 있다.")
    assert len(s) == 1, s
    assert len(s[0]["sources"]) == 2, s[0]["sources"]
    assert s[0]["source"] == s[0]["sources"][0]  # 기존 화면 호환


def test_unknown_tag_is_not_invented():
    """알려진 출처와 매칭 안 되는 태그는 출처로 인정하지 않는다(가드레일 3)."""
    s = _parse("매출이 늘었다.[^99999999999999]")
    assert s[0]["source"] is None and s[0]["sources"] == []


def test_decimal_and_url_do_not_split_sentences():
    """'2.96%'의 마침표나 URL 안 마침표에서 문장이 쪼개지면 안 된다."""
    s = _parse("전 거래일 대비 2.96% 오른 194,600원에 거래됐다.[^https://n.news.naver.com/a]")
    assert len(s) == 1, [x["text"] for x in s]


def test_heading_excluded():
    s = _parse("## 실적 요약\n매출액은 300조원이다.[^20250318000645]")
    assert s[0]["is_heading"] and s[0]["kind"] == "heading"
    assert citation_stats(s) == (1, 1, 0)  # 소제목은 분모에 없다


def test_boilerplate_excluded():
    """우리가 붙인 고지문구·구분선이 '출처 없는 문장'으로 세어지면 안 된다 —
    스스로 발행을 막던 버그. 게이트와 지표 양쪽에서 빠져야 한다."""
    s = _parse(
        "매출액은 300조원이다.[^20250318000645]\n"
        "---\n"
        "※ 본 문서는 AI가 생성한 초안이며 미검증 상태입니다. 내부 참고용입니다.\n"
    )
    assert [x["kind"] for x in s] == ["claim", "boilerplate", "boilerplate"], s
    assert unsourced_count(s) == 0
    assert citation_stats(s) == (1, 1, 0)


def test_interpretation_excluded_from_denominator():
    """해석·전망 문장은 각주를 안 붙이는 게 규칙(a5.md)이라 분모에서 뺀다."""
    s = _parse("매출액은 300조원이다.[^20250318000645]\n다만 지속성은 판단하기 어렵다.")
    assert [x["kind"] for x in s] == ["claim", "interpretation"], s
    sourced, claims, interp = citation_stats(s)
    assert (sourced, claims, interp) == (1, 1, 1)  # 100%지, 50%가 아니다


def test_interpretation_still_reaches_the_gate():
    """분모에서 뺐다고 게이트에서까지 빼면 안 된다 — 각주 없는 해석 문장은
    사람이 검토에서 판단하도록 그대로 올린다(HANDOFF §1-1: 설계대로)."""
    s = _parse("다만 지속성은 판단하기 어렵다.")
    assert unsourced_count(s) == 1


def test_sourced_sentence_stays_a_claim():
    """어미가 해석처럼 보여도 근거를 대고 쓴 문장은 사실 주장이다 —
    분모에서 빠져나가 부착률이 실제보다 좋아 보이면 안 된다."""
    s = _parse("수익성 개선을 시사한다.[^20250318000645]")
    assert s[0]["kind"] == "claim"
    assert citation_stats(s) == (1, 1, 0)


def test_ambiguous_sentence_defaults_to_claim():
    """분류가 애매하면 사실 주장으로 남긴다 — 지표가 후하게 틀리지 않도록."""
    s = _parse("시장 일각에서는 과열 신호에 대한 경계도 나온다.")
    assert s[0]["kind"] == "claim"
    assert citation_stats(s) == (0, 1, 0)  # 미인용으로 분모에 남는다


def test_hedge_endings_are_interpretation():
    """라이브 eval에서 사실 주장으로 오분류돼 부착률을 끌어내리던 판단유보 어미들.
    전부 각주 없는 게 규칙대로이므로 분모에서 빠져야 한다(§1-3 후속)."""
    hedges = [
        "이 자료만으로는 판단할 근거가 없다.",
        "등락 원인을 직접 인과로 연결하기에는 근거가 부족하다.",
        "실제 생산·비용에 미치는 영향도 위 데이터로는 확인되지 않는다.",
        "실적 판단을 유보하는 것이 바람직하다.",
        "방향성 측면에서 서로 맞닿아 있는 것으로 볼 여지가 있다.",
        "사안별로 다르게 전개될 가능성이 있다.",
        "앞으로 어떻게 확산되는지가 이어서 확인해야 할 대목이다.",
    ]
    for h in hedges:
        s = _parse(h)
        assert s[0]["kind"] == "interpretation", h


def test_bare_negation_stays_claim():
    """'없다'만으로 해석 처리하면 '매출이 없다'류 사실 주장까지 삼킨다 — 넣지 않았다."""
    s = _parse("해당 분기 배당은 없다.")
    assert s[0]["kind"] == "claim", s


def test_self_disclaimer_is_boilerplate():
    """a5가 접두 기호를 바꿔 단 자기 고지문구도 boilerplate로 잡는다.
    '*'로 시작해 예전엔 '출처 없는 문장'으로 게이트에 올라갔다(실측 버그)."""
    for line in [
        "*본 노트는 AI가 작성한 초안이며 미검증 상태입니다.*",
        "※ 본 문서는 AI가 생성한 초안이며 미검증 상태입니다.",
        "본 노트는 AI가 작성한 초안입니다. 내부 참고용입니다.",
    ]:
        s = _parse(line)
        assert all(x["kind"] == "boilerplate" for x in s), (line, s)
        assert unsourced_count(s) == 0
        assert citation_stats(s) == (0, 0, 0)


def test_legacy_rows_without_kind():
    """DB에 이미 저장된 옛 문장(kind 없음)도 사실 주장으로 세어 하위호환한다."""
    legacy = [{"text": "매출액은 300조원이다.", "source": {"type": "dart"}, "is_heading": False}]
    assert citations.is_body(legacy[0])
    assert citation_stats(legacy) == (1, 1, 0)
    assert unsourced_count(legacy) == 0


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
