"""Claude API 스트리밍 최소 예제.

A5(노트초안)처럼 긴 출력을 다룰 때는 타임아웃 방지를 위해 스트리밍이 필수다.
ANTHROPIC_API_KEY가 .env에 있어야 실행된다.
"""

import os

from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv()

client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

with client.messages.stream(
    model="claude-haiku-4-5",
    max_tokens=256,
    messages=[{"role": "user", "content": "삼성전자에 대해 한 문장으로 설명해줘."}],
) as stream:
    for text in stream.text_stream:
        print(text, end="", flush=True)
    print()
