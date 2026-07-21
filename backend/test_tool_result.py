"""도구 결과 실패 판정 자체 점검 (크레딧·네트워크 불필요).

실행: backend/.venv/bin/python -m backend.test_tool_result
"""

from backend.main import _tool_failed


class Block:
    """ToolResultBlock 최소 대역 — is_error와 content만 본다."""

    def __init__(self, content, is_error=False):
        self.content = content
        self.is_error = is_error


def test_explicit_error():
    assert _tool_failed(Block("무엇이든", is_error=True))


def test_token_limit_is_a_failure_even_when_not_flagged():
    """SDK가 토큰 한도 초과를 정상 결과처럼 돌려주는 케이스 — 실제로 a1에서 발생했다.
    여기가 깨지면 실패한 도구 호출이 타임라인에 'completed'로 찍혀 원인을 못 찾는다."""
    msg = (
        "Error: result (64,169 characters) exceeds maximum allowed tokens. "
        "Output has been saved to /Users/x/.claude/projects/abc.json"
    )
    assert _tool_failed(Block(msg, is_error=False))
    # 리스트로 감싸 오는 형태도 잡아야 한다
    assert _tool_failed(Block([{"type": "text", "text": msg}], is_error=False))


def test_normal_result_passes():
    assert not _tool_failed(Block('{"result": [{"rcept_no": "1"}]}'))
    assert not _tool_failed(Block([{"type": "text", "text": '{"corp_name": "삼성전자"}'}]))
    # "error"라는 단어가 데이터에 들어 있다고 실패로 보면 안 된다
    assert not _tool_failed(Block('{"title": "error 처리 개선 공시"}'))


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("ok")
