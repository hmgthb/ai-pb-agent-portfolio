"""네이버 뉴스 검색 오픈API 첫 호출 확인 스크립트.

종목명으로 뉴스를 검색해 제목·링크·발행시각을 출력한다.
"""

import os

import requests
from dotenv import load_dotenv

load_dotenv()

CLIENT_ID = os.environ["NAVER_CLIENT_ID"]
CLIENT_SECRET = os.environ["NAVER_CLIENT_SECRET"]
TARGET_QUERY = "삼성전자"


def search_news(query: str, display: int = 10) -> list[dict]:
    resp = requests.get(
        "https://openapi.naver.com/v1/search/news.json",
        headers={
            "X-Naver-Client-Id": CLIENT_ID,
            "X-Naver-Client-Secret": CLIENT_SECRET,
        },
        params={"query": query, "display": display, "sort": "date"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json().get("items", [])


if __name__ == "__main__":
    items = search_news(TARGET_QUERY)
    print(f"'{TARGET_QUERY}' 뉴스 {len(items)}건:")
    for item in items:
        title = item["title"].replace("<b>", "").replace("</b>", "")
        print(f"- [{item['pubDate']}] {title} ({item['originallink'] or item['link']})")

    if not items:
        print("(뉴스 없음 — 쿼리를 확인)")
