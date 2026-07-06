"""Claude API tool use(strict JSON) 최소 예제.

strict: true + additionalProperties: false 로 tool_use.input이 스키마를
정확히 만족하도록 강제한다. ANTHROPIC_API_KEY가 .env에 있어야 실행된다.
"""

import os

from anthropic import Anthropic
from dotenv import load_dotenv

load_dotenv()

client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])

response = client.messages.create(
    model="claude-haiku-4-5",
    max_tokens=1024,
    messages=[
        {"role": "user", "content": "삼성전자 종목 하나에 대한 조회를 요청하는 형태로 도구를 호출해줘."}
    ],
    tools=[
        {
            "name": "lookup_stock",
            "description": "종목코드로 종목 정보를 조회한다.",
            "strict": True,
            "input_schema": {
                "type": "object",
                "properties": {
                    "stock_code": {"type": "string", "description": "6자리 종목코드"},
                },
                "required": ["stock_code"],
                "additionalProperties": False,
            },
        }
    ],
)

for block in response.content:
    if block.type == "tool_use":
        print(f"tool_use: name={block.name} input={block.input}")
    elif block.type == "text":
        print(f"text: {block.text}")
