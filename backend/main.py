import json
import re
from contextlib import asynccontextmanager
from pathlib import Path

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    HookMatcher,
    PermissionResultAllow,
    PermissionResultDeny,
    ResultMessage,
    StreamEvent,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    UserMessage,
    query,
)
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from backend import citations, compliance, db

REPO_ROOT = Path(__file__).resolve().parents[1]


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_pool()
    yield
    await db.close_pool()


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok", "message": "hello"}


@app.get("/dashboard")
def dashboard_page():
    """관리자/PB 콘솔. 시안 파일을 그대로 서빙한다 — 복사본을 두지 않으므로 시안과 실제
    화면이 갈라지지 않고, 같은 오리진이라 CORS도 타지 않는다.
    # ponytail: Next.js /dashboard로 포팅하기 전까지의 배선. 포팅 시 이 라우트는 지운다."""
    return FileResponse(REPO_ROOT / "docs" / "design" / "pb-admin-dashboard.html")


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


async def _prompt_stream(text: str):
    """can_use_tool 콜백을 쓰려면 SDK가 prompt를 문자열이 아니라 AsyncIterable로 요구한다
    (스트리밍 입력 모드) — 한 번만 yield하는 최소 래퍼."""
    yield {
        "type": "user",
        "session_id": "",
        "message": {"role": "user", "content": text},
        "parent_tool_use_id": None,
    }


def _text_delta(event: dict) -> str | None:
    """StreamEvent.event(원시 Anthropic 스트림 이벤트)에서 텍스트 조각만 뽑는다.

    스트림에는 message_start·content_block_start·ping·tool 입력 델타 등이 섞여 오는데,
    노트 본문에 해당하는 건 content_block_delta 안의 text_delta 뿐이다."""
    if event.get("type") != "content_block_delta":
        return None
    delta = event.get("delta") or {}
    if delta.get("type") != "text_delta":
        return None
    return delta.get("text")


def _extract_corp_name(a1_text: str | None) -> str | None:
    """a1이 "종목코드 X = 법인명 Y" 형태로 반환한 텍스트에서 법인명만 뽑는다."""
    if not a1_text:
        return None
    idx = a1_text.rfind("=")
    if idx == -1:
        return None
    name = a1_text[idx + 1 :].replace("*", "").strip()
    return name or None


# --- 컴플라이언스 게이트 배선: 훅은 SDK가 제공하는 배선 지점일 뿐이고, 판정 규칙 자체는
# backend/compliance.py에 직접 작성한다 (CLAUDE.md 원칙).
ALLOWED_TOOL_PREFIXES = ("mcp__dart__", "mcp__news__")


def _tool_allowed(tool_name: str) -> bool:
    return tool_name == "Agent" or any(tool_name.startswith(p) for p in ALLOWED_TOOL_PREFIXES)


async def can_use_tool(tool_name, tool_input, context):
    """권한 콜백 — 허용 목록(DART/뉴스 MCP + 서브에이전트 위임) 밖 도구는 전부 거부한다.
    프롬프트 인젝션으로 공시·뉴스 원문에 섞여 들어온 지시문이 Bash/WebFetch 같은 도구를
    실제로 실행시키는 걸 막는 최후 방어선(가드레일 5)."""
    allowed = _tool_allowed(tool_name)
    await db.append_audit(
        "permission_check",
        None,
        None,
        {"tool_name": tool_name, "agent_id": getattr(context, "agent_id", None), "allowed": allowed},
    )
    if allowed:
        return PermissionResultAllow()
    return PermissionResultDeny(message=f"허용되지 않은 도구: {tool_name}")


async def _pre_tool_use_hook(input_data, tool_use_id, context):
    await db.append_audit(
        "tool_use_start",
        None,
        None,
        {"tool_name": input_data.get("tool_name"), "agent_type": input_data.get("agent_type")},
    )
    return {}


async def _post_tool_use_hook(input_data, tool_use_id, context):
    await db.append_audit(
        "tool_use_end",
        None,
        None,
        {
            "tool_name": input_data.get("tool_name"),
            "agent_type": input_data.get("agent_type"),
        },
    )
    return {}


