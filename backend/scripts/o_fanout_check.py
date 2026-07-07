"""O가 A2(실적)와 A4(뉴스)를 병렬로 위임(팬아웃)하는지 검증.

각 AssistantMessage의 parent_tool_use_id로 어느 서브에이전트 실행에 속하는 메시지인지 추적한다.
순차 실행이면 한쪽 서브에이전트의 메시지가 전부 끝난 뒤에야 다른 쪽이 시작되지만,
병렬(팬아웃)이면 두 서브에이전트의 메시지가 스트림에서 서로 섞여(interleave) 도착한다.
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
            "너는 메인 오케스트레이터(O)다. 종목 관련 재무 핵심수치가 필요하면 a2에게, "
            "관련 뉴스가 필요하면 a4에게 위임해라. 둘 다 필요하면 한 메시지에서 "
            "두 서브에이전트를 동시에(병렬로) 위임해라."
        ),
    )

    prompt = "삼성전자(종목코드 005930)의 2024년 실적 핵심수치와 최근 관련 뉴스를 둘 다 알려줘."

    delegated_to = set()
    subagent_of_tool_use_id: dict[str, str] = {}
    # parent_tool_use_id 순서대로 기록 -> a2/a4가 서로 섞여 오는지(interleave) 확인
    parent_sequence: list[str] = []

    async for message in query(prompt=prompt, options=options):
        if isinstance(message, AssistantMessage):
            if message.parent_tool_use_id in subagent_of_tool_use_id:
                parent_sequence.append(subagent_of_tool_use_id[message.parent_tool_use_id])

            for block in message.content:
                if isinstance(block, TextBlock):
                    print(f"[Assistant/Text] {block.text}")
                elif isinstance(block, ToolUseBlock):
                    print(f"[Assistant/ToolUse] name={block.name} input={block.input}")
                    if block.name == "Agent":
                        subagent = block.input.get("subagent_type")
                        delegated_to.add(subagent)
                        subagent_of_tool_use_id[block.id] = subagent
        elif isinstance(message, ResultMessage):
            print(f"[ResultMessage] is_error={message.is_error} turns={message.num_turns}")

    # 전환이 2번 이상이면 "a2 전부 -> a4 전부" 식 순차가 아니라 서로 핑퐁하며 섞여 온 것 -> 병렬 실행
    transitions = sum(1 for i in range(1, len(parent_sequence)) if parent_sequence[i] != parent_sequence[i - 1])
    fanned_out = transitions > 1

    print(f"\nO가 위임한 서브에이전트: {delegated_to}")
    print(f"A2에게 위임했는가: {'a2' in delegated_to}")
    print(f"A4에게 위임했는가: {'a4' in delegated_to}")
    print(f"서브에이전트 메시지 도착 순서: {parent_sequence}")
    print(f"두 서브에이전트가 인터리브(병렬)로 실행됐는가: {fanned_out}")


if __name__ == "__main__":
    asyncio.run(main())
