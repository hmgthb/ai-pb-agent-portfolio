# 인수인계 — 리서치 코파일럿 / AI PB 대시보드

> 최종 갱신: 2026-07-22 · **다음 세션은 이 문서부터 읽으세요.**
> 주차 계획은 `주차별_실행계획.md`(**원본 유지 — 진행 기록은 여기에만**), 런타임 지침은 `CLAUDE.md`,
> 대시보드 설계 이력은 `~/.claude/plans/inherited-beaming-canyon.md`, 측정은 `docs/EVAL.md`, 가치는 `docs/VALUE.md`.
> ⚠️ 이 문서는 이제 **git 추적 대상**이다(이전엔 `.gitignore`에 있어 한 번도 커밋 안 됐다). **자주 커밋할 것.**

---

## 0. 현재 상태

**계획서 🟢 필수(W1~W6) + 🟡 선택(F1)이 전부 라이브 검증으로 닫혔다. 남은 건 W7(발표)뿐 — 크레딧 무관.**

| 주 | 상태 | 내용 |
| :-: | --- | --- |
| W1 | ✅ 라이브 | 환경·플러그인(earnings-reviewer·equity-research)·자체 MCP 3개(DART/뉴스/KRX)·`CLAUDE.md`·SDK hello world·공통 셸 |
| W2 | ✅ 라이브 | DART MCP·a1·a2·O 위임·SSE 카드·docker-compose |
| W3 | ✅ 라이브 | a4·팬아웃(a2‖a4)·진행 타임라인·점진 렌더 |
| W4 | ✅ 라이브 | a5·토큰 스트리밍·citations·게이트·검토→심의→발행(사람)·워터마크 (§1) |
| W5 | ✅ 라이브 | F2 모닝 브리프(새 에이전트 0개)·H1 홈 |
| W6 | ✅ 라이브 | 3시나리오 안정화·간이 eval(`docs/EVAL.md`)·정량 가치 리포트(`docs/VALUE.md`) |
| F1 | ✅ 라이브 | 🟡선택. 대화형 Q&A: 규칙 라우팅·입력가드·인용·지연시세 + Redis 멀티턴 (§4) |
| W7 | ❌ 미착수 | 덱·데모 대본·백업 녹화·예상 Q&A |

**다음 할 일 = W7 발표 준비**
- 임원 덱: 플랫폼 개요(H1) → 라이브 데모 → 기술 깊이(팬아웃) → 규제 안전(사람 발행) → 로드맵(F4·F5) → 정량 가치(`docs/VALUE.md` ~2/~5 FTE).
- 데모 대본 + **백업 녹화본**(라이브 실패 대비) + 예상 Q&A(환각/규제/비용/사내데이터).
- (선택) F1 확장 — 의도 이어받기·대명사 해소·비교(F4 영역). 없어도 무방.

**데모 데이터 현황**
- **데모 노트 5건**(NAVER·기아·카카오·LG화학·POSCO홀딩스, 전부 `draft`) + 상담 4건 = 큐 9건. 대시보드 부착률 87.5%.
- **POSCO 노트는 게이트 3건**(목표주가·지연시세 등) 달려 있어 **발행 하드 블록 시연에 그대로 쓸 것**.
- ⚠️ 검토→심의→발행 워크플로를 라이브로 보이려면 5건 중 몇 건을 그 단계로 진행시켜 둘 것.
- `pb_customers(50)`·`pb_sessions(30)`·감사로그는 **보존**(§2의 시드 유실 주의).

**착수 전 필수**: `git pull` 후 **`docker compose build backend && up -d --force-recreate backend`** —
`redis` 의존성이 추가돼(§4) 안 하면 F1이 `ModuleNotFoundError`로 죽는다.

---

## 1. a5는 위임이 아니라 backend 2차 `query()` — `Agent` 도구 비동기 함정

*(코드 여러 곳이 "HANDOFF §1"로 이 절을 가리킨다. 상세 배경은 `CLAUDE.md` "검증됨" 절.)*

`Agent` 도구는 **비동기**다 — 결과가 `"Async agent launched successfully"`로 즉시 돌아오고 서브에이전트는
백그라운드에서 돈다. **O가 턴을 끝내면 `query()` 스트림이 닫히고 도구를 안 부르는 a5가 잘린다.**
(a1·a2·a4는 도구 결과가 스트림에 빨리 들어와 살아남는다.)

