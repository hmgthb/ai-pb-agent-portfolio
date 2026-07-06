"""O가 A1에게 위임 -> A1이 실제로 DART MCP 도구를 호출하는지 검증.

위임 시 서브에이전트의 mcp__dart__* 툴 호출이 메인 query() 스트림에 그대로
드러나므로, Agent 위임 여부와 dart 툴 호출 여부를 스트림에서 직접 확인한다.
"""

import asyncio
from pathlib import Path

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
    query,
)

REPO_ROOT = Path(__file__).resolve().parents[2]


async def main() -> None:
    options = ClaudeAgentOptions(
        cwd=str(REPO_ROOT),
        system_prompt="너는 메인 오케스트레이터(O)다. 종목 관련 공시·재무 조회가 필요하면 a1 서브에이전트에게 위임해라.",
    )

    prompt = "삼성전자(종목코드 005930)의 최근 공시를 a1에게 위임해서 조회해와줘."

    delegated_to_a1 = False
    called_dart_tool = False

    async for message in query(prompt=prompt, options=options):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    print(f"[Assistant/Text] {block.text}")
                elif isinstance(block, ToolUseBlock):
                    print(f"[Assistant/ToolUse] name={block.name} input={block.input}")
                    if block.name == "Agent" and block.input.get("subagent_type") == "a1":
                        delegated_to_a1 = True
                    if block.name.startswith("mcp__dart__"):
                        called_dart_tool = True
        elif isinstance(message, ResultMessage):
            print(f"[ResultMessage] is_error={message.is_error} turns={message.num_turns}")

    print(f"\nO가 a1에게 위임했는가: {delegated_to_a1}")
    print(f"dart MCP 도구가 실제로 호출됐는가: {called_dart_tool}")


if __name__ == "__main__":
    asyncio.run(main())
