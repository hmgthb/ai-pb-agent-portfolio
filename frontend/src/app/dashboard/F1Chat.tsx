'use client';

/** F1 대화형 종목 Q&A (수직 슬라이스 · 단일턴).
 *
 *  `GET /api/chat/stream?q=...`의 SSE를 말풍선으로 옮긴다:
 *    blocked      → 입력 가드(MNPI·인젝션·PII) 차단 — 빨간 말풍선, 에이전트 안 돎
 *    routing      → 어느 에이전트로 갔는지 배지(감사 가능한 규칙 결정)
 *    answer_token → 답변 토큰 스트리밍(말풍선에 점진 표시)
 *    answer       → 최종 문장별 출처 배지 + 지연시세 고지
 *    run_error    → 실행 오류(연결 끊김과 구분)
 *
 *  멀티턴(Redis 세션)은 이 슬라이스 범위 밖 — 지금은 매 질문이 독립이다.
 */

import { useEffect, useRef, useState } from 'react';
import { chatStreamUrl } from './api';
import { RedactionDetails } from './redaction';
import { mergeSources, SourceBadge } from './sources';
import type { ChatAnswer, ChatRedaction, ChatRouting } from './types';

/** 라우팅 배지에 적는 이름. **에이전트 식별자(a1·a2·a4)를 적지 않는다** — 이 배지가 답할
 *  것은 "왜 이 답이 나왔나"(어떤 데이터를 봤나)이지 "어느 서브에이전트가 돌았나"가 아니다.
 *  읽는 사람은 PB다. `KRX`·`계산`은 코드명이 아니라 출처·방법이라 남긴다. */
const AGENT_LABEL: Record<string, string> = {
  a1: '공시',
  a2: '재무',
  a4: '뉴스',
  krx: '시세(KRX)',
  // 에이전트가 아니라 **코드 계산**이다 — 집중도·배분은 순수 함수가 내고 LLM은 문장만 쓴다.
  // 배지에 그대로 적는 이유: "왜 이 답이 나왔나"를 화면이 말해야 하는데(감사 가능한 라우팅),
  // 여기서만 도구 호출이 0건이라 진행 타임라인에 아무것도 안 뜬다.
  portfolio: '보유·배분',
};

type Turn = {
  q: string;
  routing?: ChatRouting;
  redaction?: ChatRedaction;
  streaming: string;
  answer?: ChatAnswer;
  blocked?: string[];
  /** 어느 문지기에 걸렸나: `input`=들어오는 질문, `egress`=나가는 프롬프트.
   *  둘은 사용자가 할 일이 다르다 — 앞은 질문을 고쳐 쓰고, 뒤는 데이터가 새는 것이라
   *  질문을 고쳐도 같은 결과일 수 있다. */
  blockedStage?: string;
  error?: string;
  running: boolean;
};

/** 보내기 전 경고 — 입력창에 담당 고객 이름이나 계좌·주민번호 형식이 있으면 알린다.
 *
 *  ⚠️ **이건 게이트가 아니다.** 권위는 백엔드(`compliance.egress_guard`)에 있고 여기서는
 *     막지 않는다(보내기 버튼도 그대로 살아 있다) — 브라우저는 이미 `/api/customers`로
 *     이름·계좌·실금액을 받아 화면에 그리고 있어서, 여기서 가려 봐야 보장이 생기지 않는다.
 *     이 줄이 하는 일은 **누르기 전에 알려 주는 것**뿐이다(백엔드가 막으면 크레딧은 안 쓰지만
 *     왕복은 한다). 오탐이어도 사람이 그냥 보낼 수 있어야 해서 차단하지 않는다.
 *  ⚠️ 규칙은 백엔드와 **같은 뜻**으로 맞춘다: 3글자 이상 이름만, 계좌·주민번호는 숫자 형식.
 *     2글자를 안 잡는 이유도 같다(일반 낱말과 겹쳐 오탐). */