**채택한 구조**: O의 1차 쿼리가 끝나면 backend가 a5를 **메인 에이전트로 하는 2차 `query()`**로 직접
돌린다(`main.py::event_gen`). a5가 메인이라 `text_delta`가 `parent_tool_use_id=None`으로 흘러 토큰
스트리밍(`note_token`)이 산다. 지침은 `.claude/agents/a5.md` **본문만** 읽어 `system_prompt`로 쓰고
(`_agent_prompt`), 입력은 O의 산문이 아니라 **도구 결과를 그대로 직렬화**(`_a5_input`, LLM 미개입).
- `background: false`(프론트매터)도 위임을 동기화하지만 **StreamEvent가 안 나와 토큰 스트리밍이 죽는다** → 안 씀.
- ❌ **반복 금지**: 시스템 프롬프트에 "a5 결과를 기다려/인용해"를 넣었더니 O가 **a2 수치로 문장을 지어내
  a5가 쓴 것처럼 인용**했다(가드레일 3 위반). 지금은 O 프롬프트에서 노트 단계를 아예 뺐다.

---

## 1-1. 출처 부착률·게이트 정의 — 지표 함정 (설계 의도)

*(코드가 "HANDOFF §1-1"로 이 절을 가리킨다.)*

**핵심 교훈: 지표를 믿기 전에 지표부터 검증하라.** 낮은 수치를 보면 산출물을 탓하기 전에 측정기를 의심할 것.
한 종목만 보고 "규칙 준수"라 결론 내리지 말 것. 이번 세션에 **측정 정의 버그를 4건** 잡았다(전부 a5 오류 아님):
파서가 문장 중간 각주를 버림(노트6 10개 중 5개 유실 → 발행 하드 블록) · eval 하네스 3건(수치 표기 다양성
조/억↔백만원, 재무 카드 여러 개 중 첫 것으로 대조, 존댓말 해석 어미 미인식).

**확정된 정의**(`citations.citation_stats()` **단일 출처** — 게이트·대시보드가 같이 쓴다):
- 문장마다 `kind`: `heading`·`boilerplate`(고지·구분선)·`claim`(사실 주장)·`interpretation`(해석·전망).
- **출처 부착률 분모 = `claim`만.** 해석 문장은 규칙상 각주를 안 붙이므로(a5.md) 분모에서 뺀다. 안 빼면
  a5의 해석 문장 수 변덕이 품질로 오독된다(실측 10/14↔7/14로 흔들렸다).
- **분류는 보수적으로** — 애매하면 `claim`. 헐거우면 미인용 문장이 분모에서 빠져 부착률이 후해지는데,
  컴플라이언스 지표는 그 방향으로 틀리면 안 된다. 출처 붙은 문장은 어미가 해석 같아도 `claim`.
- **게이트(`unsourced_count`)는 F3에서 해석 문장도 센다** — 발행 전 사람이 판단하도록 올리는 게 설계다.
  지표와 게이트 정의가 다른 건 의도된 것. (F1은 발행 단계가 없어 `claim`만 센다 — §4.)
- 분모에서 뺀 해석 수는 `citation_interpretation`으로 노출(감추지 않기). 한 문장 다중 인용은 `sources` 배열로 전부.

⚠️ **분류기를 바꾸면** 기존 노트의 `sentences_json`은 저장 시점에 굳어 있으므로 `scripts/reparse_notes.py`로
재파싱해 대시보드와 맞춘다(재실행 없이, 저장된 출처에서 맵 복원).

---

## 2. 반드시 알아둘 함정·운영 수칙

- **자주 커밋할 것** — 이전 세션의 대시보드 구현이 **미커밋 상태로 통째 유실**된 적이 있다(pyc가 소스를
  덮어씀, git에도 없었음). 대시보드/문서 작업은 특히.
- **`pb_customers`·`pb_sessions`는 시드 소스가 유실돼 `.pyc`뿐이다 — 절대 지우지 말 것.** 재현 필요 시 디컴파일.
  `TRUNCATE notes, audit_log, briefs`는 가능하나 차트·알림이 같이 비니 데모 노트를 새로 만드는 편이 낫다.
- **`scripts/seed_brief.py`는 F2 파이프라인이 아니다** — 크레딧 없이 화면 검증용으로 에이전트를 건너뛰고
  MCP를 직접 부르는 시드다. 데이터는 진짜지만 "누가 수집했나"가 달라 **데모에서 F2 결과로 소개하면 안 된다**(멀티에이전트 서사 빠짐).
