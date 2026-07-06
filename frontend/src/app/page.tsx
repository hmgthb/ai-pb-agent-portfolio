"use client";

import { useRef, useState } from "react";

type Figures = {
  corp_name: string;
  stock_code: string;
  bsns_year: string;
  fs_div: string;
  figures: Record<string, { 당기: string; 전기: string }>;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

function formatWon(raw: string): string {
  const n = Number(raw);
  return `${(n / 1_0000_0000_0000).toFixed(2)}조 원`;
}

export default function Home() {
  const [stockCode, setStockCode] = useState("005930");
  const [log, setLog] = useState<string[]>([]);
  const [card, setCard] = useState<Figures | null>(null);
  const [loading, setLoading] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  function run() {
    esRef.current?.close();
    setCard(null);
    setLog([]);
    setLoading(true);

    const es = new EventSource(`${API_BASE}/api/research/stream?stock_code=${stockCode}`);
    esRef.current = es;

    es.addEventListener("tool_use", (e) => {
      const data = JSON.parse(e.data);
      setLog((prev) => [...prev, `도구 호출: ${data.name}`]);
    });
    es.addEventListener("card", (e) => {
      setCard(JSON.parse(e.data));
    });
    es.addEventListener("done", () => {
      setLoading(false);
      es.close();
    });
    es.onerror = () => {
      setLoading(false);
      es.close();
    };
  }

  return (
    <div style={{ padding: 24, fontFamily: "sans-serif", maxWidth: 480 }}>
      <h1>종목 핵심수치 조회</h1>
      <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
        <input
          value={stockCode}
          onChange={(e) => setStockCode(e.target.value)}
          placeholder="종목코드 (예: 005930)"
        />
        <button onClick={run} disabled={loading}>
          {loading ? "조회 중..." : "조회"}
        </button>
      </div>

      {log.length > 0 && (
        <ul style={{ fontSize: 12, color: "#666" }}>
          {log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}

      {card && (
        <div style={{ border: "1px solid #ccc", borderRadius: 8, padding: 16, marginTop: 16 }}>
          <h2>
            {card.corp_name} ({card.stock_code})
          </h2>
          <p style={{ fontSize: 12, color: "#666" }}>
            {card.bsns_year}년 · {card.fs_div === "CFS" ? "연결" : "별도"}재무제표
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
          <p style={{ fontSize: 12, color: "#999", marginTop: 8 }}>
            내부 참고용 · 투자권유 아님 · AI 초안·미검증
          </p>
        </div>
      )}
    </div>
  );
}