@app.get("/api/research/stream")
async def research_stream(stock_code: str = Query(...)):
    if not re.fullmatch(r"\d{6}", stock_code):
        raise HTTPException(400, "stock_code는 6자리 숫자여야 합니다.")

    async def event_gen():
        options = ClaudeAgentOptions(
            cwd=str(REPO_ROOT),
            can_use_tool=can_use_tool,
            # a5 노트 본문을 토큰 단위로 흘리기 위해 부분 메시지를 켠다. 켜면 StreamEvent가
            # 추가로 오는 것이고 기존 AssistantMessage는 그대로 오므로, 노트 저장·인용 파싱
            # 경로(a5_texts)는 손대지 않는다.
            include_partial_messages=True,
            hooks={
                "PreToolUse": [HookMatcher(hooks=[_pre_tool_use_hook])],
                "PostToolUse": [HookMatcher(hooks=[_post_tool_use_hook])],
            },
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
                "**3단계 — 노트 초안 위임(a2·a4 결과를 모두 받은 후, 필수):** a5에게 위임해서 "
                "실적·공시 노트 초안을 쓰게 해라. 위임 메시지에는 반드시 법인명과, a2·a4가 반환한 "
                "텍스트를 요약하거나 손대지 말고 **원문 그대로(URL·수치 포함)** 그대로 옮겨 적어라 "
                "— a5는 그 URL/접수번호로 출처 각주를 달기 때문에, 네가 다듬거나 요약하면 각주가 "
                "깨진다.\n\n"
                "**최종 답변:** a5의 노트 초안을 받은 후, 사용자에게 보내는 마지막 답변은 노트 "
                "본문이나 재무제표·뉴스 목록을 다시 나열하지 마라 — 전부 화면에 별도로 표시된다. "
                "\"노트 초안이 준비되어 검토 대기 중입니다\" 정도의 한 줄 안내만 해라."
            ),
        )
        prompt = (
            f"종목코드 {stock_code}의 최신 사업연도 매출액·영업이익 핵심수치와 최근 관련 뉴스를 둘 다 알려주고, "
            "그걸 바탕으로 실적·공시 노트 초안까지 만들어줘."
        )
        tool_names: dict[str, str] = {}
        agent_of_tool_use_id: dict[str, str] = {}
        agent_errors: set[str] = set()
        # dart_fetch는 viewer_url만 주고 접수일(rcept_dt)은 안 준다 — dart_search 결과에서
        # rcept_no -> rcept_dt를 미리 모아뒀다가 dart_fetch 성공 시 붙여서 출처로 내보낸다.
        rcept_dt_by_no: dict[str, str] = {}
        # A5의 각주 태그([^rcept_no] / [^url])를 실제 출처 메타로 매칭하기 위해 모아둔다.
        dart_viewer_url_by_no: dict[str, str] = {}
        news_sources: dict[str, dict] = {}
        a1_text: str | None = None
        a5_texts: list[str] = []
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

        async for message in query(prompt=_prompt_stream(prompt), options=options):
            if isinstance(message, StreamEvent):
                # 노트 본문(a5)만 토큰으로 흘린다 — O·a1·a2·a4의 중간 텍스트까지 흘리면
                # 화면이 노트가 아닌 내부 사고 과정으로 덮인다.
                if agent_of_tool_use_id.get(message.parent_tool_use_id) != "a5":
                    continue
                chunk = _text_delta(message.event)
                if chunk:
                    yield _sse("note_token", {"text": chunk})
            elif isinstance(message, AssistantMessage):
                agent = agent_of_tool_use_id.get(message.parent_tool_use_id, "O")
                for block in message.content:
                    if isinstance(block, TextBlock):
                        yield _sse("text", {"agent": agent, "text": block.text})
                        if agent == "a1":
                            a1_text = block.text
                        elif agent == "a5":
                            a5_texts.append(block.text)
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
                        for item in parsed:
                            news_sources[item["link"]] = {"title": item["title"], "pub_date": item["pub_date"]}
                    elif name == "mcp__dart__dart_search":
                        for item in parsed:
                            rcept_dt_by_no[item["rcept_no"]] = item["rcept_dt"]
                    elif name == "mcp__dart__dart_fetch":
                        dart_viewer_url_by_no[parsed["rcept_no"]] = parsed["viewer_url"]
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
                if a5_texts:
                    corp_name = _extract_corp_name(a1_text) or stock_code
                    raw_note = "\n".join(a5_texts)
                    dart_sources = {
                        rcept_no: {"viewer_url": url, "rcept_dt": rcept_dt_by_no.get(rcept_no)}
                        for rcept_no, url in dart_viewer_url_by_no.items()
                    }
                    sentences = citations.parse_sentences(raw_note, dart_sources, news_sources)
                    content_md = compliance.apply_watermark(raw_note)
                    violations = compliance.check_note(content_md, sentences)
                    note_id = await db.create_note(stock_code, corp_name, content_md, sentences, violations)
                    await db.append_audit(
                        "note_created",
                        note_id,
                        None,
                        {"violations": violations, "unsourced": citations.unsourced_count(sentences)},
                    )
                    yield _sse(
                        "note",
                        {
                            "id": note_id,
                            "status": "draft",
                            "corp_name": corp_name,
                            "sentences": sentences,
                            "violations": violations,
                        },
                    )
                yield _sse("done", {"unsourced_agents": sorted(agent_errors)})

    return StreamingResponse(event_gen(), media_type="text/event-stream")


