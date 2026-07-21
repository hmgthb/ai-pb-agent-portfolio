"""`background: false` 프론트매터가 서브에이전트 위임을 동기 실행으로 만드는지 검증.

HANDOFF §1 참고: `Agent` 도구가 비동기라 결과가 "Async agent launched successfully"로
즉시 돌아오고, 도구를 호출하지 않는 서브에이전트(a5)는 O가 턴을 끝낼 때 잘린다.

여기서는 a5와 조건이 같은(도구 없음·텍스트만) hello-subagent를 haiku로 돌려 싸게 판정한다.
판정 기준은 **Agent 도구의 ToolResultBlock 내용**이다:
  - "Async agent launched successfully" -> 여전히 비동기 (background:false 무효)
  - 서브에이전트가 쓴 실제 문장     -> 동기 실행 (background:false 유효)
"""

import asyncio
from pathlib import Path

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    StreamEvent,
    ResultMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    query,
)

REPO_ROOT = Path(__file__).resolve().parents[2]

ASYNC_MARKER = "Async agent launched successfully"


def _result_text(block: ToolResultBlock) -> str:
    content = block.content
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )
    return ""


async def main() -> None:
    options = ClaudeAgentOptions(
        cwd=str(REPO_ROOT),
        include_partial_messages=True,
        system_prompt=(
            "너는 메인 오케스트레이터(O)다. 인사 요청은 hello-subagent에게 위임해라. "
            "서브에이전트가 무엇을 썼는지 추측해서 옮기지 마라."
        ),
    )

    prompt = "hello-subagent에게 위임해서 인사를 받아와줘."

    agent_tool_use_ids: set[str] = set()
    verdict: str | None = None
    payload = ""

    stream_parents: dict[str | None, int] = {}

    async for message in query(prompt=prompt, options=options):
        if isinstance(message, StreamEvent):
            # 동기 위임에서도 서브에이전트 토큰이 parent_tool_use_id를 달고 흐르는지 센다.
            key = message.parent_tool_use_id
            stream_parents[key] = stream_parents.get(key, 0) + 1
            continue
        if isinstance(message, AssistantMessage):
            print(f"[AssistantMessage] parent_tool_use_id={message.parent_tool_use_id}")
            for block in message.content:
                if isinstance(block, ToolUseBlock) and block.name == "Agent":
                    agent_tool_use_ids.add(block.id)
                    print(f"[ToolUse] Agent subagent_type={block.input.get('subagent_type')}")
                elif isinstance(block, TextBlock):
                    print(f"[Text] {block.text.strip()[:200]}")
        elif isinstance(message, UserMessage):
            content = message.content
            if isinstance(content, list):
                for block in content:
                    if (
                        isinstance(block, ToolResultBlock)
                        and block.tool_use_id in agent_tool_use_ids
                    ):
                        payload = _result_text(block)
                        verdict = "async" if ASYNC_MARKER in payload else "sync"
                        print(f"[Agent ToolResult] is_error={block.is_error}")
                        print(f"  {payload.strip()[:400]}")
        elif isinstance(message, ResultMessage):
            print(f"[Result] is_error={message.is_error} turns={message.num_turns}")

    print()
    print(f"StreamEvent parent_tool_use_id 분포: {stream_parents}")
    if verdict is None:
        print("판정 불가: Agent 도구 결과를 스트림에서 못 찾음 (위임 자체가 안 일어났을 수 있음)")
    elif verdict == "async":
        print("❌ background:false 무효 — 여전히 비동기다. HANDOFF §1의 2안(백엔드 직접 실행)으로 간다.")
    else:
        print("✅ background:false 유효 — 위임이 동기로 돌아온다. a5.md에도 적용 가능.")


if __name__ == "__main__":
    asyncio.run(main())
