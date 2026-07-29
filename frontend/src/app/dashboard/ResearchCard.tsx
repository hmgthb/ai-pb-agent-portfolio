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
import { fmtDate, streamUrl } from './api';

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

/** 3시나리오(공시 없음·파싱 실패·뉴스 없음)를 화면이 구분해 말하기 위한 백엔드 판정.
 *  `reasons`는 사람이 읽을 문장이고, 나머지는 빈 상태 렌더링용 플래그다. */
type Outcome = {
  note_created: boolean;
  has_financials: boolean;
  news_count: number;
  disclosure_count: number;
  failed_tools: string[];
  reasons: string[];
};
type DoneEvent = { unsourced_agents: string[]; outcome: Outcome | null };

type Financials = {
  corp_name: string;
  bsns_year: string;
  fs_div: string;
  figures: Record<string, { 당기: string; 전기: string }>;
};
type NewsItem = { title: string; link: string; pub_date: string };
type SourceEvent = {
  rcept_no: string;
  viewer_url: string;
  rcept_dt: string | null;
};
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
  const c = Number(cur),
    p = Number(prev);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  const pct = ((c - p) / Math.abs(p)) * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
};

export default function ResearchCard({
  onNoteCreated,
  onRunningChange,
  actor,
}: {
  onNoteCreated: () => void;
  /** 실행 중인지를 밖에 알린다 — 이 카드는 전용 탭에 있어서, 다른 탭을 보고 있으면
   *  1~2분짜리 실행이 도는지 알 길이 없다. 탭 라벨에 표시를 띄우기 위한 것. */
  onRunningChange?: (running: boolean) => void;
  /** 이 노트를 만든 사람(목 로그인) — 처리 대기에서 자기 노트를 찾는 축이 된다 */
  actor: string;
}) {
  const [code, setCode] = useState('');
  const [running, setRunning] = useState(false);
  /** setRunning과 항상 짝으로 부른다 — 한쪽만 바꾸면 탭 표시가 실제 상태와 갈라진다.
   *  (effect로 running을 감시하지 않는 이유: 부모 setState를 effect에서 부르면
   *   렌더가 한 번 더 도는데, 전이 지점이 세 곳뿐이라 직접 부르는 게 정확하다.) */
  const setRun = (v: boolean) => {
    setRunning(v);
    onRunningChange?.(v);
  };
  const [steps, setSteps] = useState<Steps>(IDLE);
  const [corp, setCorp] = useState('');
  // 부분결과 점진 렌더(W3) — 먼저 끝난 에이전트의 결과부터 도착 순서대로 쌓인다.
  const [financials, setFinancials] = useState<Financials | null>(null);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [sources, setSources] = useState<SourceEvent[]>([]);
  const [noteText, setNoteText] = useState('');
  /* 카드 하단 한 줄은 **다섯 가지가 나눠 쓴다** — 입력 검증 실패·실행 중 안내·생성 완료·
     노트 미생성·없음. 종류를 안 붙이면 전부 같은 회색이라 경고가 경고로 안 읽힌다.
     (그래서 문자열이 아니라 {kind, text}다. 색은 kind가 정한다.) */
  const [msg, setMsg] = useState<{
    kind: 'error' | 'info' | 'done';
    text: string;
  } | null>(null);
  /* 입력칸의 오류 상태는 msg와 따로 둔다 — "노트가 생성되지 않았습니다"도 error지만
     그건 입력 탓이 아니라서 입력칸을 빨갛게 만들면 안 된다. */
  const [codeInvalid, setCodeInvalid] = useState(false);
  const [started, setStarted] = useState(false);
  // 실행이 끝난 뒤에만 빈 상태를 말한다 — 진행 중에 "뉴스 0건"을 띄우면 아직 안 온 것을
  // 없다고 단정하게 된다.
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [failed, setFailed] = useState('');
  const esRef = useRef<EventSource | null>(null);

  // 페이지를 떠날 때 스트림을 닫는다 — 안 닫으면 백엔드 쪽 에이전트 실행이 계속 돈다.
  useEffect(() => () => esRef.current?.close(), []);

  /** 'fail'은 덮어쓰지 않는다 — 뒤 단계가 진행돼도 실패한 단계는 실패로 남아야 한다. */
  const mark = (agent: Agent, state: StepState) =>
    setSteps((prev) =>
      prev[agent] === 'fail' ? prev : { ...prev, [agent]: state },
    );

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

  /** 규칙을 읽어 주는 대신 **할 일**을 말한다. 입력이 숫자만 받고 6자에서 잘리므로
      실패 경우는 "덜 채움" 하나뿐이라, 문구도 하나면 된다.
      (자릿수를 세어 알려주던 버전은 뺐다 — 입력칸을 보면 이미 아는 수다.) */
  const shortMsg = () => '종목 코드 6자리를 입력해 주세요.';

  function start() {
    if (running) return;
    const v = code.trim();
    if (!/^\d{6}$/.test(v)) {
      setCodeInvalid(true);
      setMsg({ kind: 'error', text: shortMsg() });
      return;
    }
    setCodeInvalid(false);
    setRun(true);
    setStarted(true);
    setSteps(IDLE);
    setCorp('');
    setNoteText('');
    setFinancials(null);
    setNews([]);
    setSources([]);
    setOutcome(null);
    setFailed('');
    setMsg({
      kind: 'info',
      text: '에이전트를 실행하고 있습니다 — 완료까지 1~2분 걸립니다.',
    });

    const es = new EventSource(streamUrl(code.trim(), actor));
    esRef.current = es;
    let noteArrived = false;
    // done을 받고 우리가 닫으면 EventSource가 onerror를 한 번 부른다 — 그건 실패가 아니다.
    let closedCleanly = false;
    let runErrored = false;

    es.addEventListener('progress', (e) =>
      handleProgress(JSON.parse((e as MessageEvent).data)),
    );

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
      setSources((prev) =>
        prev.some((s) => s.rcept_no === d.rcept_no) ? prev : [...prev, d],
      );
    });

    es.addEventListener('note_token', (e) => {
      const d: { text: string } = JSON.parse((e as MessageEvent).data);
      setNoteText((prev) => prev + d.text);
    });

    es.addEventListener('note', (e) => {
      const d: NoteEvent = JSON.parse((e as MessageEvent).data);
      noteArrived = true;
      setCorp(d.corp_name);
      setMsg({
        kind: 'done',
        text:
          `${d.corp_name}(${code.trim()}) 종목 노트 초안 생성 완료 — 처리 대기 큐에 올라갔습니다.` +
          (d.violations.length
            ? ` 게이트 지적 ${d.violations.length}건은 검토 화면에서 확인하세요.`
            : ''),
      });
      onNoteCreated();
    });

    // 백엔드가 예외를 삼키지 않고 흘려보낸다 — 스트림이 조용히 끊기던 것과 구분된다.
    // 이벤트명이 'error'가 아닌 이유: EventSource의 연결 오류 핸들러와 이름이 겹친다.
    es.addEventListener('run_error', (e) => {
      const d: { message: string } = JSON.parse((e as MessageEvent).data);
      runErrored = true;
      setFailed(d.message);
    });

    es.addEventListener('done', (e) => {
      closedCleanly = true;
      es.close();
      setRun(false);
      const d: DoneEvent = JSON.parse((e as MessageEvent).data);
      setOutcome(d.outcome);
      // 스트림이 끝났으면 아무 단계도 더 이상 돌고 있지 않다. 'run'인 채로 두면 아직
      // 도는 것처럼 보인다. 데이터가 비었는지는 아래 카드가 말하므로 칩은 진행만 나타낸다.
      // 단 예외로 중단된 실행은 완료가 아니다 — ✓로 바꾸면 성공했다고 거짓말하게 된다.
      const settled: StepState = runErrored ? 'fail' : 'done';
      setSteps(
        (prev) =>
          Object.fromEntries(
            Object.entries(prev).map(([k, v]) => [
              k,
              v === 'run' ? settled : v,
            ]),
          ) as Steps,
      );
      // 오류 배너가 이미 이유를 말하고 있으면 안내문을 겹쳐 띄우지 않는다.
      if (!noteArrived && !runErrored) {
        setMsg({
          kind: 'error',
          text: d.outcome?.reasons.length
            ? '노트가 생성되지 않았습니다 — 아래 사유를 확인하세요.'
            : '에이전트 실행은 끝났지만 노트가 생성되지 않았습니다 — 진행 단계에서 실패 지점을 확인하세요.',
        });
      }
      if (runErrored) setMsg(null);
    });

    es.onerror = () => {
      es.close();
      setRun(false);
      // done까지 정상 수신한 뒤 닫히면서 나는 onerror는 실패가 아니다.
      if (!noteArrived && !closedCleanly) {
        setFailed(
          '스트림이 끊겼습니다 (백엔드에 연결할 수 없거나 실행 중 중단됨).',
        );
        setMsg(null);
      }
    };
  }

  const chip = (agent: Agent) => {
    const state = steps[agent];
    const suffix =
      state === 'done' && agent === 'a1' && corp
        ? ` ✓ ${corp}`
        : state === 'done'
          ? ' ✓'
          : '';
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
        <h2 id="g-title">종목 노트 생성</h2>
      </div>

      <div className="gen-row">
        <input
          className="search"
          inputMode="numeric"
          maxLength={6}
          placeholder="000000"
          aria-label="종목 코드"
          /* 브라우저 자동완성을 끈다 — 안 끄면 6자리 숫자 칸에 저장된 이름·주소가 뜬다.
             localhost:3000은 다른 프로젝트와 오리진을 공유해서 남의 입력 이력까지 올라온다. */
          autoComplete="off"
          /* 입력칸도 같이 오류 상태가 된다 — 메시지만 빨개지면 "무엇이" 잘못됐는지는
             말하지 않는다. 테두리는 이 속성이 그대로 끌고 간다(dashboard.css). */
          aria-invalid={codeInvalid || undefined}
          aria-describedby={msg ? 'gen-msg' : undefined}
          value={code}
          disabled={running}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '');
            setCode(v);
            // 오류가 떠 있는 동안에는 남은 자릿수를 따라 고쳐 쓴다 — 한 자 칠 때마다
            // 6에 가까워지는 게 보여야 하고, 다 채우면 경고가 스스로 사라진다.
            if (!codeInvalid) return;
            if (v.length === 6) {
              setCodeInvalid(false);
              setMsg(null);
            } else {
              setMsg({ kind: 'error', text: shortMsg() });
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') start();
          }}
        />
        <button className="btn primary" onClick={start} disabled={running}>
          {running ? '생성 중…' : '생성'}
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

      {/* 부분결과 — 에이전트가 끝나는 대로 하나씩 등장한다 (W3 점진 렌더).
          실행이 끝난 뒤에는 확보하지 못한 항목도 빈 카드로 남겨 "왜 없는지"를 말한다. */}
      {(financials || news.length > 0 || outcome) && (
        <div className="gen-cards">
          {!financials && outcome && (
            <div className="gen-card empty">
              <div className="gen-card-head">
                <span className="chip note">a2 재무 핵심수치</span>
                <span className="bcode">확보 못 함</span>
              </div>
              <div className="empty-body">
                {outcome.failed_tools.includes('mcp__dart__dart_parse')
                  ? '재무제표 파싱에 실패했습니다. 연결재무제표(CFS)를 제출하지 않는 법인이거나, 해당 사업연도 보고서가 아직 없을 수 있습니다.'
                  : '재무 핵심수치를 확보하지 못했습니다.'}
                {outcome.disclosure_count === 0 &&
                  !outcome.failed_tools.includes('mcp__dart__dart_search') &&
                  ' 최근 공시도 0건입니다 — 조회는 정상 동작했습니다.'}
              </div>
            </div>
          )}
          {financials && (
            <div className="gen-card">
              <div className="gen-card-head">
                <span className="chip note">a2 재무 핵심수치</span>
                <span className="bcode">
                  {financials.bsns_year} ·{' '}
                  {financials.fs_div === 'CFS' ? '연결' : '별도'}
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
                          {d && (
                            <span
                              className={`delta ${d.startsWith('-') ? 'down' : 'up'}`}
                            >
                              {d}
                            </span>
                          )}
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
                    <a href={s.viewer_url} target="_blank" rel="noreferrer">
                      원문 {s.rcept_no}
                    </a>
                    <span className="bcode">
                      {' '}
                      {fmtDate(s.rcept_dt) || '접수일 미상'}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
          {news.length === 0 && outcome && (
            <div className="gen-card empty">
              <div className="gen-card-head">
                <span className="chip chat">a4 뉴스</span>
                <span className="bcode">0건</span>
              </div>
              <div className="empty-body">
                {outcome.failed_tools.includes('mcp__news__news_search')
                  ? '뉴스 조회에 실패했습니다 (뉴스 API 오류).'
                  : '관련 뉴스가 없습니다 — 조회는 정상 동작했고 결과가 0건입니다.'}
              </div>
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
                    <a href={n.link} target="_blank" rel="noreferrer">
                      {n.title}
                    </a>
                    <span className="bcode"> {fmtDate(n.pub_date)}</span>
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

      {failed && (
        <div className="vbox" style={{ marginTop: 10 }}>
          ⛔ {failed}
        </div>
      )}

      {/* 노트가 나왔더라도 부분적으로 빠진 게 있으면 숨기지 않고 알린다 */}
      {outcome && outcome.reasons.length > 0 && (
        <div className="gen-reasons" role="status">
          <div className="gen-reasons-label">
            {outcome.note_created
              ? '확보하지 못한 데이터'
              : '노트를 만들지 못한 이유'}
          </div>
          <ul>
            {outcome.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {/* role은 종류에 따라 다르다 — 오류는 스크린리더를 끊고 즉시 읽어야 하지만(alert),
          "실행 중"·"생성 완료"는 하던 읽기를 끊을 일이 아니다(status).
          색만으로 경고를 말하지 않는다: ⚠를 같이 단다. */}
      {msg && (
        <div
          id="gen-msg"
          className={`hint ${msg.kind}`}
          role={msg.kind === 'error' ? 'alert' : 'status'}
        >
          {msg.kind === 'error' && <span aria-hidden="true">⚠ </span>}
          {msg.text}
        </div>
      )}
    </section>
  );
}
