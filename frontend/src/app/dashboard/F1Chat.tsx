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
import type { ChatAnswer, ChatRouting, NoteSource } from './types';

const AGENT_LABEL: Record<string, string> = {
  a1: '공시(a1)', a2: '재무(a2)', a4: '뉴스(a4)', krx: '시세(KRX)',
};

/** 문장 출처 배지 — 노트 모달과 같은 규칙에 시세(krx)를 더한다. */
function SrcBadge({ src }: { src: NoteSource | null }) {
  if (!src) return <span className="sbadge un">UNSOURCED</span>;
  if (src.type === 'dart')
    return <span className="sbadge src" title={`rcpNo ${src.rcept_no}`}>공시 {src.rcept_dt ?? ''}</span>;
  if (src.type === 'krx')
    return <span className="sbadge src" title={src.label}>시세 {src.as_of}</span>;
  return <span className="sbadge src" title={src.url}>뉴스 {(src.pub_date || '').slice(0, 10)}</span>;
}

type Turn = {
  q: string;
  routing?: ChatRouting;
  streaming: string;
  answer?: ChatAnswer;
  blocked?: string[];
  error?: string;
  running: boolean;
};

export default function F1Chat({ initial }: { initial?: string } = {}) {
  // 상담 준비 메모에서 종목을 눌러 열면 질문이 채워진 채로 시작한다. **보내지는 않는다** —
  // 실행은 크레딧을 쓰고 답변은 고객 앞에서 쓰일 수 있으니, 시작 버튼은 사람이 누른다.
  const [input, setInput] = useState(initial ?? '');
  const [turns, setTurns] = useState<Turn[]>([]);
  // 멀티턴: 백엔드가 발급한 세션 id를 들고 다음 턴에 붙인다 → "관련 뉴스는?"이 종목을 이어받는다.
  const sessionRef = useRef<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const running = turns.length > 0 && turns[turns.length - 1].running;

  useEffect(() => () => esRef.current?.close(), []);
  useEffect(() => { scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight); }, [turns]);

  const patchLast = (p: Partial<Turn>) =>
    setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? { ...t, ...p } : t)));

  function send() {
    const q = input.trim();
    if (!q || running) return;
    setInput('');
    setTurns((ts) => [...ts, { q, streaming: '', running: true }]);

    const es = new EventSource(chatStreamUrl(q, sessionRef.current));
    esRef.current = es;
    let done = false;

    es.addEventListener('session', (e) => { sessionRef.current = JSON.parse((e as MessageEvent).data).session; });
    es.addEventListener('routing', (e) => patchLast({ routing: JSON.parse((e as MessageEvent).data) }));
    es.addEventListener('blocked', (e) => patchLast({ blocked: JSON.parse((e as MessageEvent).data).violations }));
    es.addEventListener('answer_token', (e) =>
      setTurns((ts) => ts.map((t, i) => (i === ts.length - 1 ? { ...t, streaming: t.streaming + JSON.parse((e as MessageEvent).data).text } : t))),
    );
    es.addEventListener('answer', (e) => patchLast({ answer: JSON.parse((e as MessageEvent).data) }));
    es.addEventListener('run_error', (e) => patchLast({ error: JSON.parse((e as MessageEvent).data).message }));

    es.addEventListener('done', () => { done = true; es.close(); patchLast({ running: false }); });
    es.onerror = () => { es.close(); if (!done) patchLast({ running: false, error: '스트림이 끊겼습니다 (백엔드 확인).' }); };
  }

  return (
    <>
      <div className="m-head">
        <h3>종목 즉답 <span className="fcode">F1</span></h3>
        <span className="pill on" style={{ marginLeft: 8 }}>규칙 라우팅 · 멀티턴</span>
      </div>
      <div className="chat-hint">
        상담 중 나온 질문을 그대로 물어보세요 — 규칙 라우팅으로 알맞은 에이전트가 공개데이터만
        조회해 답합니다(고객에게 그대로 읽어주는 답변이 아니라, PB가 확인할 사실입니다). 예: <em>삼성전자 최근 실적</em> → <em>주가는?</em> → <em>관련 뉴스는?</em>
        <br />후속 질문은 <b>이전 종목을 이어받습니다</b>(멀티턴).
      </div>

      <div className="chat-log" ref={scrollRef}>
        {turns.length === 0 && <div className="chat-empty">질문을 입력하면 대화가 시작됩니다.</div>}
        {turns.map((t, i) => (
          <div key={i} className="chat-turn">
            <div className="bubble me">{t.q}</div>

            <div className="bubble ai">
              {t.routing && !t.routing.need_clarify && (
                <div className="route-badge" title={t.routing.reason}>
                  라우팅 → <b>{t.routing.agent ? AGENT_LABEL[t.routing.agent] : '—'}</b>
                  <span className="route-entity">{t.routing.entity_name ?? t.routing.entity_code}</span>
                  {t.routing.inherited && <span className="route-carry" title="이전 질문의 종목을 이어받았습니다">↩ 이어받음</span>}
                </div>
              )}

              {t.blocked && (
                <div className="chat-blocked">
                  ⛔ 입력이 차단됐습니다 (에이전트를 실행하지 않았습니다)
                  <ul>{t.blocked.map((v, j) => <li key={j}>{v}</li>)}</ul>
                </div>
              )}

              {/* 최종 답변: 문장별 출처 배지 */}
              {t.answer && !t.answer.clarify && (
                <div className="chat-answer">
                  {t.answer.sentences.map((s, j) => (
                    <div className="chat-sent" key={j}>
                      <span>{s.text}</span>
                      {(s.sources?.length ? s.sources : s.source ? [s.source] : []).map((src, k) => (
                        <SrcBadge key={k} src={src} />
                      ))}
                      {!s.source && !s.sources?.length && (
                        s.kind === 'interpretation'
                          ? <span className="sbadge itp" title="해석·전망 문장은 각주 대상이 아닙니다">해석</span>
                          : <SrcBadge src={null} />
                      )}
                    </div>
                  ))}
                  {t.answer.notice && <div className="chat-notice">{t.answer.notice}</div>}
                </div>
              )}

              {/* clarify: 종목 되묻기 */}
              {t.answer?.clarify && <div className="chat-clarify">{t.answer.text}</div>}

              {/* 스트리밍 중(최종 answer 도착 전) */}
              {!t.answer && !t.blocked && t.streaming && (
                <div className="chat-streaming">{t.streaming}{t.running && <span className="gen-caret">▌</span>}</div>
              )}
              {!t.answer && !t.blocked && !t.streaming && t.running && (
                <div className="chat-thinking">조회 중…</div>
              )}
              {t.error && <div className="chat-blocked">⛔ {t.error}</div>}
            </div>
          </div>
        ))}
      </div>

      <div className="chat-input">
        <input
          className="search"
          placeholder="예: 삼성전자 최근 실적 어때?"
          value={input}
          disabled={running}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
        />
        <button className="btn primary" onClick={send} disabled={running || !input.trim()}>
          {running ? '…' : '보내기'}
        </button>
      </div>
    </>
  );
}
