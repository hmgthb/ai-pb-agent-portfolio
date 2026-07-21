'use client';

/** 리서치 노트 생성 (F3) — 시안의 setTimeout 시뮬레이션을 실제 SSE로 대체한 카드.
 *
 *  `GET /api/research/stream`이 흘리는 이벤트를 그대로 화면에 옮긴다:
 *    progress    → a1 → a2‖a4 → a5 단계 타임라인
 *    card        → 재무·뉴스 도착 배지
 *    note_token  → 노트 본문 점진 렌더 (W4 토큰 스트리밍)
 *    note        → 초안 생성 완료 → 승인 대기 큐 갱신
 */

import { useEffect, useRef, useState } from 'react';
import { streamUrl } from './api';

type StepState = 'idle' | 'run' | 'done' | 'fail';
type Agent = 'a1' | 'a2' | 'a4' | 'a5';
type Steps = Record<Agent, StepState>;

const IDLE: Steps = { a1: 'idle', a2: 'idle', a4: 'idle', a5: 'idle' };

const LABEL: Record<Agent, string> = {
  a1: 'a1 법인 확인',
  a2: 'a2 재무 핵심수치',
  a4: 'a4 뉴스',
  a5: 'a5 노트 초안 작성',
};

type ProgressEvent = { agent: Agent | 'O'; step: string; status: string };
type NoteEvent = { id: number; corp_name: string; violations: string[] };

type Financials = {
  corp_name: string;
  bsns_year: string;
  fs_div: string;
  figures: Record<string, { 당기: string; 전기: string }>;
};
type NewsItem = { title: string; link: string; pub_date: string };
type SourceEvent = { rcept_no: string; viewer_url: string; rcept_dt: string | null };
type CardEvent =
  | ({ type: 'financials' } & Financials)
  | { type: 'news'; items: NewsItem[] };

