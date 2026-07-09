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

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:8000';

function formatWon(raw: string): string {
  const n = Number(raw);
  return `${(n / 1_0000_0000_0000).toFixed(2)}조 원`;
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
  const esRef = useRef<EventSource | null>(null);

  function run() {
    esRef.current?.close();
    setCards([]);
    setTimeline([]);
    setAgentStatus({});
    setTexts([]);
    setUnsourcedAgents([]);
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
    });
    es.addEventListener('text', (e) => {
      setTexts((prev) => [...prev, JSON.parse(e.data)]);
    });
    es.addEventListener('card', (e) => {
      const data: CardData = JSON.parse(e.data);
      const cardKey = (c: CardData) =>
        c.type === 'financials' ? `${c.agent}-financials-${c.fs_div}` : `${c.agent}-${c.type}`;
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
            next = next.filter((c) => !(c.type === 'financials' && c.agent === data.agent));
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
      setLoading(false);
      es.close();
    });
    es.onerror = () => {
      setLoading(false);
      es.close();
    };
  }

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif', maxWidth: 480 }}>
      <h1>종목 핵심수치 + 뉴스 조회</h1>
      <div style={{ display: 'flex', gap: 8, margin: '12px 0' }}>
        <input
          value={stockCode}
          onChange={(e) => setStockCode(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !loading) run();
          }}
          placeholder="종목코드 (000000)"
        />
        <button onClick={run} disabled={loading}>
          {loading ? '조회 중...' : '조회'}
        </button>
      </div>

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

      {cards.map((card, i) => {
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
              {card.corp_name} ({card.stock_code})
            </h2>
            <p style={{ fontSize: 12, color: '#666' }}>
              {card.bsns_year}년 · {card.fs_div === 'CFS' ? '연결' : '별도'}
              재무제표
            </p>
            <table>
              <thead>
                <tr>
                  <th align="left">항목</th>
                  <th align="right">당기</th>
                  <th align="right">전기</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(card.figures).map(([name, v]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td align="right">{formatWon(v.당기)}</td>
                    <td align="right">{formatWon(v.전기)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ fontSize: 12, color: '#999', marginTop: 8 }}>
              내부 참고용 · 투자권유 아님 · AI 초안·미검증
            </p>
          </div>
        ) : (
          <div key={i} style={cardStyle}>
            {unsourcedBadge}
            <h2>관련 뉴스</h2>
            <ul style={{ paddingLeft: 16 }}>
              {card.items.map((item, j) => (
                <li key={j} style={{ marginBottom: 8 }}>
                  <a href={item.link} target="_blank" rel="noreferrer">
                    {item.title}
                  </a>
                  <div style={{ fontSize: 12, color: '#666' }}>
                    {item.pub_date}
                  </div>
                </li>
              ))}
            </ul>
            <p style={{ fontSize: 12, color: '#999', marginTop: 8 }}>
              내부 참고용 · 투자권유 아님 · AI 초안·미검증
            </p>
          </div>
        );
      })}
    </div>
  );
}
