'use client';

import { useRef, useState } from 'react';

type FinancialsCard = {
  type: 'financials';
  agent: string;
  corp_name: string;
  stock_code: string;
  bsns_year: string;
  fs_div: string;
  figures: Record<string, { 당기: string; 전기: string }>;
};

type NewsItem = {
  title: string;
  description: string;
  link: string;
  pub_date: string;
};
type NewsCard = { type: 'news'; agent: string; items: NewsItem[] };
type CardData = FinancialsCard | NewsCard;

type ProgressEvent = {
  agent: string;
  step: string;
  status: 'started' | 'running' | 'completed' | 'failed';
  parallel_group: string | null;
};

type AgentState = 'pending' | 'running' | 'done';
type TextEvent = { agent: string; text: string };
type SourceEvent = {
  agent: string;
  rcept_no: string;
  viewer_url: string;
  rcept_dt: string | null;
};

type NoteSource =
  | { type: 'dart'; rcept_no: string; viewer_url: string; rcept_dt: string | null }
  | { type: 'news'; url: string; title: string; pub_date: string };
type NoteSentence = { text: string; source: NoteSource | null; is_heading: boolean };
type NoteEvent = {
  id: number;
  status: NoteStatus;
  corp_name: string;
  sentences: NoteSentence[];
  violations: string[];
};
type NoteStatus = 'draft' | 'review' | 'deliberation' | 'published';
type AuditEntry = {
  event_type: string;
  actor: string | null;
  ts: string;
  detail: Record<string, unknown>;
};
type NoteDetail = {
  id: number;
  stock_code: string;
  corp_name: string;
  status: NoteStatus;
  content_md: string;
  sentences: NoteSentence[];
  violations: string[];
  reviewer: string | null;
  deliberator: string | null;
  publisher: string | null;
  audit_log: AuditEntry[];
};

const STATUS_LABEL: Record<NoteStatus, string> = {
  draft: '초안',
  review: '검토',
  deliberation: '심의',
  published: '발행완료',
};

const NOTE_WATERMARK =
  '⚠ AI 초안 · 미검증 — 사람의 검토·심의·승인 없이는 발행되지 않습니다.';

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000';

const FIGURE_ORDER = ['매출액', '영업이익'];

const cardDividerStyle = {
  border: 'none',
  borderTop: '1px solid #ddd',
  margin: '8px 0 12px',
};

function formatWon(raw: string): string {
  const n = Number(raw);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const jo = Math.floor(abs / 1_0000_0000_0000);
  const eok = Math.round((abs % 1_0000_0000_0000) / 1_0000_0000);
  const eokStr = eok.toLocaleString('ko-KR');
  return jo > 0 ? `${sign}${jo}조 ${eokStr}억원` : `${sign}${eokStr}억원`;
}

