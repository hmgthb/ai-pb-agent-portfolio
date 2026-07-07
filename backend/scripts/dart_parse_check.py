"""dart_parse가 회사별로 다른 손익계산서 신고 방식(IS vs CIS)과
계정명 접미사("영업이익(손실)" 등)를 모두 처리하는지 확인한다.

- 삼성전자: sj_div="IS", 계정명 정확히 "매출액"/"영업이익"
- SK하이닉스: sj_div="CIS", 계정명 "영업이익(손실)"처럼 접미사 있음
"""

import asyncio
import json

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

CASES = [
    ("005930", "삼성전자"),
    ("000660", "SK하이닉스"),
]


async def main() -> None:
    params = StdioServerParameters(
        command="backend/.venv/bin/python",
        args=["backend/mcp_servers/dart_server.py"],
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            for stock_code, name in CASES:
                result = await session.call_tool(
                    "dart_parse",
                    {"stock_code": stock_code, "bsns_year": "2024", "reprt_code": "11011", "fs_div": "CFS"},
                )
                data = json.loads(result.content[0].text)
                print(f"{name}({stock_code}): {data['figures']}")
                assert "매출액" in data["figures"], f"{name}: 매출액 못 찾음"
                assert "영업이익" in data["figures"], f"{name}: 영업이익 못 찾음"

            print("\nPASS: 두 회사 모두 매출액·영업이익 추출 성공.")


if __name__ == "__main__":
    asyncio.run(main())