class ActorBody(BaseModel):
    actor: str


class SessionDecisionBody(BaseModel):
    actor: str
    reason: str | None = None


def _note_to_dict(row, audit_rows) -> dict:
    return {
        "id": row["id"],
        "stock_code": row["stock_code"],
        "corp_name": row["corp_name"],
        "status": row["status"],
        "content_md": row["content_md"],
        "sentences": json.loads(row["sentences_json"]),
        "violations": json.loads(row["violations_json"]),
        "reviewer": row["reviewer"],
        "deliberator": row["deliberator"],
        "publisher": row["publisher"],
        "audit_log": [
            {
                "event_type": a["event_type"],
                "actor": a["actor"],
                "ts": a["ts"].isoformat(),
                "detail": json.loads(a["detail"]),
            }
            for a in audit_rows
        ],
    }


@app.get("/api/notes/{note_id}")
async def get_note_detail(note_id: int):
    row = await db.get_note(note_id)
    if row is None:
        raise HTTPException(404, "노트를 찾을 수 없습니다.")
    audit_rows = await db.get_audit_log(note_id)
    return _note_to_dict(row, audit_rows)


async def _require_status(note_id: int, expected: str):
    row = await db.get_note(note_id)
    if row is None:
        raise HTTPException(404, "노트를 찾을 수 없습니다.")
    if row["status"] != expected:
        raise HTTPException(409, f"현재 상태({row['status']})에서는 이 작업을 할 수 없습니다.")
    return row


@app.post("/api/notes/{note_id}/review")
async def start_review(note_id: int, body: ActorBody):
    await _require_status(note_id, "draft")
    await db.advance_status(note_id, "review", body.actor)
    await db.append_audit("review_started", note_id, body.actor, {})
    return {"status": "review"}


@app.post("/api/notes/{note_id}/deliberate")
async def start_deliberation(note_id: int, body: ActorBody):
    await _require_status(note_id, "review")
    await db.advance_status(note_id, "deliberation", body.actor)
    await db.append_audit("deliberation_started", note_id, body.actor, {})
    return {"status": "deliberation"}


@app.post("/api/notes/{note_id}/publish")
async def publish_note(note_id: int, body: ActorBody):
    row = await _require_status(note_id, "deliberation")
    sentences = json.loads(row["sentences_json"])
    violations = compliance.check_note(row["content_md"], sentences)
    if violations:
        await db.append_audit("publish_blocked", note_id, body.actor, {"violations": violations})
        raise HTTPException(
            409, detail={"message": "컴플라이언스 게이트를 통과하지 못했습니다.", "violations": violations}
        )
    await db.advance_status(note_id, "published", body.actor, violations=[])
    await db.append_audit("published", note_id, body.actor, {})
    return {"status": "published"}


# --- 대시보드(관리자/PB 콘솔) --------------------------------------------
# 시안: docs/design/pb-admin-dashboard.html. 이 구간은 에이전트를 호출하지 않고
# 이미 쌓인 산출물(노트·감사로그)과 목업 고객 데이터를 읽기만 한다.

def _customer_to_dict(row) -> dict:
    flag_reasons = json.loads(row["flag_reasons"])
    return {
        "id": row["id"],
        "name": row["name"],
        "age": row["age"],
        "acct": row["account_no"],
        "pb": row["pb"],
        "risk": row["risk_profile"],
        "balance": row["balance"],
        "ret": row["return_pct"],
        "holdings": json.loads(row["holdings"]),
        "alloc": json.loads(row["alloc"]),
        "diag": row["diagnosis"],
        "flag": len(flag_reasons) > 0,
        "flagReasons": flag_reasons,
    }


def _citation_stats(note_rows) -> tuple[int, int]:
    """(출처 붙은 문장 수, 제목이 아닌 전체 문장 수). 제목 줄은 분모에서 뺀다."""
    sourced = total = 0
    for row in note_rows:
        for s in json.loads(row["sentences_json"]):
            if s.get("is_heading"):
                continue
            total += 1
            if s.get("source"):
                sourced += 1
    return sourced, total


@app.get("/api/customers")
async def get_customers():
    return [_customer_to_dict(r) for r in await db.list_customers()]


@app.get("/api/customers/{customer_id}")
async def get_customer_detail(customer_id: int):
    row = await db.get_customer(customer_id)
    if row is None:
        raise HTTPException(404, "고객을 찾을 수 없습니다.")
    return _customer_to_dict(row)