function formatYoY(cur: string, prev: string): string {
  const c = Number(cur);
  const p = Number(prev);
  if (p === 0) return '—';
  const pct = ((c - p) / Math.abs(p)) * 100;
  return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

type FigureRow = { name: string; cur: string; prev: string; yoy: string };

function operatingMarginRow(
  figures: FinancialsCard['figures'],
): FigureRow | null {
  const revenue = figures['매출액'];
  const opIncome = figures['영업이익'];
  if (!revenue || !opIncome) return null;
  const revCur = Number(revenue.당기);
  const revPrev = Number(revenue.전기);
  if (revCur === 0 || revPrev === 0) return null;
  const curPct = (Number(opIncome.당기) / revCur) * 100;
  const prevPct = (Number(opIncome.전기) / revPrev) * 100;
  const diff = curPct - prevPct;
  return {
    name: '영업이익률',
    cur: `${curPct.toFixed(1)}%`,
    prev: `${prevPct.toFixed(1)}%`,
    yoy: `${diff > 0 ? '+' : ''}${diff.toFixed(1)}%p`,
  };
}

function extractCorpName(a1Text: string): string | null {
  const idx = a1Text.lastIndexOf('=');
  if (idx === -1) return null;
  return (
    a1Text
      .slice(idx + 1)
      .replace(/\*/g, '')
      .trim() || null
  );
}

function formatRceptDt(raw: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : raw;
}

function formatPubDate(raw: string): string {
  return new Date(raw).toLocaleString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function Home() {
  const [stockCode, setStockCode] = useState('');
  const [timeline, setTimeline] = useState<string[]>([]);
  const [agentStatus, setAgentStatus] = useState<Record<string, AgentState>>(
    {},
  );
  const [cards, setCards] = useState<CardData[]>([]);
  const [texts, setTexts] = useState<TextEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [showTexts, setShowTexts] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [unsourcedAgents, setUnsourcedAgents] = useState<string[]>([]);
  const [sources, setSources] = useState<Record<string, SourceEvent>>({});
  const [inputError, setInputError] = useState<string | null>(null);
  const [note, setNote] = useState<NoteEvent | null>(null);
  const [noteDetail, setNoteDetail] = useState<NoteDetail | null>(null);
  const [actorName, setActorName] = useState('');
  const [noteActionError, setNoteActionError] = useState<string | null>(null);
  const [noteActionLoading, setNoteActionLoading] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  // 재무 카드가 하나라도 왔는지 추적 — done 시점에 하나도 없으면 존재하지 않는
  // 종목코드로 판단한다. state는 이벤트 핸들러 클로저 안에서 stale할 수 있어 ref로 둔다.
  const gotFinancialsRef = useRef(false);
  // 서브에이전트 위임이 한 번이라도 일어났는지 추적. 재무 카드가 없어도, a1 위임 자체가
  // 없었다면 그건 "존재하지 않는 종목코드"가 아니라 O가 시작도 못 한 것이다(크레딧 부족
  // 등 시스템 오류) — 이 구분이 없으면 API 오류를 전부 "잘못된 종목코드"로 잘못 안내한다.
  const delegatedRef = useRef(false);
  // 위 시스템 오류일 때 사용자에게 원인을 그대로 보여주기 위해 O의 마지막 텍스트를 잡아둔다.
  const lastOTextRef = useRef('');

  async function refreshNote(id: number) {
    try {
      const res = await fetch(`${API_BASE}/api/notes/${id}`);
      if (res.ok) setNoteDetail(await res.json());
    } catch {
      // 네트워크 에러는 조용히 무시 — SSE로 이미 받은 초안 스냅샷으로도 화면은 뜬다.
    }
  }

  async function doNoteAction(id: number, action: 'review' | 'deliberate' | 'publish') {
    if (!actorName.trim()) {
      setNoteActionError('처리자 이름을 입력해주세요.');
      return;
    }
    setNoteActionError(null);
    setNoteActionLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/notes/${id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actor: actorName.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        const violations: string[] | undefined = body?.detail?.violations;
        const message: string | undefined =
          body?.detail?.message ?? (typeof body?.detail === 'string' ? body.detail : undefined);
        setNoteActionError(
          violations?.length
            ? `게이트 위반: ${violations.join(' / ')}`
            : (message ?? '처리에 실패했습니다.'),
        );
        return;
      }
      await refreshNote(id);
    } finally {
      setNoteActionLoading(false);
    }
  }

  function run() {
    if (!/^\d{6}$/.test(stockCode)) {
      setInputError('6자리 종목코드를 입력해주세요.');
      return;
    }
    setInputError(null);
    esRef.current?.close();
    setCards([]);
    setTimeline([]);
    setAgentStatus({});
    setTexts([]);
    setUnsourcedAgents([]);
    setSources({});
    setNote(null);
    setNoteDetail(null);
    setNoteActionError(null);
    gotFinancialsRef.current = false;
    delegatedRef.current = false;
    lastOTextRef.current = '';
    setLoading(true);

    const es = new EventSource(
      `${API_BASE}/api/research/stream?stock_code=${stockCode}`,
    );
    esRef.current = es;

    es.addEventListener('progress', (e) => {
      const data: ProgressEvent = JSON.parse(e.data);
      setTimeline((prev) => [
        ...prev,
        `[${data.agent}]${data.parallel_group ? ' ⇉' : ''} ${data.step} — ${data.status}`,
      ]);
      if (data.step === 'delegated' && data.status === 'started') {
        delegatedRef.current = true;
        setAgentStatus((prev) => ({ ...prev, [data.agent]: 'running' }));
      }
      // a1은 법인명 확인만 하고 카드를 만들지 않는 에이전트라 'card' 이벤트로는
      // 절대 done이 안 된다 — 자기 도구 호출이 완료되는 시점을 done 신호로 쓴다.
      if (data.agent === 'a1' && data.status === 'completed') {
        setAgentStatus((prev) => ({ ...prev, a1: 'done' }));
      }
    });
    es.addEventListener('text', (e) => {
      const data: TextEvent = JSON.parse(e.data);
      if (data.agent === 'O') lastOTextRef.current = data.text;
      setTexts((prev) => [...prev, data]);
    });
    es.addEventListener('source', (e) => {
      const data: SourceEvent = JSON.parse(e.data);
      setSources((prev) => ({ ...prev, [data.agent]: data }));
    });
    es.addEventListener('card', (e) => {
      const data: CardData = JSON.parse(e.data);
      if (data.type === 'financials') {
        gotFinancialsRef.current = true;
      }
      const cardKey = (c: CardData) =>
        c.type === 'financials'
          ? `${c.agent}-financials-${c.fs_div}`
          : `${c.agent}-${c.type}`;
      setCards((prev) => {
        let next = prev;
        if (data.type === 'financials') {
          // 에이전트가 종목코드를 스스로 정정하는 경우(예: 처음 짚은 회사가 실제로는
          // 다른 법인이었음을 뒤늦게 확인), 정정 전 법인의 카드는 완전히 무효다 —
          // "조회한 종목코드"가 아니라 "이 에이전트가 지금 말하는 법인명"이 바뀌면
          // 그 에이전트의 이전 재무 카드를 전부 버린다(CFS/OFS 포함).
          const pivoted = prev.some(
            (c) =>
              c.type === 'financials' &&
              c.agent === data.agent &&
              c.corp_name !== data.corp_name,
          );
          if (pivoted) {
            next = next.filter(
              (c) => !(c.type === 'financials' && c.agent === data.agent),
            );
          }
        }
        // 같은 에이전트가 같은 종류의 도구를 여러 번 호출할 수 있다(예: 검색어를 바꿔 재조회) —
        // 매번 새 카드를 쌓지 않고 같은 키의 카드는 최신 결과로 교체한다. 재무 카드는
        // CFS·OFS가 서로 다른 정보라 fs_div까지 키에 포함해 둘 다 유지되게 한다.
        return [...next.filter((c) => cardKey(c) !== cardKey(data)), data];
      });
      // 카드(핵심 결과)가 도착한 시점을 그 에이전트의 완료로 본다 — SDK가 별도의
      // "서브에이전트 완료" 이벤트를 주지 않고, Agent 도구 결과는 디스패치 ack일 뿐이다.
      setAgentStatus((prev) => ({ ...prev, [data.agent]: 'done' }));
    });
    es.addEventListener('note', (e) => {
      const data: NoteEvent = JSON.parse(e.data);
      setNote(data);
      void refreshNote(data.id);
    });
    es.addEventListener('done', (e) => {
      const data: { unsourced_agents?: string[] } = JSON.parse(e.data);
      setUnsourcedAgents(data.unsourced_agents ?? []);
      if (!gotFinancialsRef.current) {
        // a1 위임 자체가 없었다면 종목코드 문제가 아니라 O가 시작도 못 한 것이다
        // (예: API 크레딧 부족) — 이 경우엔 종목코드를 탓하지 말고 실제 원인을 보여준다.
        setInputError(
          delegatedRef.current
            ? '해당 종목코드의 재무 데이터를 찾을 수 없습니다. 실제 6자리 종목코드를 입력해주세요.'
            : `에이전트 처리 중 오류가 발생했습니다${lastOTextRef.current ? `: ${lastOTextRef.current}` : ''}`,
        );
      }
      setLoading(false);
      es.close();
    });
    es.onerror = () => {
      setLoading(false);
      es.close();
    };
  }

  const a1Text = [...texts].reverse().find((t) => t.agent === 'a1');
  const corpName = a1Text && extractCorpName(a1Text.text);

  // 카드 도착 순서는 a2·a4 병렬 실행 타이밍에 따라 달라지므로, 항상
  // 관련 뉴스 → 재무제표 순으로 고정해서 보여준다.
  const orderedCards = [...cards].sort((a, b) =>
    a.type === b.type ? 0 : a.type === 'news' ? -1 : 1,
  );

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif', maxWidth: 480 }}>
      <h1>종목 핵심수치 & 뉴스 조회</h1>
      <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        <input
          value={stockCode}
          onChange={(e) => {
            setStockCode(e.target.value);
            setInputError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !loading) run();
          }}
          placeholder="종목코드 (000000)"
          style={
            inputError
              ? { borderColor: '#dc2626', outlineColor: '#dc2626' }
              : undefined
          }
        />
        <button onClick={run} disabled={loading}>
          {loading ? '조회 중...' : '조회'}
        </button>
      </div>

      {inputError && (
        <p
          style={{
            color: '#dc2626',
            fontSize: 13,
            marginTop: -4,
            marginBottom: 12,
          }}
        >
          ⚠ {inputError}
        </p>
      )}

      {timeline.length > 0 && (
        <div>
          <button
            onClick={() => setShowTimeline((v) => !v)}
            style={{ fontSize: 12 }}
          >
            {showTimeline ? '▾' : '▸'} 진행 타임라인 ({timeline.length})
          </button>
          {showTimeline && (
            <>
              {Object.keys(agentStatus).length > 0 && (
                <div style={{ display: 'flex', gap: 8, margin: '8px 0' }}>
                  {Object.entries(agentStatus).map(([agent, status]) => (
                    <span
                      key={agent}
                      style={{
                        fontSize: 12,
                        padding: '2px 8px',
                        borderRadius: 12,
                        background:
                          status === 'done'
                            ? '#dcfce7'
                            : status === 'running'
                              ? '#fef9c3'
                              : '#eee',
                      }}
                    >
                      {agent}{' '}
                      {status === 'done'
                        ? '완료'
                        : status === 'running'
                          ? '실행 중'
                          : '대기'}
                    </span>
                  ))}
                </div>
              )}
              <ul style={{ fontSize: 12, color: '#666' }}>
                {timeline.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {texts.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <button
            onClick={() => setShowTexts((v) => !v)}
            style={{ fontSize: 12 }}
          >
            {showTexts ? '▾' : '▸'} 에이전트 진행 로그 ({texts.length})
          </button>
          {showTexts && (
            <div style={{ marginTop: 8 }}>
              {texts.map((t, i) => (
                <div key={i} style={{ fontSize: 13, marginBottom: 8 }}>
                  <b>[{t.agent}]</b>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{t.text}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {corpName && (
        <p style={{ fontSize: 22, color: 'black', marginTop: 16 }}>
          <b>
            {corpName} ({stockCode})
          </b>
        </p>
      )}

      {orderedCards.map((card, i) => {
        const unsourced = unsourcedAgents.includes(card.agent);
        const cardStyle = {
          border: unsourced ? '1.5px solid #d97706' : '1px solid #ccc',
          borderRadius: 8,
          padding: 16,
          marginTop: 16,
        };
        const unsourcedBadge = unsourced && (
          <p style={{ fontSize: 12, color: '#b45309', marginBottom: 8 }}>
            ⚠ 출처 미확인 — 원문 링크 조회 실패, 수치만 우선 표시
          </p>
        );
        return card.type === 'financials' ? (
          <div key={i} style={cardStyle}>
            {unsourcedBadge}
            <h2>
              {card.bsns_year}년 · {card.fs_div === 'CFS' ? '연결' : '별도'}
              재무제표
            </h2>
            <hr style={cardDividerStyle} />
            <table
              style={{
                width: '100%',
                tableLayout: 'fixed',
                borderCollapse: 'collapse',
                marginTop: 8,
              }}
            >
              <colgroup>
                <col style={{ width: '22%' }} />
                <col style={{ width: '30%' }} />
                <col style={{ width: '30%' }} />
                <col style={{ width: '18%' }} />
              </colgroup>
              <thead>
                <tr style={{ borderBottom: '1px solid #ddd' }}>
                  <th style={{ textAlign: 'center', padding: '4px 8px' }}>
                    항목
                  </th>
                  <th style={{ textAlign: 'center', padding: '4px 8px' }}>
                    당기
                  </th>
                  <th style={{ textAlign: 'center', padding: '4px 8px' }}>
                    전기
                  </th>
                  <th style={{ textAlign: 'center', padding: '4px 8px' }}>
                    증감률
                  </th>
                </tr>
              </thead>
              <tbody>
                {[
                  ...Object.entries(card.figures)
                    .sort(
                      ([a], [b]) =>
                        FIGURE_ORDER.indexOf(a) - FIGURE_ORDER.indexOf(b),
                    )
                    .map(
                      ([name, v]): FigureRow => ({
                        name,
                        cur: formatWon(v.당기),
                        prev: formatWon(v.전기),
                        yoy: formatYoY(v.당기, v.전기),
                      }),
                    ),
                  operatingMarginRow(card.figures),
                ]
                  .filter((row): row is FigureRow => row !== null)
                  .map((row) => (
                    <tr key={row.name}>
                      <td
                        style={{
                          textAlign: 'center',
                          padding: '4px 8px',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {row.name}
                      </td>
                      <td
                        style={{
                          textAlign: 'center',
                          padding: '4px 8px',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {row.cur}
                      </td>
                      <td
                        style={{
                          textAlign: 'center',
                          padding: '4px 8px',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {row.prev}
                      </td>
                      <td
                        style={{
                          textAlign: 'center',
                          padding: '4px 8px',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {row.yoy}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {sources[card.agent] && (
              <p style={{ fontSize: 12, color: '#666', marginTop: 8 }}>
                출처:{' '}
                <a
                  href={sources[card.agent].viewer_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  원문 보기
                </a>
                {sources[card.agent].rcept_dt &&
                  ` · 접수 ${formatRceptDt(sources[card.agent].rcept_dt as string)}`}
              </p>
            )}
          </div>
        ) : (
          <div key={i} style={cardStyle}>
            {unsourcedBadge}
            <h2>관련 뉴스</h2>
            <hr style={cardDividerStyle} />
            <ul style={{ paddingLeft: 16 }}>
              {card.items.map((item, j) => (
                <li key={j} style={{ marginBottom: 8 }}>
                  <a href={item.link} target="_blank" rel="noreferrer">
                    {item.title}
                  </a>
                  <div style={{ fontSize: 12, color: '#666' }}>
                    {formatPubDate(item.pub_date)}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}

      {(noteDetail ?? note) && (
        <div
          style={{
            border: '1px solid #ccc',
            borderRadius: 8,
            padding: 16,
            marginTop: 16,
          }}
        >
          <div
            style={{
              background: '#fef3c7',
              border: '1px solid #f59e0b',
              borderRadius: 6,
              padding: '8px 12px',
              fontSize: 12,
              color: '#92400e',
              fontWeight: 600,
              marginBottom: 12,
            }}
          >
            {NOTE_WATERMARK}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h2 style={{ margin: 0 }}>실적·공시 노트 초안</h2>
            <span
              style={{
                fontSize: 12,
                padding: '2px 8px',
                borderRadius: 12,
                background: '#eee',
              }}
            >
              {STATUS_LABEL[(noteDetail ?? note)!.status]}
            </span>
          </div>
          <hr style={cardDividerStyle} />

          {(noteDetail?.sentences ?? note?.sentences ?? []).map((s, i) =>
            s.is_heading ? (
              <h3 key={i} style={{ fontSize: 15, marginTop: 16, marginBottom: 4 }}>
                {s.text}
              </h3>
            ) : (
              <p key={i} style={{ margin: '8px 0', lineHeight: 1.6, fontSize: 14 }}>
                {s.text}{' '}
                {s.source ? (
                  <a
                    href={s.source.type === 'dart' ? s.source.viewer_url : s.source.url}
                    target="_blank"
                    rel="noreferrer"
                    title={
                      s.source.type === 'dart'
                        ? `공시 원문 · 접수 ${s.source.rcept_dt ?? '미상'}`
                        : `뉴스 원문 · ${s.source.pub_date ?? ''}`
                    }
                    style={{ fontSize: 11, color: '#2563eb', whiteSpace: 'nowrap' }}
                  >
                    [출처]
                  </a>
                ) : (
                  <span style={{ fontSize: 11, color: '#b45309', fontWeight: 600 }}>
                    [UNSOURCED]
                  </span>
                )}
              </p>
            ),
          )}

          {(noteDetail?.violations ?? note?.violations ?? []).length > 0 && (
            <p style={{ fontSize: 12, color: '#b45309', marginTop: 8 }}>
              ⚠ 게이트 미통과 사유: {(noteDetail?.violations ?? note?.violations ?? []).join(' / ')}
            </p>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16, flexWrap: 'wrap' }}>
            <input
              value={actorName}
              onChange={(e) => setActorName(e.target.value)}
              placeholder="처리자 이름"
              style={{ fontSize: 12 }}
            />
            {noteDetail?.status === 'draft' && (
              <button onClick={() => doNoteAction(noteDetail.id, 'review')} disabled={noteActionLoading}>
                검토 시작
              </button>
            )}
            {noteDetail?.status === 'review' && (
              <button onClick={() => doNoteAction(noteDetail.id, 'deliberate')} disabled={noteActionLoading}>
                심의 요청
              </button>
            )}
            {noteDetail?.status === 'deliberation' && (
              <button onClick={() => doNoteAction(noteDetail.id, 'publish')} disabled={noteActionLoading}>
                발행
              </button>
            )}
            {noteDetail?.status === 'published' && (
              <span style={{ fontSize: 12, color: '#16a34a' }}>
                ✓ 발행 완료 ({noteDetail.publisher})
              </span>
            )}
          </div>
          {noteActionError && (
            <p style={{ color: '#dc2626', fontSize: 12, marginTop: 8 }}>⚠ {noteActionError}</p>
          )}

          {noteDetail && noteDetail.audit_log.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <button onClick={() => setShowAudit((v) => !v)} style={{ fontSize: 12 }}>
                {showAudit ? '▾' : '▸'} 감사 로그 ({noteDetail.audit_log.length})
              </button>
              {showAudit && (
                <ul style={{ fontSize: 12, color: '#666' }}>
                  {noteDetail.audit_log.map((a, i) => (
                    <li key={i}>
                      [{new Date(a.ts).toLocaleString('ko-KR')}] {a.event_type}
                      {a.actor ? ` — ${a.actor}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
