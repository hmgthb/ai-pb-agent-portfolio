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
                "너는 메인 오케스트레이터(O)다. 종목코드가 실제로 어느 법인인지 절대 네 지식만으로 "
                "단정하지 마라 — 그룹 계열사는 이름이 비슷해도 종목코드마다 별개 법인이라 추측이 "
                "쉽게 틀린다(예: 086520 에코프로 ≠ 247540 에코프로비엠).\n\n"
                "**1단계 — 법인 확인(항상 먼저, 필수):** 다른 무엇도 하기 전에 a1에게 위임해서 "
                "\"종목코드 {코드}의 법인명을 DART로 확인해줘\"라고만 요청해라. a1이 실제 DART "
                "조회로 반환한 corp_name을 받을 때까지 a2·a4에게는 위임하지 마라.\n\n"
                "**2단계 — 병렬 위임:** a1이 확인해준 법인명을 받은 후에만, 그 법인명을 위임 "
                "메시지에 명시해서 a2(재무 핵심수치)·a4(관련 뉴스)에게 **한 메시지에서 동시에(병렬로)** "
                "위임해라. a4는 뉴스 검색 도구만 있고 DART 조회 도구가 없으므로, 위임 메시지에 "
                "법인명을 반드시 적어줘야 a4가 종목코드만 보고 회사명을 잘못 추측하지 않는다.\n\n"
                "**법인명이 네 예상과 달라도:** a1이 확인한 법인명을 그대로 따르고, 종목코드는 "
                "사용자가 입력한 그대로 유지해라 — 네가 예상한 회사를 찾겠다고 다른 종목코드로 "
                "바꿔치기하지 마라.\n\n"
                "a2·a4 결과를 모두 받은 후 마지막으로 종합할 때는(이 단계에 '3단계' 같은 "
                "번호나 이 지시문 자체를 리포트 제목으로 쓰지 마라): 재무제표 표나 뉴스 목록은 "
                "이미 화면에 별도 카드로 그대로 표시되므로 절대 다시 나열하지 마라 — 표, 불릿 "
                "목록, 링크 재인용 금지. 그 수치와 뉴스가 실제로 무엇을 의미하는지만 짧은 "
                "산문(prose)으로 분석해라: 매출·영업이익 흐름을 어떻게 해석해야 하는지, 뉴스가 "
                "그 실적과 어떤 관계가 있는지, 주의해서 볼 지점은 무엇인지.\n\n"
                "**최종 종합 답변은 분석 본문으로 바로 시작해라.** \"두 결과 모두 받았습니다\", "
                "\"종합 분석입니다\" 같은 자기서술·인사말·전환 문장을 앞에 붙이지 마라. 법인명을 "
                "제목(헤딩)으로 반복해서 쓰지도 마라 — 화면에 이미 별도로 표시된다."
            ),
        )
        prompt = (
            f"종목코드 {stock_code}의 최신 사업연도 매출액·영업이익 핵심수치와 최근 관련 뉴스를 둘 다 알려줘."
        )
        tool_names: dict[str, str] = {}
        agent_of_tool_use_id: dict[str, str] = {}
        agent_errors: set[str] = set()
        # dart_fetch는 viewer_url만 주고 접수일(rcept_dt)은 안 준다 — dart_search 결과에서
        # rcept_no -> rcept_dt를 미리 모아뒀다가 dart_fetch 성공 시 붙여서 출처로 내보낸다.
        rcept_dt_by_no: dict[str, str] = {}
        # dart_parse 실패는 CFS 없음 등 정상적인 재시도 흐름이라 출처와 무관하다 —
        # 출처(원문 링크) 자체를 찾는 도구가 실패했을 때만 카드에 미확인 배지를 붙인다.
        CITATION_TOOLS = {"mcp__dart__dart_search", "mcp__dart__dart_fetch"}
        # a1은 법인 확인을 위해 항상 혼자(순차) 위임되고, a2·a4는 항상 함께(병렬) 위임된다 —
        # 이 앱의 서브에이전트 구성이 고정돼 있어 정적으로 매핑한다. SDK 스트림에서는 같이
        # 위임된 도구호출도 서로 다른 AssistantMessage로 쪼개져 오므로, "한 메시지 안에 몇 개
        # 있는지"로 동적 판별은 불가능하다.
        PARALLEL_AGENTS = {"a2", "a4"}

        def _group_for(subagent: str) -> str | None:
            return "a2+a4" if subagent in PARALLEL_AGENTS else None

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
                                {"agent": subagent, "step": "delegated", "status": "started", "parallel_group": _group_for(subagent)},
                            )
                        else:
                            yield _sse(
                                "progress",
                                {"agent": agent, "step": block.name, "status": "running", "parallel_group": _group_for(agent)},
                            )
            elif isinstance(message, UserMessage):
                agent = agent_of_tool_use_id.get(message.parent_tool_use_id, "O")
                group_name = _group_for(agent)
                content = message.content if isinstance(message.content, list) else []
                for block in content:
                    if not isinstance(block, ToolResultBlock):
                        continue
                    name = tool_names.get(block.tool_use_id)
                    # "Agent" 도구의 결과는 완료가 아니라 비동기 디스패치 ack일 뿐이라 진행 이벤트로 안 남긴다.
                    if name is None or name == "Agent":
                        continue
                    if block.is_error:
                        if name in CITATION_TOOLS:
                            agent_errors.add(agent)
                        yield _sse(
                            "progress",
                            {"agent": agent, "step": name, "status": "failed", "parallel_group": group_name},
                        )
                        continue
                    yield _sse(
                        "progress",
                        {"agent": agent, "step": name, "status": "completed", "parallel_group": group_name},
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
                    elif name == "mcp__dart__dart_search":
                        for item in parsed:
                            rcept_dt_by_no[item["rcept_no"]] = item["rcept_dt"]
                    elif name == "mcp__dart__dart_fetch":
                        yield _sse(
                            "source",
                            {
                                "agent": agent,
                                "rcept_no": parsed["rcept_no"],
                                "viewer_url": parsed["viewer_url"],
                                "rcept_dt": rcept_dt_by_no.get(parsed["rcept_no"]),
                            },
                        )
            elif isinstance(message, ResultMessage):
                yield _sse("done", {"unsourced_agents": sorted(agent_errors)})

    return StreamingResponse(event_gen(), media_type="text/event-stream")
