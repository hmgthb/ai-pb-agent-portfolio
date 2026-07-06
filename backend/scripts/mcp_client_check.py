"""dart MCP 서버가 실제로 도구를 노출하는지 클라이언트로 직접 확인."""

import asyncio

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main() -> None:
    params = StdioServerParameters(
        command="backend/.venv/bin/python",
        args=["backend/mcp_servers/dart_server.py"],
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = await session.list_tools()
            print("노출된 도구:", [t.name for t in tools.tools])

            search_result = await session.call_tool(
                "dart_search", {"stock_code": "005930", "days": 90}
            )
            print(f"\n[dart_search] content 블록 {len(search_result.content)}개 (공시 건수)")
            print(search_result.content[0].text)

            import json

            first_rcept_no = json.loads(search_result.content[0].text)["rcept_no"]

            fetch_result = await session.call_tool(
                "dart_fetch", {"rcept_no": first_rcept_no}
            )
            print(f"\n[dart_fetch] rcept_no={first_rcept_no} 결과:\n", fetch_result.content[0].text)

            parse_result = await session.call_tool(
                "dart_parse",
                {"stock_code": "005930", "bsns_year": "2024", "reprt_code": "11011", "fs_div": "CFS"},
            )
            print("\n[dart_parse] 결과:\n", parse_result.content[0].text)


if __name__ == "__main__":
    asyncio.run(main())
