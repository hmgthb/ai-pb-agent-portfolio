"""krx MCP 서버가 실제로 도구를 노출하는지 클라이언트로 직접 확인."""

import asyncio

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main() -> None:
    params = StdioServerParameters(
        command="backend/.venv/bin/python",
        args=["backend/mcp_servers/krx_server.py"],
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            tools = await session.list_tools()
            print("노출된 도구:", [t.name for t in tools.tools])

            result = await session.call_tool("krx_quote", {"stock_code": "005930"})
            print("\n[krx_quote 005930]\n", result.content[0].text)

            # 없는 종목코드는 조용히 빈 값을 주지 않고 오류로 드러나야 한다.
            bad = await session.call_tool("krx_quote", {"stock_code": "999999"})
            print("\n[krx_quote 999999] isError =", bad.isError)
            print(bad.content[0].text[:160])


if __name__ == "__main__":
    asyncio.run(main())
