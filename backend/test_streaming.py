"""토큰 스트리밍 델타 추출 자체 점검.

크레딧 없이도 돌아간다 — 실제 SDK 호출 없이, Anthropic 원시 스트림 이벤트 모양만 재현해
_text_delta가 노트 본문 조각만 골라내는지 확인한다.

실행: backend/.venv/bin/python -m backend.test_streaming
"""

from backend.main import _text_delta


def test_text_delta():
    # 본문 텍스트 조각 — 유일하게 통과해야 하는 것
    assert _text_delta(
        {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "매출액은 "}}
    ) == "매출액은 "

    # 도구 입력(JSON) 델타는 노트 본문이 아니다 — 흘리면 화면에 JSON 파편이 섞인다
    assert _text_delta(
        {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": '{"a"'}}
    ) is None

    # 본문과 무관한 프레임들
    for event in (
        {"type": "message_start", "message": {}},
        {"type": "content_block_start", "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_stop", "index": 0},
        {"type": "message_delta", "delta": {"stop_reason": "end_turn"}},
        {"type": "ping"},
        {},
    ):
        assert _text_delta(event) is None, event

    # delta 키가 아예 없거나 None이어도 죽지 않아야 한다
    assert _text_delta({"type": "content_block_delta"}) is None
    assert _text_delta({"type": "content_block_delta", "delta": None}) is None

    # 빈 문자열은 None이 아니라 ""로 온다 — 호출부에서 falsy로 걸러진다
    assert _text_delta(
        {"type": "content_block_delta", "delta": {"type": "text_delta", "text": ""}}
    ) == ""


if __name__ == "__main__":
    test_text_delta()
    print("ok")
