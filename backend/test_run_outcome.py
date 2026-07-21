"""3시나리오(공시 없음·파싱 실패·뉴스 없음) 판정 자체 점검 (크레딧 불필요 — LLM 호출 없음).

실행: backend/.venv/bin/python -m backend.test_run_outcome

핵심은 **"조회 0건"과 "도구 실패"를 구분하는 것**이다. 둘을 뭉뚱그리면 화면이
"실패 지점을 확인하세요"밖에 못 말하고, 정상 동작(공시가 원래 없는 종목)까지
장애처럼 보인다.
"""

from backend.main import _a5_input, _run_outcome

FIN = {"bsns_year": "2024", "fs_div": "CFS", "figures": {"매출액": {"당기": "1", "전기": "1"}}}
NEWS = [{"title": "제목", "link": "https://n/1", "pub_date": "2026-07-21", "description": "요지"}]


def _outcome(**kw):
    base = dict(
        financials=FIN, news_items=NEWS, disclosure_count=3, failed_tools=set(), note_created=True
    )
    return _run_outcome(**{**base, **kw})


def _joined(o):
    return " / ".join(o["reasons"])


def test_all_green_has_no_reasons():
    o = _outcome()
    assert o["reasons"] == [], o
    assert o["note_created"] and o["has_financials"] and o["news_count"] == 1


def test_no_disclosures_is_not_an_error():
    """공시가 0건인 건 장애가 아니라 정상 결과다 — 그렇게 말해야 한다."""
    o = _outcome(disclosure_count=0)
    assert "최근 공시가 없습니다" in _joined(o)
    assert "실패" not in _joined(o), o["reasons"]


def test_disclosure_search_failure_is_an_error():
    o = _outcome(disclosure_count=0, failed_tools={"mcp__dart__dart_search"})
    assert "공시 목록 조회에 실패" in _joined(o)
    # 실패했을 때 "0건입니다"라고 말하면 안 된다 — 조회가 안 된 것이지 0건이 아니다
    assert "최근 공시가 없습니다" not in _joined(o)


def test_parse_failure_explains_cfs():
    o = _outcome(financials=None, failed_tools={"mcp__dart__dart_parse"})
    assert "재무제표 파싱에 실패" in _joined(o)
    assert "CFS" in _joined(o)
    assert o["has_financials"] is False


def test_missing_financials_without_tool_failure():
    """도구가 죽지 않았는데 수치가 없는 경우도 조용히 넘기지 않는다."""
    o = _outcome(financials=None)
    assert "재무 핵심수치를 확보하지 못했습니다" in _joined(o)


def test_no_news_is_not_an_error():
    o = _outcome(news_items=[])
    assert "관련 뉴스가 없습니다" in _joined(o)
    assert o["news_count"] == 0


def test_news_search_failure_is_an_error():
    o = _outcome(news_items=[], failed_tools={"mcp__news__news_search"})
    assert "뉴스 조회에 실패" in _joined(o)
    assert "관련 뉴스가 없습니다" not in _joined(o)


def test_no_note_says_why():
    """재무·뉴스가 다 없으면 노트를 안 만드는 게 맞다 — 다만 이유를 밝혀야 한다."""
    o = _outcome(financials=None, news_items=[], disclosure_count=0, note_created=False)
    assert "노트를 작성하지 않았습니다" in _joined(o)
    assert "가드레일 3" in _joined(o)
    assert o["note_created"] is False


def test_failed_tools_is_serialisable():
    """set은 JSON으로 못 나간다 — SSE에 실리므로 정렬된 list여야 한다."""
    o = _outcome(failed_tools={"b", "a"})
    assert o["failed_tools"] == ["a", "b"]


def test_a5_input_states_what_is_missing():
    """부분 데이터로 노트를 쓸 때, 없는 건 없다고 알려줘야 지어내지 않는다(가드레일 3)."""
    prompt = _a5_input("네이버", "035420", None, NEWS, {})
    assert "확보하지 못한 데이터" in prompt
    assert "재무 핵심수치(A2)를 확보하지 못했다" in prompt
    assert "추측으로 채우지 말고" in prompt

    prompt = _a5_input("네이버", "035420", FIN, [], {})
    assert "관련 뉴스(A4)가 조회되지 않았다" in prompt


def test_a5_input_stays_quiet_when_nothing_is_missing():
    """다 있을 때는 없는 얘기를 꺼내지 않는다 — 불필요한 지시가 문체를 흔든다."""
    prompt = _a5_input("네이버", "035420", FIN, NEWS, {})
    assert "확보하지 못한 데이터" not in prompt


def test_stream_turns_exceptions_into_events():
    """실행 중 예외가 나도 스트림이 조용히 끊기지 않고 run_error + done이 도착해야 한다.

    화면은 이 두 이벤트로 종료 상태에 도달한다 — 안 오면 "생성 중…"에서 멈춘다.
    DB도 크레딧도 쓰지 않는다: query()를 터지게 갈아끼우고 SSE 바이트만 본다.
    """
    import asyncio
    import logging

    from backend import main

    original = main.query

    def boom(*args, **kwargs):
        raise RuntimeError("의도적으로 터뜨림")

    main.query = boom
    # 일부러 터뜨리는 것이라 스택트레이스가 찍히면 테스트가 깨진 것처럼 보인다.
    main.logger.setLevel(logging.CRITICAL)
    try:
        response = asyncio.run(main.research_stream(stock_code="005930"))

        async def drain():
            return [chunk async for chunk in response.body_iterator]

        body = "".join(asyncio.run(drain()))
    finally:
        main.query = original
        main.logger.setLevel(logging.NOTSET)

    assert "event: run_error" in body, body
    assert "event: done" in body, body
    # 이벤트명이 "error"면 EventSource의 연결 오류 핸들러와 겹쳐 구분이 안 된다
    assert "event: error\n" not in body, body
    # 예외 문자열을 그대로 흘리지 않는다(내부 경로·키가 섞일 수 있다)
    assert "의도적으로 터뜨림" not in body, body
    assert "RuntimeError" in body


def test_stream_rejects_bad_stock_code():
    """6자리 숫자가 아니면 스트림을 열기 전에 400으로 막는다."""
    import asyncio

    from fastapi import HTTPException

    from backend import main

    for bad in ("abc", "12345", "0059301"):
        try:
            asyncio.run(main.research_stream(stock_code=bad))
        except HTTPException as e:
            assert e.status_code == 400
        else:
            raise AssertionError(f"{bad!r}가 통과했다")


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