@app.get("/api/sessions")
async def get_sessions():
    return [
        {
            "id": r["id"],
            "customer_id": r["customer_id"],
            "customer_name": r["customer_name"],
            "pb": r["pb"],
            "status": r["status"],
            "topic": r["topic"],
            "question": r["question"],
            "started_at": r["started_at"].isoformat(),
        }
        for r in await db.list_sessions()
    ]


async def _decide_session(session_id: int, decision: str, body: SessionDecisionBody):
    """승인/반려는 담당 PB의 1회성 결정이다 — 이미 결정된 건은 409로 막는다."""
    row = await db.get_session(session_id)
    if row is None:
        raise HTTPException(404, "상담 세션을 찾을 수 없습니다.")
    if row["status"] != db.SESSION_PENDING:
        raise HTTPException(
            409,
            detail={
                "message": f"이미 처리된 상담입니다 (현재 상태: {row['status']}).",
                "status": row["status"],
            },
        )
    await db.set_session_status(session_id, decision)
    await db.append_audit(
        "session_approved" if decision == "done" else "session_rejected",
        None,
        body.actor,
        {"session_id": session_id, "reason": body.reason},
    )
    return {"id": session_id, "status": decision}


@app.post("/api/sessions/{session_id}/approve")
async def approve_session(session_id: int, body: SessionDecisionBody):
    return await _decide_session(session_id, "done", body)


@app.post("/api/sessions/{session_id}/reject")
async def reject_session(session_id: int, body: SessionDecisionBody):
    return await _decide_session(session_id, "rejected", body)


@app.get("/api/dashboard/summary")
async def dashboard_summary():
    notes = await db.list_notes()
    sessions = await db.list_sessions()
    sourced, total = _citation_stats(notes)
    published = [n for n in notes if n["status"] == "published"]
    pending_notes = [n for n in notes if n["status"] != "published"]
    pending_sessions = [s for s in sessions if s["status"] == db.SESSION_PENDING]
    blocks = await db.gate_blocks_daily(7)
    return {
        # 출처 부착률 — 분모가 0이면 비율을 만들지 않고 None으로 둔다(0%로 오해되지 않게).
        "citation_rate": round(sourced / total * 100, 1) if total else None,
        "citation_sourced": sourced,
        "citation_total": total,
        "notes_total": len(notes),
        "notes_published": len(published),
        "notes_pending": len(pending_notes),
        "publish_rate": round(len(published) / len(notes) * 100, 1) if notes else None,
        "sessions_pending": len(pending_sessions),
        "queue_pending": len(pending_notes) + len(pending_sessions),
        "gate_blocks_7d": sum(b["blocks"] for b in blocks),
        "gate_blocks_daily": [b["blocks"] for b in blocks],
        "customers_total": len(await db.list_customers()),
    }


@app.get("/api/dashboard/queue")
async def dashboard_queue():
    """검토·승인 대기 큐 — 노트(검토→심의→발행)와 상담(승인/반려)을 한 줄로 합친다."""
    items = []
    for n in await db.list_notes():
        if n["status"] == "published":
            continue
        items.append(
            {
                "type": "note",
                "id": n["id"],
                "code": n["stock_code"],
                "title": f"{n['corp_name']}({n['stock_code']}) 실적·공시 노트 초안",
                "status": n["status"],
                # 셀프 클레임 — 아직 아무도 집지 않은 건은 '미배정'으로 남긴다.
                "who": n["deliberator"] or n["reviewer"] or "미배정",
                "violations": json.loads(n["violations_json"]),
                "updated_at": n["updated_at"].isoformat(),
            }
        )
    for s in await db.list_sessions():
        if s["status"] != db.SESSION_PENDING:
            continue
        items.append(
            {
                "type": "chat",
                "id": s["id"],
                "customer_id": s["customer_id"],
                "topic": s["topic"],
                "title": f"{s['customer_name']} · {s['topic']}",
                "status": s["status"],
                "who": s["pb"],
                "question": s["question"],
                "updated_at": s["started_at"].isoformat(),
            }
        )
    items.sort(key=lambda i: i["updated_at"], reverse=True)
    return items


@app.get("/api/dashboard/agents")
async def dashboard_agents():
    return [{"agent": r["agent"], "calls": r["calls"]} for r in await db.agent_call_counts()]


@app.get("/api/dashboard/audit")
async def dashboard_audit(limit: int = Query(30, ge=1, le=200)):
    return [
        {
            "id": r["id"],
            "ts": r["ts"].isoformat(),
            "event_type": r["event_type"],
            "note_id": r["note_id"],
            "actor": r["actor"],
            "detail": json.loads(r["detail"]),
        }
        for r in await db.recent_audit(limit)
    ]
