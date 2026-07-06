"""Agent SDK hello world: 메인 에이전트 -> hello-subagent 위임 확인.

서브에이전트는 레포 루트 .claude/agents/hello-subagent.md 에 정의되어 있다.
실행하면 위임(SubagentStart/Stop) 여부를 메시지 타입 로그로 확인할 수 있다.
"""

import asyncio
from pathlib import Path

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ToolUseBlock,
    query,
)

REPO_ROOT = Path(__file__).resolve().parents[2]


async def main() -> None:
    options = ClaudeAgentOptions(
        cwd=str(REPO_ROOT),
        system_prompt="너는 메인 오케스트레이터다. 사용자 요청을 hello-subagent 서브에이전트에게 위임해라.",
    )

    prompt = "hello-subagent에게 위임해서 인사를 받아와줘."

    async for message in query(prompt=prompt, options=options):
        kind = type(message).__name__

        if isinstance(message, SystemMessage):
            print(f"[SystemMessage] subtype={message.subtype}")
        elif isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    print(f"[Assistant/Text] {block.text}")
                elif isinstance(block, ToolUseBlock):
                    print(f"[Assistant/ToolUse] name={block.name} input={block.input}")
        elif isinstance(message, ResultMessage):
            print(f"[ResultMessage] is_error={message.is_error} turns={message.num_turns}")
        else:
            print(f"[{kind}] {message}")


if __name__ == "__main__":
    asyncio.run(main())
