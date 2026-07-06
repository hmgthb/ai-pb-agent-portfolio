import json
import re
from pathlib import Path

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ResultMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    query,
)
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

REPO_ROOT = Path(__file__).resolve().parents[1]

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok", "message": "hello"}


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/api/research/stream")
async def research_stream(stock_code: str = Query(...)):
    if not re.fullmatch(r"\d{6}", stock_code):
        raise HTTPException(400, "stock_code는 6자리 숫자여야 합니다.")

    async def event_gen():
        options = ClaudeAgentOptions(
            cwd=str(REPO_ROOT),
            system_prompt=(
                "너는 메인 오케스트레이터(O)다. 종목의 재무 핵심수치 요약이 필요하면 a2에게 위임해라."
            ),
        )
        prompt = f"종목코드 {stock_code}의 최신 사업연도 매출액·영업이익 핵심수치를 요약해줘."
        tool_names: dict[str, str] = {}

        async for message in query(prompt=prompt, options=options):
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock):
                        yield _sse("text", {"text": block.text})
                    elif isinstance(block, ToolUseBlock):
                        tool_names[block.id] = block.name
                        yield _sse("tool_use", {"name": block.name})
            elif isinstance(message, UserMessage):
                content = message.content if isinstance(message.content, list) else []
                for block in content:
                    if isinstance(block, ToolResultBlock) and not block.is_error:
                        if tool_names.get(block.tool_use_id) == "mcp__dart__dart_parse":
                            payload = block.content
                            if isinstance(payload, list) and payload:
                                try:
                                    figures = json.loads(payload[0]["text"])
                                    yield _sse("card", figures)
                                except (KeyError, json.JSONDecodeError):
                                    pass
            elif isinstance(message, ResultMessage):
                yield _sse("done", {})

    return StreamingResponse(event_gen(), media_type="text/event-stream")
