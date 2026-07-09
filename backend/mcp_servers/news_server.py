"""네이버 뉴스 검색 오픈API를 감싼 MCP 서버.

- news_search: 종목명/키워드로 최근 뉴스 목록 검색
"""

import html
import os

import requests
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP

load_dotenv()

CLIENT_ID = os.environ["NAVER_CLIENT_ID"]
CLIENT_SECRET = os.environ["NAVER_CLIENT_SECRET"]
mcp = FastMCP("news")


@mcp.tool()
def news_search(query: str, display: int = 10) -> list[dict]:
    """종목명/키워드로 관련도순 뉴스를 검색한다. 예: "삼성전자".

    각 항목의 link(원문 링크)와 pub_date(발행시각)를 출처로 사용한다.
    """
    resp = requests.get(
        "https://openapi.naver.com/v1/search/news.json",
        headers={
            "X-Naver-Client-Id": CLIENT_ID,
            "X-Naver-Client-Secret": CLIENT_SECRET,
        },
        # sort=sim(관련도순) — date(최신순)는 검색어를 스치듯 언급만 한 기사도 최상단에 섞여 나옴
        params={"query": query, "display": display, "sort": "sim"},
        timeout=30,
    )
    resp.raise_for_status()

    return [
        {
            "title": html.unescape(item["title"].replace("<b>", "").replace("</b>", "")),
            "description": html.unescape(item["description"].replace("<b>", "").replace("</b>", "")),
            "link": item["originallink"] or item["link"],
            "pub_date": item["pubDate"],
        }
        for item in resp.json().get("items", [])
    ]


if __name__ == "__main__":
    mcp.run(transport="stdio")