/** DART 금액(원 단위 문자열)을 조/억 단위로 — 원문 값은 노트 각주가 보존한다. */
function fmtWon(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  if (Math.abs(n) >= 1e12) return `${(n / 1e12).toFixed(1)}조원`;
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(0)}억원`;
  return `${n.toLocaleString()}원`;
}

const yoy = (cur: string, prev: string): string | null => {
  const c = Number(cur), p = Number(prev);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  const pct = ((c - p) / Math.abs(p)) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
};

export default function ResearchCard({ onNoteCreated }: { onNoteCreated: () => void }) {
  const [code, setCode] = useState('');
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Steps>(IDLE);
  const [corp, setCorp] = useState('');
  // 부분결과 점진 렌더(W3) — 먼저 끝난 에이전트의 결과부터 도착 순서대로 쌓인다.
  const [financials, setFinancials] = useState<Financials | null>(null);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [sources, setSources] = useState<SourceEvent[]>([]);
  const [noteText, setNoteText] = useState('');
  const [msg, setMsg] = useState('');
  const [started, setStarted] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  // 페이지를 떠날 때 스트림을 닫는다 — 안 닫으면 백엔드 쪽 에이전트 실행이 계속 돈다.
  useEffect(() => () => esRef.current?.close(), []);

  /** 'fail'은 덮어쓰지 않는다 — 뒤 단계가 진행돼도 실패한 단계는 실패로 남아야 한다. */
  const mark = (agent: Agent, state: StepState) =>
    setSteps((prev) => (prev[agent] === 'fail' ? prev : { ...prev, [agent]: state }));

  function handleProgress(d: ProgressEvent) {
    if (d.status === 'failed' && d.agent !== 'O') {
      setSteps((prev) => ({ ...prev, [d.agent]: 'fail' }));
      return;
    }
    if (d.step !== 'delegated' && d.step !== 'note_draft') return; // 도구 단위 이벤트는 배지로만
    if (d.status === 'started') {
      if (d.agent === 'a1') mark('a1', 'run');
      if (d.agent === 'a2' || d.agent === 'a4') {
        mark('a1', 'done');
        mark(d.agent, 'run');
      }
      if (d.agent === 'a5') {
        mark('a2', 'done');
        mark('a4', 'done');
        mark('a5', 'run');
      }
    }
    if (d.agent === 'a5' && d.step === 'note_draft' && d.status !== 'started') {
      mark('a5', d.status === 'completed' ? 'done' : 'fail');
    }
  }

  function start() {
    if (running) return;
    if (!/^\d{6}$/.test(code.trim())) {
      setMsg('종목코드는 6자리 숫자여야 합니다.');
      return;
    }
    setRunning(true);
    setStarted(true);
    setSteps(IDLE);
    setCorp('');
    setNoteText('');
    setFinancials(null);
    setNews([]);
    setSources([]);
    setMsg('에이전트를 실행하고 있습니다 — 완료까지 1~2분 걸립니다.');

    const es = new EventSource(streamUrl(code.trim()));
    esRef.current = es;
    let noteArrived = false;

    es.addEventListener('progress', (e) => handleProgress(JSON.parse((e as MessageEvent).data)));

    es.addEventListener('card', (e) => {
      const d: CardEvent = JSON.parse((e as MessageEvent).data);
      if (d.type === 'financials') {
        setFinancials(d);
        if (d.corp_name) setCorp(d.corp_name);
      }
      if (d.type === 'news') setNews(d.items ?? []);
    });

    es.addEventListener('source', (e) => {
      const d: SourceEvent = JSON.parse((e as MessageEvent).data);
      setSources((prev) => (prev.some((s) => s.rcept_no === d.rcept_no) ? prev : [...prev, d]));
    });

    es.addEventListener('note_token', (e) => {
      const d: { text: string } = JSON.parse((e as MessageEvent).data);
      setNoteText((prev) => prev + d.text);
    });

    es.addEventListener('note', (e) => {
      const d: NoteEvent = JSON.parse((e as MessageEvent).data);
      noteArrived = true;
      setCorp(d.corp_name);
      setMsg(
        `${d.corp_name}(${code.trim()}) 노트 초안 생성 완료 — 승인 대기 큐에 올라갔습니다.` +
          (d.violations.length ? ` 게이트 지적 ${d.violations.length}건은 검토 화면에서 확인하세요.` : ''),
      );
      onNoteCreated();
    });

    es.addEventListener('done', () => {
      es.close();
      setRunning(false);
      if (!noteArrived) {
        setMsg('에이전트 실행은 끝났지만 노트가 생성되지 않았습니다 — 진행 단계에서 실패 지점을 확인하세요.');
      }
    });

    es.onerror = () => {
      es.close();
      setRunning(false);
      if (!noteArrived) setMsg('스트림이 끊겼습니다. 백엔드 로그를 확인하세요.');
    };
  }

  const chip = (agent: Agent) => {
    const state = steps[agent];
    const suffix =
      state === 'done' && agent === 'a1' && corp ? ` ✓ ${corp}` : state === 'done' ? ' ✓' : '';
    return (
      <span className={`step ${state === 'idle' ? '' : state}`}>
        {LABEL[agent]}
        {suffix}
      </span>
    );
  };

  return (
    <section className="card" aria-labelledby="g-title" id="research-card">
      <div className="card-head">
        <h2 id="g-title">리서치 노트 생성</h2>
        <span className="hint">
          종목코드 하나로 멀티에이전트 파이프라인 실행 — 초안은 승인 대기로 들어갑니다
        </span>
        <span className="src live">실제 에이전트 실행 · 1~2분</span>
      </div>

      <div className="gen-row">
        <input
          className="search"
          inputMode="numeric"
          maxLength={6}
          placeholder="종목코드 6자리 (예: 035420)"
          aria-label="종목코드"
          value={code}
          disabled={running}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') start();
          }}
        />
        <button className="btn primary" onClick={start} disabled={running}>
          {running ? '생성 중…' : '노트 생성'}
        </button>
      </div>

      {started && (
        <div className="steps">
          {chip('a1')}
          <span className="sep">→</span>
          {chip('a2')}
          <span className="sep">∥</span>
          {chip('a4')}
          <span className="sep">→</span>
          {chip('a5')}
        </div>
      )}

      {/* 부분결과 — 에이전트가 끝나는 대로 하나씩 등장한다 (W3 점진 렌더) */}
      {(financials || news.length > 0) && (
        <div className="gen-cards">
          {financials && (
            <div className="gen-card">
              <div className="gen-card-head">
                <span className="chip note">a2 재무 핵심수치</span>
                <span className="bcode">
                  {financials.bsns_year} · {financials.fs_div === 'CFS' ? '연결' : '별도'}
                </span>
              </div>
              <table className="holdings">
                <tbody>
                  {Object.entries(financials.figures).map(([item, v]) => {
                    const d = yoy(v.당기, v.전기);
                    return (
                      <tr key={item}>
                        <td>{item}</td>
                        <td className="num">{fmtWon(v.당기)}</td>
                        <td className="num">
                          {d && <span className={`delta ${d.startsWith('-') ? 'down' : 'up'}`}>{d}</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {sources.map((s) => (
                <div className="bline" key={s.rcept_no}>
                  <span className="btag">공시</span>
                  <span style={{ minWidth: 0 }}>
                    <a href={s.viewer_url} target="_blank" rel="noreferrer">원문 {s.rcept_no}</a>
                    <span className="bcode"> {s.rcept_dt ?? '접수일 미상'}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
          {news.length > 0 && (
            <div className="gen-card">
              <div className="gen-card-head">
                <span className="chip chat">a4 뉴스</span>
                <span className="bcode">{news.length}건</span>
              </div>
              {news.slice(0, 5).map((n, i) => (
                <div className="bline" key={i}>
                  <span className="btag">뉴스</span>
                  <span style={{ minWidth: 0 }}>
                    <a href={n.link} target="_blank" rel="noreferrer">{n.title}</a>
                    <span className="bcode"> {(n.pub_date || '').slice(0, 16)}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 토큰 스트리밍 — note 이벤트가 오기 전까지 a5가 쓰는 대로 흐른다 */}
      {noteText && (
        <div className="gen-note" aria-live="polite">
          <div className="gen-note-label">
            a5 초안 작성 중 {running && <span className="gen-caret">▌</span>}
          </div>
          {noteText}
        </div>
      )}

      {msg && <div className="hint" style={{ marginTop: 8 }}>{msg}</div>}
    </section>
  );
}