- **도구 결과가 토큰 한도를 넘으면 `is_error=False`인 채 에러 문자열이 온다** → `main.py::_tool_failed()`로
  걸러 `completed`로 오집계되는 걸 막는다. 자체 MCP는 반환량 상한을 둘 것(`dart_search`는 하루 382건 나온 적 있음 → `limit=30`+최신순).
- **원본과 대조할 때는 파이프라인과 같은 조건으로 조회할 것** — F2 검증 때 `days=2` 결과를 7일 창과 비교해
  "4건 유실"이라 오진했다(실제 유실 없음).
- **SSE 이벤트명을 `error`로 쓰지 말 것** — EventSource의 연결 오류 핸들러와 겹친다. 실행 오류는 `run_error`로 보낸다.
  예외가 나도 스트림이 조용히 끊기지 않게 `run_error`+`done`을 반드시 보낸다(화면이 종료 상태에 도달).
- **재생 SSE로 화면을 검증할 땐 코드의 실제 분기를 보고 시나리오를 짤 것** — "파싱 실패=노트 없음"으로 짰다가
  허구를 검증할 뻔했다(실제론 뉴스만 있어도 a5가 돈다). `scenario_check.mjs` 참고.
- **DART 전자공시는 PDF가 아니라 HTML 뷰어** — "페이지 번호" 단위가 없다. `viewer_url`+`rcept_dt`(접수시점)가
  이 소스에서 가능한 최대 해상도(계획서의 "문서·페이지·접수시점"은 PDF 상정 표현).
- **실화면은 목업으로 폴백하지 않는다** — 백엔드가 없으면 연결 실패를 그대로 말한다(조용히 가짜를 보이면 더 위험).
  목업이 필요하면 시안 파일(`docs/design/pb-admin-dashboard.html`)을 연다.
- **`docs/ARCHITECTURE.md` 로드맵이 F1을 "확장 예정"으로 적어둔 채다** — F1은 구현됐다(§4). W7 문서 최종화 때 정정.

---

## 3. 대시보드 설계 (사용자와 합의 완료 — 재논의 불필요)

- **프레이밍**: "대고객 AI PB 프로토타입"의 **관리자/PB용 감독 콘솔**(고객용 화면 아님). 단일 화면 `/dashboard`(`/`는 리다이렉트).
- **탭 2개**: 고객 관리(처리할 일·고객 현황) / AI 평가(신뢰도·컴플라이언스·감사).
- **역할 토글**(목 로그인): 관리자=전체 / PB=AI탭 숨김·내 담당 큐·담당 고객 / 준법=AI평가 기본·심의 건만·**포트폴리오 비노출(🔒)**.
- **승인 배분 = 셀프 클레임(풀)**: 미배정 건을 열어 검토 시작하면 그 사람이 담당자. 관리자 푸시 배정 없음.
- **검토 모달**: 노트=문장별 출처 배지→검토 시작(관리자)→심의(관리자)→**발행(준법만, 게이트 재검사·미인용 시 하드 블록)** /
  상담=고객 컨텍스트+답변 초안→**승인·전송(담당 PB만)**. 권한 없으면 버튼 비활성+🔒.
- **AI 신뢰도 카드**: 출처 부착률(목표 90% 미터)·발행 통과율·게이트 차단(7일) — KPI 타일이 아닌 미터/비율.
- **목업 고객 50명**: 세대혼합 이름 비복원 추출·잔고 로그균등·나이=이름 세대+재산 보정·**위험 플래그 규칙 3종**
  (①안정형인데 주식>40% ②단일종목≥65% ③수익률≤−5%)+사유 저장. 수치는 전부 실집계, 비교 데이터 없는 델타는 감춘다.
- **시안 파일**은 이제 디자인 시안 전용(아티팩트 `03fe22af-...`). 실화면과 갈라지는 게 정상.

**백엔드 라우트 9종**(포팅 후에도 그대로): `/api/dashboard/{summary|queue|agents|audit}` ·
`/api/customers[/{id}]` · `/api/sessions` · `/api/sessions/{id}/{approve|reject}`.

---

## 4. F1 대화형 종목 Q&A (규칙 라우팅 + Redis 멀티턴)

입구: 대시보드 기능 레일 **F1 카드 클릭 → 채팅 모달**.
파이프라인(`GET /api/chat/stream?q=...&session=...`): 입력 가드 → 규칙 라우팅 → 라우팅된 에이전트 도구 조회
→ 2차 query(f1 답변자, 구조화 데이터만) 스트리밍 → citations(시세 `[^krx]`) → F1 고지 강제 → 게이트 → 세션 갱신.
**라우팅·데이터취합·게이트는 코드가, LLM은 답변 문장만**(F3와 같은 각주 무결성).

