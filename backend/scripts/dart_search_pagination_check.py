"""dart_search 페이지네이션 확인.

삼성전자(005930)는 공시가 잦아서 100건(1페이지)만으로는 2024년도 사업보고서
(2025년 3월 접수 추정)까지 못 찾는다 — 여러 페이지를 이어붙였는지 검증한다.
"""

import asyncio

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def main() -> None:
    import json

    params = StdioServerParameters(
        command="backend/.venv/bin/python",
        args=["backend/mcp_servers/dart_server.py"],
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            # 1) 필터 없이 넓게 검색 -> 1페이지(100건) 넘겨서 여러 페이지를 모아왔는지 확인
            result = await session.call_tool("dart_search", {"stock_code": "005930", "days": 500})
            items = [json.loads(block.text) for block in result.content]
            print(f"[필터 없음] 총 {len(items)}건 (100건 넘으면 페이지네이션 동작 증거)")
            assert len(items) > 100, "1페이지(100건)를 넘겨서 가져와야 페이지네이션이 동작한 것"

            # 2) pblntf_ty="A"(정기공시)로 좁혀서 검색 -> 2024년도 사업보고서를 정확히 찾는지 확인
            result = await session.call_tool(
                "dart_search", {"stock_code": "005930", "days": 500, "pblntf_ty": "A"}
            )
            filtered = [json.loads(block.text) for block in result.content]
            print(f"\n[pblntf_ty=A] 총 {len(filtered)}건:")
            for d in filtered:
                print(f"  - [{d['rcept_dt']}] {d['report_nm']} (rcept_no={d['rcept_no']})")

            found_2024 = any("2024" in d["report_nm"] and "사업보고서" in d["report_nm"] for d in filtered)
            assert found_2024, "정기공시 필터로도 2024년도 사업보고서를 못 찾음"

            print("\nPASS: 정기공시 필터로 2024년도 사업보고서를 정확히 찾았다.")


if __name__ == "__main__":
    asyncio.run(main())