const _ACCOUNT_RE = /\d{2,3}\s*[-–]\s*\d{3,4}\s*[-–]\s*\d{4,6}/;
const _RRN_RE = /\d{6}\s*[-–]\s*[1-4]\d{6}/;
function outboundWarning(text: string, names: string[]): string | null {
  // 사유마다 할 일이 다르다 — 이름은 **바꿔** 물으면 되고(종목·비중이면 같은 답이 나온다),
  // 계좌·주민번호는 바꿀 게 아니라 **지우는** 것이다(답변에 쓸 데가 없다).
  const hit = names.find((n) => n.length >= 3 && text.includes(n));
  if (hit)
    return `고객 이름이 들어 있습니다(${hit}). 이름 대신 종목·비중으로 물어보세요.`;
  if (_RRN_RE.test(text) || _ACCOUNT_RE.test(text))
    return '계좌·주민번호 형식이 들어 있습니다. 지우고 물어보세요.';
  return null;
}

/** 입력창에 질문을 채워 넣는 신호. 같은 종목을 두 번 눌러도 다시 채워져야 하므로
 *  문자열이 아니라 **눌린 횟수(n)를 같이** 들고 다닌다 — 값이 같으면 effect가 안 돈다. */
export type ChatPrefill = { q: string; n: number };

