"""O가 A1(공시 수집)과 A2(재무수치 요약) 둘 다에게 위임하는지 검증.

A1/A2가 실제로 dart MCP 도구를 호출하는 것까지 메인 query() 스트림에서 확인한다.
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
        system_prompt=(
            "너는 메인 오케스트레이터(O)다. 종목의 최근 공시가 필요하면 a1에게, "
            "재무 핵심수치 요약이 필요하면 a2에게 위임해라. 둘 다 필요하면 둘 다 위임해라."
        ),
    )

    prompt = "삼성전자(종목코드 005930)의 최근 공시를 확인하고, 2024년 매출액·영업이익 핵심수치도 요약해줘."

    delegated_to = set()
    called_tools = set()

    async for message in query(prompt=prompt, options=options):
        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    print(f"[Assistant/Text] {block.text}")
                elif isinstance(block, ToolUseBlock):
                    print(f"[Assistant/ToolUse] name={block.name} input={block.input}")
                    if block.name == "Agent":
                        delegated_to.add(block.input.get("subagent_type"))
                    if block.name.startswith("mcp__dart__"):
                        called_tools.add(block.name)
        elif isinstance(message, ResultMessage):
            print(f"[ResultMessage] is_error={message.is_error} turns={message.num_turns}")

    print(f"\nO가 위임한 서브에이전트: {delegated_to}")
    print(f"호출된 dart MCP 도구: {called_tools}")
    print(f"A1에게 위임했는가: {'a1' in delegated_to}")
    print(f"A2에게 위임했는가: {'a2' in delegated_to}")


if __name__ == "__main__":
    asyncio.run(main())