- **입력 가드가 F1의 핵심**(`compliance.input_guard`) — 자유 텍스트라 F3·F2에 없던 공격면. MNPI·프롬프트
  인젝션·PII를 **에이전트 前에** 잡아 차단하면 도구가 아예 안 돈다(크레딧 0). 가드레일 2·5의 실전.
- **규칙 라우팅**(`f1.route`, 순수) — 6자리 코드/별칭 + 의도 키워드 → 에이전트(quote→krx·financials→a2·
  news→a4·disclosure→a1). 엔티티 없으면 되묻기. LLM에 안 맡긴 이유: 데이터 소스 선택은 컴플라이언스
  경계라 감사 가능한 규칙이어야 하고, "왜 이 에이전트로 갔나"를 배지로 보여준다.
- **게이트 F1 분기**: 고지문구(`CHAT_NOTICE`)에 "지연시세"를 넣어 QUOTE 게이트를 자기충족. F1은 발행 단계가
  없어 해석 문장은 위반으로 안 세고 **근거 없는 사실 주장만** 잡는다(`check_note`).
- **멀티턴(Redis)** — 현재 질문에 종목이 없으면(`주가는?`·`관련 뉴스는?`) 세션의 **직전 종목을 이어받는다**
  (`f1.route(q, prev_entity=...)`). 의도는 매 턴 새로 판단(종목만 잇는다). `session_store.py`는 **라우팅 맥락만**
  저장(최근 턴 상한 8·`last_entity`·TTL 1h) — 답변 본문·도구 결과는 안 담는다(턴 넘나들며 날조 방지, 가드레일 3).
  세션은 `/api/chat/stream`이 발급→`session` SSE→프론트가 다음 턴에 `&session=`. UI는 이어받은 턴에 **↩ 이어받음** 배지.
- **의존성**: `redis==8.0.1` 추가 → **backend 이미지 재빌드 필요**(§0). 통합 점검(Redis 필요, 크레딧 0):
  `REDIS_URL=redis://localhost:6379/0 backend/.venv/bin/python -m backend.scripts.session_store_check`.
- 파일: `backend/f1.py`(라우팅·답변조립·프롬프트)·`session_store.py`·`test_f1.py`·프론트 `F1Chat.tsx`.
  `citations.parse_sentences`에 `quote_source`(선택 4번째 인자) — 기존 3-arg 호출 무영향.
- **라이브 검증**: 삼성전자 실적(a2·DART 인용) → `주가는?`(종목 생략, krx로 이어받음·지연시세). 입력가드·되묻기 UI 확인.

---

## 5. 아키텍처 한눈에

```
[F3] 종목코드 → O(Opus) → a1 법인확인 → a2 재무 ‖ a4 뉴스 팬아웃        ← 위임은 여기까지
  → backend 도구결과 직렬화(_a5_input) → 2차 query()로 A5 직접 실행(§1) → citations(kind 부여)
  → 워터마크(F3) 강제 → 게이트 → notes 저장 → SSE(진행·토큰·노트·done{outcome})
     재무·뉴스 둘 다 없으면 a5 안 돌리고 사유만 보낸다
[F2] POST /api/briefs/run → O → a1 공시 ‖ a4 뉴스 + krx(O 직접) — 새 에이전트 0개
  → brief.assemble(중요도 순위·출처 부착, LLM 미개입) → "내부 참고용" 강제 → 게이트 → briefs 저장
     공시 중요도(0주요 1정기 2기타 3지분): 지분공시는 빼지 않고 뒤로만 민다(조용한 날 안 비게)
[F1] GET /api/chat/stream → input_guard(MNPI·인젝션·PII, 에이전트 前) → f1.route(세션 이어받기)
  → 라우팅된 에이전트/krx 조회 → 2차 query(f1 답변자) 스트리밍 → citations([^krx]) → F1 고지 → 게이트 → session_store
     ← 에이전트(LLM)는 위 세 생산 구간에서만 실행
[대시보드] Next.js `/dashboard` · 기능 레일(F1 카드→채팅) · 오늘의 브리프
  고객 관리 탭: 노트 생성 카드(관리자, F3 SSE 직접 구독) · 검토·승인 큐 · 고객 50
  AI 평가 탭: AI 신뢰도(미터) · 에이전트 호출/노트 추이 · 컴플라이언스 알림 · 감사로그
[사람] 노트: 검토→심의→발행(준법, 게이트 재검사) / 상담: 승인·전송(담당 PB) — AI 개입 없음, 전 과정 audit_log
```

