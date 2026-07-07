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


def _parse_tool_result(payload):
    """MCP 도구 반환값을 파싱한다.

    단일 dict를 반환하는 도구(dart_parse 등)는 content가 [{"type":"text","text":"<json dict>"}]로,
    list를 반환하는 도구(dart_search/news_search 등)는 content가 '{"result": [...]}' 형태의
    JSON 문자열로 온다 — SDK가 반환 타입에 따라 다른 모양으로 감싸기 때문에 둘 다 처리한다.
    """
    if isinstance(payload, str):
        data = json.loads(payload)
        return data.get("result", data)
    if isinstance(payload, list) and payload:
        return json.loads(payload[0]["text"])
    return None


@app.get("/api/research/stream")
async def research_stream(stock_code: str = Query(...)):
    if not re.fullmatch(r"\d{6}", stock_code):
        raise HTTPException(400, "stock_code는 6자리 숫자여야 합니다.")

    async def event_gen():
        options = ClaudeAgentOptions(
            cwd=str(REPO_ROOT),
            system_prompt=(
                "너는 메인 오케스트레이터(O)다. 종목의 재무 핵심수치가 필요하면 a2에게, "
                "관련 뉴스가 필요하면 a4에게 위임해라. 한 메시지에서 두 서브에이전트를 동시에(병렬로) 위임해라."
            ),
        )
        prompt = (
            f"종목코드 {stock_code}의 최신 사업연도 매출액·영업이익 핵심수치와 최근 관련 뉴스를 둘 다 알려줘."
        )
        tool_names: dict[str, str] = {}
        agent_of_tool_use_id: dict[str, str] = {}
        PARALLEL_GROUP = "a2+a4"

        async for message in query(prompt=prompt, options=options):
            if isinstance(message, AssistantMessage):
                agent = agent_of_tool_use_id.get(message.parent_tool_use_id, "O")
                for block in message.content:
                    if isinstance(block, TextBlock):
                        yield _sse("text", {"agent": agent, "text": block.text})
                    elif isinstance(block, ToolUseBlock):
                        tool_names[block.id] = block.name
                        if block.name == "Agent":
                            subagent = block.input.get("subagent_type")
                            agent_of_tool_use_id[block.id] = subagent
                            yield _sse(
                                "progress",
                                {"agent": subagent, "step": "delegated", "status": "started", "parallel_group": PARALLEL_GROUP},
                            )
                        else:
                            yield _sse(
                                "progress",
                                {"agent": agent, "step": block.name, "status": "running", "parallel_group": PARALLEL_GROUP},
                            )
            elif isinstance(message, UserMessage):
                agent = agent_of_tool_use_id.get(message.parent_tool_use_id, "O")
                content = message.content if isinstance(message.content, list) else []
                for block in content:
                    if not (isinstance(block, ToolResultBlock) and not block.is_error):
                        continue
                    name = tool_names.get(block.tool_use_id)
                    # "Agent" 도구의 결과는 완료가 아니라 비동기 디스패치 ack일 뿐이라 진행 이벤트로 안 남긴다.
                    if name is None or name == "Agent":
                        continue
                    yield _sse(
                        "progress",
                        {"agent": agent, "step": name, "status": "completed", "parallel_group": PARALLEL_GROUP},
                    )
                    try:
                        parsed = _parse_tool_result(block.content)
                    except (KeyError, json.JSONDecodeError):
                        continue
                    if parsed is None:
                        continue
                    if name == "mcp__dart__dart_parse":
                        yield _sse("card", {"type": "financials", "agent": agent, **parsed})
                    elif name == "mcp__news__news_search":
                        yield _sse("card", {"type": "news", "agent": agent, "items": parsed})
            elif isinstance(message, ResultMessage):
                yield _sse("done", {})

    return StreamingResponse(event_gen(), media_type="text/event-stream")
