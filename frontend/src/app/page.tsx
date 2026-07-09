'use client';

import { useRef, useState, type ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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

const markdownComponents = {
  h1: (props: ComponentProps<'h1'>) => (
    <h1 style={{ fontSize: 20, marginTop: 20, marginBottom: 8 }} {...props} />
  ),
  h2: (props: ComponentProps<'h2'>) => (
    <h2 style={{ fontSize: 17, marginTop: 20, marginBottom: 8 }} {...props} />
  ),
  h3: (props: ComponentProps<'h3'>) => (
    <h3 style={{ fontSize: 15, marginTop: 16, marginBottom: 6 }} {...props} />
  ),
  p: (props: ComponentProps<'p'>) => (
    <p style={{ margin: '8px 0', lineHeight: 1.6 }} {...props} />
  ),
  a: (props: ComponentProps<'a'>) => (
    <a
      target="_blank"
      rel="noreferrer"
      style={{ color: '#2563eb' }}
      {...props}
    />
  ),
  hr: () => (
    <hr
      style={{ border: 'none', borderTop: '1px solid #ddd', margin: '16px 0' }}
    />
  ),
  blockquote: (props: ComponentProps<'blockquote'>) => (
    <blockquote
      style={{
        borderLeft: '3px solid #ddd',
        margin: '8px 0',
        padding: '2px 12px',
        color: '#555',
      }}
      {...props}
    />
  ),
  table: (props: ComponentProps<'table'>) => (
    <table
      style={{ borderCollapse: 'collapse', width: '100%', margin: '8px 0' }}
      {...props}
    />
  ),
  th: (props: ComponentProps<'th'>) => (
    <th
      style={{
        border: '1px solid #ddd',
        padding: '4px 8px',
        background: '#f5f5f5',
      }}
      {...props}
    />
  ),
  td: (props: ComponentProps<'td'>) => (
    <td style={{ border: '1px solid #ddd', padding: '4px 8px' }} {...props} />
  ),
  ul: (props: ComponentProps<'ul'>) => (
    <ul style={{ paddingLeft: 20, margin: '8px 0' }} {...props} />
  ),
  ol: (props: ComponentProps<'ol'>) => (
    <ol style={{ paddingLeft: 20, margin: '8px 0' }} {...props} />
  ),
};

// O에게 재무제표 표·뉴스 목록을 다시 나열하지 말라고 프롬프트로 지시해도 매번
// 지켜지진 않는다(LLM 출력이라 비결정적) — 위의 재무제표·관련 뉴스 카드와 중복되지
// 않도록, 그런 제목의 섹션과 마크다운 표는 렌더링 전에 결정론적으로 걸러낸다.
function stripDuplicateSections(md: string): string {
  let lines = md.split('\n');

  // 서두 잡담("두 결과 모두 받았습니다..." 등) 제거: 첫 헤딩(법인명+종합 분석 제목)
  // 앞에 나오는 줄은 버린다. 헤딩 자체도 버리는데, 그 제목은 화면에서 별도로 그리기
  // 때문이다. 헤딩이 아예 없으면(프롬프트로 이미 서두를 금지했다) 손대지 않는다.
  const firstHeadingIdx = lines.findIndex((l) => /^#{1,6}\s/.test(l));
  if (firstHeadingIdx > 0) lines = lines.slice(firstHeadingIdx);
  if (/^#{1,6}\s/.test(lines[0] ?? '')) lines = lines.slice(1);

  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const heading = /^#{1,6}\s*(.+)/.exec(line);
    if (heading) {
      skipping = /뉴스|핵심\s*수치|재무제표/.test(heading[1]);
      if (skipping) continue;
    }
    if (skipping || /^\|.*\|\s*$/.test(line)) continue;
    out.push(line);
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
  const esRef = useRef<EventSource | null>(null);
  // 재무 카드가 하나라도 왔는지 추적 — done 시점에 하나도 없으면 존재하지 않는
  // 종목코드로 판단한다. state는 이벤트 핸들러 클로저 안에서 stale할 수 있어 ref로 둔다.
  const gotFinancialsRef = useRef(false);

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
    gotFinancialsRef.current = false;
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
        setAgentStatus((prev) => ({ ...prev, [data.agent]: 'running' }));
      }
      // a1은 법인명 확인만 하고 카드를 만들지 않는 에이전트라 'card' 이벤트로는
      // 절대 done이 안 된다 — 자기 도구 호출이 완료되는 시점을 done 신호로 쓴다.
      if (data.agent === 'a1' && data.status === 'completed') {
        setAgentStatus((prev) => ({ ...prev, a1: 'done' }));
      }
    });
    es.addEventListener('text', (e) => {
      setTexts((prev) => [...prev, JSON.parse(e.data)]);
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
    es.addEventListener('done', (e) => {
      const data: { unsourced_agents?: string[] } = JSON.parse(e.data);
      setUnsourcedAgents(data.unsourced_agents ?? []);
      if (!gotFinancialsRef.current) {
        setInputError(
          '해당 종목코드의 재무 데이터를 찾을 수 없습니다. 실제 6자리 종목코드를 입력해주세요.',
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

  // 스트리밍 중에는 O의 중간 진행 안내 텍스트까지 "종합 리포트"로 잡히므로,
  // done 이벤트로 스트림이 끝난 뒤에만(최종 종합 분석만) 노출한다.
  const finalReport = loading
    ? undefined
    : [...texts].reverse().find((t) => t.agent === 'O');

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

      {finalReport && (
        <div
          style={{
            border: '1px solid #ccc',
            borderRadius: 8,
            padding: 16,
            marginTop: 16,
          }}
        >
          <h2>종합 리포트</h2>
          <hr style={cardDividerStyle} />
          <h4>{corpName ?? stockCode} 종합 분석</h4>
          <div style={{ overflowX: 'auto', fontSize: 14 }}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
            >
              {stripDuplicateSections(finalReport.text)}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}