**파일 대응**: a5 작문 지침=`a5.md`(backend가 system_prompt로 읽음) / 출처매칭·문장범주·부착률 정의=`citations.py`
(단일 출처) / F1 라우팅·답변조립=`f1.py`·대화상태=`session_store.py` / 브리프 조립=`brief.py` /
고지·게이트·입력가드=`compliance.py` / 상태·로그=`db.py` / 배선·API=`main.py` / MCP=`mcp_servers/{dart,news,krx}_server.py` /
화면=`frontend/src/app/dashboard/{page,ResearchCard,ReviewModal,F1Chat,charts}.tsx`.

---

## 6. 환경/실행 메모

- 앱: `docker compose up`(backend 8000 / frontend 3000 / postgres 5432 / redis 6379). **requirements 변경 시
  `docker compose build backend && up -d --force-recreate backend`**.
- 대시보드: http://localhost:3000/dashboard.
- **자체 점검(크레딧·네트워크 불필요, 10종)**: `for t in compliance brief krx streaming tool_result a5_input brief_attribution citations run_outcome f1; do backend/.venv/bin/python -m backend.test_$t; done`
- **프론트 검증**: `cd frontend && npx tsc --noEmit && npx eslint src --max-warnings=0`. ⚠️ Next.js 16: 코드 전 `frontend/node_modules/next/dist/docs/` 확인(frontend/AGENTS.md).
- **화면 재생 검증**(크레딧 0, `frontend/`에서 실행 — playwright 모듈): `node scenario_check.mjs`(W6 빈/에러 5종).
- **Redis 세션 통합 점검**: `REDIS_URL=redis://localhost:6379/0 backend/.venv/bin/python -m backend.scripts.session_store_check`.
- **라이브 실행(비용)**: F3 `curl -sN "http://localhost:8000/api/research/stream?stock_code=005930" > /tmp/f3.sse`(~100초) /
  F2 `curl -s -X POST .../api/briefs/run -d '{}'`(~40초) / F1 `curl -sN ".../api/chat/stream?q=삼성전자 최근 실적"`(→`session` id를 다음 턴 `&session=`).
  → `grep "^event:" *.sse | sort | uniq -c`로 이벤트별 건수부터 본다.
- 위임 동기/비동기 판정(저비용): `docker compose exec -T backend python -m backend.scripts.background_flag_check`.
- 테스트 데이터 정리: `docker exec research-copilot-postgres-1 psql -U app -d app -c "TRUNCATE notes, audit_log, briefs RESTART IDENTITY;"`(`pb_*`는 지우지 말 것 — §2).
- API 키 4개(`.env`): `ANTHROPIC_API_KEY`·`DART_API_KEY`·`NAVER_CLIENT_ID/SECRET`·`KRX_API_KEY`(data.go.kr, 무료).
- git: main → **personal**(hmgthb/research-copilot) 업스트림. origin(kwangtekNa/intern)에는 푸시 안 함.
- SDK API명은 `claude-agent-sdk==0.2.110` 실물 확인 — `CLAUDE.md` "검증됨" 절.

---

## 7. 아직 검증 못 한 것 / 리스크

- ❓ **발행까지 가는 전체 흐름을 포팅된 React 모달에서** — 전이·게이트 재검사는 시안 HTML+백엔드로 검증했으나,
  React 모달로 검토→심의→발행을 끝까지 돌려본 적은 없다. (백엔드는 그대로라 낮은 리스크.)
- ❓ **파서 수정 후 A5 각주 규칙 라이브 재확인** — §1-1의 파서 버그를 고친 뒤 새로 관찰한 건 데모 노트
  5건뿐(`docs/EVAL.md`, 부착률로는 확인). 문장별 각주 정확성을 새 노트에서 정성 관찰하면 완결.
- ❓ **3시나리오 예외 상태는 재생 SSE 기준** — 실제로 공시 없는/파싱 실패 종목을 라이브로 돌려본 건 아니다(조립 경로는 동일).
- ❓ **정량 가치 밴드는 추정 모델** — 가정(X=60분·물량) 의존적. Q&A에서 근거를 물으면 `docs/VALUE.md` 민감도표로 답하고 단일 숫자로 단정하지 말 것.