export default function F1Chat({
  initial,
  prefill,
  compact,
  customerId,
  customerNames,
  preview,
}: {
  initial?: string;
  /** 마운트 뒤에도 입력창을 채우는 경로(고객 카드의 보유 종목 칩). */
  prefill?: ChatPrefill | null;
  /** 카드 안에 인라인으로 놓을 때. 모달용 큰 머리말·안내문을 접고 높이를 부모에 맞춘다. */
  compact?: boolean;
  /** 붙이면 **포트폴리오 질문**까지 답한다(집중도·배분·성향 대비). 안 붙이면 종목 질문만.
   *  전역 F1(우하단 고정 버튼)에는 고객이 없으므로 undefined로 열린다. */
  customerId?: number;
  /** 담당 고객 명단 — 보내기 전 경고에만 쓴다. 브라우저가 이미 갖고 있는 값이라
   *  (`/api/customers`가 이름을 준다) 여기 넘긴다고 새로 노출되는 건 없다. */
  customerNames?: string[];
  /** 이 고객에 대해 물으면 무엇이 나가는가 — 질문 전에 미리 보여준다(크레딧 0).
   *  `GET /api/customers/{id}/egress-preview`가 준 값 그대로. */
  preview?: ChatRedaction | null;
} = {}) {
  // 상담 준비 메모에서 종목을 눌러 열면 질문이 채워진 채로 시작한다. **보내지는 않는다** —
  // 실행은 크레딧을 쓰고 답변은 고객 앞에서 쓰일 수 있으니, 시작 버튼은 사람이 누른다.
  const [input, setInput] = useState(initial ?? '');
  const [turns, setTurns] = useState<Turn[]>([]);
  // 멀티턴: 백엔드가 발급한 세션 id를 들고 다음 턴에 붙인다 → "관련 뉴스는?"이 종목을 이어받는다.
  const sessionRef = useRef<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const running = turns.length > 0 && turns[turns.length - 1].running;
  // 렌더 중 계산이다(상태가 아니다) — 입력이 바뀌면 그 프레임에 같이 바뀌어야 하고,
  // effect로 두면 한 글자 늦게 뜬다. 순수 문자열 검사라 비용도 없다.
  const warning = outboundWarning(input, customerNames ?? []);

  useEffect(() => () => esRef.current?.close(), []);
  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [turns]);
  // 칩을 누르면 입력창만 채운다(보내지 않는 건 위와 같은 이유다).
  // effect가 아니라 **렌더 중 조정**이다 — 프리필은 화면에 그려지기 전에 반영돼야 하고,
  // effect로 하면 빈 입력창이 한 번 그려졌다가 채워진다. 신호는 n으로 소비 여부를
  // 판단한다: 같은 종목을 두 번 눌러도 q는 같으므로 문자열로는 구분되지 않는다.
  const [seenPrefill, setSeenPrefill] = useState(prefill?.n ?? 0);
  if (prefill && prefill.n !== seenPrefill) {
    setSeenPrefill(prefill.n);
    setInput(prefill.q);
  }

  const patchLast = (p: Partial<Turn>) =>
    setTurns((ts) =>
      ts.map((t, i) => (i === ts.length - 1 ? { ...t, ...p } : t)),
    );

  function send() {
    const q = input.trim();
    if (!q || running) return;
    setInput('');
    setTurns((ts) => [...ts, { q, streaming: '', running: true }]);

    const es = new EventSource(
      chatStreamUrl(q, sessionRef.current, customerId ?? null),
    );
    esRef.current = es;
    let done = false;

    es.addEventListener('session', (e) => {
      sessionRef.current = JSON.parse((e as MessageEvent).data).session;
    });
    es.addEventListener('routing', (e) =>
      patchLast({ routing: JSON.parse((e as MessageEvent).data) }),
    );
    es.addEventListener('blocked', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      patchLast({ blocked: d.violations, blockedStage: d.stage ?? 'input' });
    });
    // 비식별화 경계를 지난 뒤에만 온다 — 이 이벤트가 있다는 건 "실제로 이것이 나갔다"는 뜻이다
    // (가드에 걸려 차단되면 오지 않는다).
    es.addEventListener('redaction', (e) =>
      patchLast({ redaction: JSON.parse((e as MessageEvent).data) }),
    );
    es.addEventListener('answer_token', (e) =>
      setTurns((ts) =>
        ts.map((t, i) =>
          i === ts.length - 1
            ? {
                ...t,
                streaming:
                  t.streaming + JSON.parse((e as MessageEvent).data).text,
              }
            : t,
        ),
      ),
    );
    es.addEventListener('answer', (e) =>
      patchLast({ answer: JSON.parse((e as MessageEvent).data) }),
    );
    es.addEventListener('run_error', (e) =>
      patchLast({ error: JSON.parse((e as MessageEvent).data).message }),
    );

    es.addEventListener('done', () => {
      done = true;
      es.close();
      patchLast({ running: false });
    });
    es.onerror = () => {
      es.close();
      if (!done)
        patchLast({
          running: false,
          error: '스트림이 끊겼습니다 (백엔드 확인).',
        });
    };
  }

  return (
    <>
      {/* 인라인(고객 카드)에서는 머리말·안내를 내지 않는다 — 부모가 이미 한 줄로 설명했고,
          좁은 칸에서 그 위에 안내문을 더 얹으면 정작 대화가 밀린다.
          ⚠️ 지우는 건 이 안내문뿐이다. 답변마다 붙는 F1 고지(chat-notice)는 백엔드가
          강제하는 것이라 여기와 무관하게 그대로 나온다. */}
      {!compact && (
        <>
          <div className="m-head">
            <h3>종목 질문</h3>
          </div>
          <div className="chat-hint">
            상담 중 나온 질문을 물어보세요. (예: 삼성전자 최근 실적 → 주가는? →
            관련 뉴스는?)
            <br />
            후속 질문은 이전 종목을 이어받습니다.
          </div>
        </>
      )}

      {/* 질문 전 미리보기 — 대화 로그 **밖**, 입력 위다. 로그 안에 두면 답변이 쌓이면서
          위로 밀려 올라가는데, 이건 특정 턴에 딸린 게 아니라 이 고객에 대해 늘 참인 값이다.
          답변 위 배지와 **글자까지 같은 상자**를 쓴다: 자리가 뜻을 갈라 준다(입력창 위면
          "물어보면 볼 것", 말풍선 안이면 "이 답을 만들 때 본 것"). 미리 본 것과 실제 나간
          것이 다른 모양이면 미리보기가 약속 구실을 못 한다. */}
      {preview && (
        <div className="redact-preview">
          <RedactionDetails r={preview} />
        </div>
      )}

      <div className="chat-log" ref={scrollRef}>
        {turns.length === 0 && (
          <div className="chat-empty">질문을 입력하면 대화가 시작됩니다.</div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="chat-turn">
            <div className="bubble me">{t.q}</div>

            <div className="bubble ai">
              {t.routing && !t.routing.need_clarify && (
                <div className="route-badge" title={t.routing.reason}>
                  <b>{t.routing.agent ? AGENT_LABEL[t.routing.agent] : '—'}</b>
                  <span className="route-entity">
                    {t.routing.entity_name ?? t.routing.entity_code}
                  </span>
                  {t.routing.inherited && (
                    <span
                      className="route-carry"
                      title="이전 질문의 종목을 이어받았습니다"
                    >
                      ↩ 이어받음
                    </span>
                  )}
                </div>
              )}

              {/* `AI가 보는 정보` — 이 답을 만들 때 모델이 실제로 받은 것.
                  라우팅 배지 바로 아래인 건 둘이 같은 종류의 정보여서다: "왜 이 답이
                  나왔나"(어떤 데이터를 봤나) 옆에 "그 데이터가 어떤 꼴이었나"가 선다. */}
              {t.redaction && <RedactionDetails r={t.redaction} />}

              {t.blocked && (
                <div className="chat-blocked">
                  {t.blockedStage === 'egress'
                    ? '⛔ 외부 모델로 보내기 전에 차단됐습니다. (에이전트를 실행하지 않았습니다)'
                    : '⛔ 입력이 차단됐습니다. (에이전트를 실행하지 않았습니다)'}
                  <ul>
                    {t.blocked.map((v, j) => (
                      <li key={j}>{v}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* 최종 답변: 문장별 출처 배지 */}
              {t.answer && !t.answer.clarify && (
                <div className="chat-answer">
                  {t.answer.sentences.map((s, j) => (
                    <div className="chat-sent" key={j}>
                      <span>{s.text}</span>
                      {/* 같은 출처를 두 번 인용하면 배지도 두 개였다 — 하나로 묶고
                          `×2`로 센다. **다른 출처끼리는 합치지 않는다**(합치면 한쪽
                          링크가 사라져 가드레일 3 위반). */}
                      {mergeSources(
                        s.sources?.length
                          ? s.sources
                          : s.source
                            ? [s.source]
                            : [],
                      ).map(({ src, count }, k) => (
                        <SourceBadge key={k} src={src} count={count} />
                      ))}
                      {!s.source &&
                        !s.sources?.length &&
                        (s.kind === 'interpretation' ? (
                          <span
                            className="sbadge itp"
                            title="해석·전망 문장은 각주 대상이 아닙니다"
                          >
                            해석
                          </span>
                        ) : (
                          <SourceBadge src={null} />
                        ))}
                    </div>
                  ))}
                  {t.answer.notice && (
                    <div className="chat-notice">{t.answer.notice}</div>
                  )}
                </div>
              )}

              {/* clarify: 종목 되묻기 */}
              {t.answer?.clarify && (
                <div className="chat-clarify">{t.answer.text}</div>
              )}

              {/* 스트리밍 중(최종 answer 도착 전) */}
              {!t.answer && !t.blocked && t.streaming && (
                <div className="chat-streaming">
                  {t.streaming}
                  {t.running && <span className="gen-caret">▌</span>}
                </div>
              )}
              {!t.answer && !t.blocked && !t.streaming && t.running && (
                <div className="chat-thinking">조회 중…</div>
              )}
              {t.error && <div className="chat-blocked">⛔ {t.error}</div>}
            </div>
          </div>
        ))}
      </div>

      {/* 보내기 전 경고 — 입력창 **바로 위**다(누르기 직전에 지나친다). 버튼은 살려 둔다:
          권위는 백엔드에 있고 이건 알림일 뿐이라, 오탐이면 그냥 보낼 수 있어야 한다. */}
      {warning && <div className="out-warn">⚠ {warning}</div>}

      <div className="chat-input">
        <input
          className="search"
          /* 자동완성 끄기 — 제안이 뜨는 것보다, 여기 친 질문이 브라우저 입력 이력에
             남는 쪽이 문제다(가드레일 1: 고객 관련 텍스트가 들어올 수 있는 칸이다). */
          autoComplete="off"
          placeholder={
            compact
              ? customerId != null
                ? '종목·배분에 대해 질문하세요.'
                : '질문을 입력하세요.'
              : '최근 이 회사 실적 어때?'
          }
          value={input}
          disabled={running}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
        />
        <button
          className="btn primary"
          onClick={send}
          disabled={running || !input.trim()}
        >
          {running ? '…' : '보내기'}
        </button>
      </div>
    </>
  );
}
