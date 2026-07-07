"""news MCP 서버가 실제로 news_search 도구를 노출하는지 클라이언트로 직접 확인."""

import asyncio

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main() -> None:
    params = StdioServerParameters(
        command="backend/.venv/bin/python",
        args=["backend/mcp_servers/news_server.py"],
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = await session.list_tools()
            print("노출된 도구:", [t.name for t in tools.tools])

            result = await session.call_tool("news_search", {"query": "삼성전자", "display": 5})
            print(f"\n[news_search] content 블록 {len(result.content)}개")
            print(result.content[0].text)


if __name__ == "__main__":
    asyncio.run(main())
