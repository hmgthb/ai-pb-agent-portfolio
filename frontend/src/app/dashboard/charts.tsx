'use client';

/** 차트 — 시안(docs/design/pb-admin-dashboard.html)의 순수 SVG 구현을 React로 옮긴 것.
 *  좌표 계산식은 시안과 동일하게 유지한다(차트 라이브러리를 쓰지 않는 이유: 시안이 이미
 *  SVG로 구현돼 있어 라이브러리를 얹으면 렌더 결과가 시안과 달라진다).
 */

import { useState } from 'react';

export type Series = { name: string; data: number[]; color: string; fill?: boolean };

/* ── 툴팁 — 시안은 전역 #tip 노드에 마우스를 따라다니게 붙였다. 여기서는 상태로 관리한다 ── */
type TipState = { x: number; y: number; html: string } | null;

export function Tip({ tip }: { tip: TipState }) {
  if (!tip) return null;
  return (
    <div
      id="tip"
      style={{ display: 'block', left: tip.x, top: tip.y }}
      dangerouslySetInnerHTML={{ __html: tip.html }}
    />
  );
}

export function useTip() {
  const [tip, setTip] = useState<TipState>(null);
  const bind = (html: string) => ({
    onMouseMove: (e: React.MouseEvent) =>
      setTip({ x: Math.min(e.clientX + 12, window.innerWidth - 180), y: e.clientY - 34, html }),
    onMouseLeave: () => setTip(null),
  });
  return { tip, bind };
}

/* ── 스파크라인 (타일 안) ─────────────────────────────────── */
export function Sparkline({ data, w = 64, h = 22 }: { data: number[]; w?: number; h?: number }) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const x = (i: number) => (i / (data.length - 1)) * (w - 6) + 3;
  const y = (v: number) => h - 4 - ((v - min) / (max - min || 1)) * (h - 8);
  const pts = data.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const li = data.length - 1;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="var(--spark)" strokeWidth={1.5} strokeLinejoin="round" />
      <line
        x1={x(li - 1)} y1={y(data[li - 1])} x2={x(li)} y2={y(data[li])}
        stroke="var(--accent)" strokeWidth={2} strokeLinecap="round"
      />
      <circle cx={x(li)} cy={y(data[li])} r={2.5} fill="var(--accent)" stroke="var(--surface)" strokeWidth={1.5} />
    </svg>
  );
}

/* ── 게이트 차단 7일 미니 컬럼 (0건인 날은 베이스라인 점으로) ── */
export function GateMini({ data }: { data: number[] }) {
  const w = 64, h = 24, bw = 5, gap = 3.4;
  const max = Math.max(...data, 1);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {data.map((v, i) => {
        const x = i * (bw + gap) + 3;
        if (v === 0) return <rect key={i} x={x} y={h - 3} width={bw} height={1.5} fill="var(--grid)" />;
        const bh = (v / max) * (h - 8);
        return (
          <path
            key={i}
            d={`M${x},${h - 2} v-${bh - 3} a3,3 0 0 1 3,-3 h${bw - 6} a3,3 0 0 1 3,3 v${bh - 3} Z`}
            fill="var(--s1)"
          />
        );
      })}
    </svg>
  );
}

/* ── 선 차트 ──────────────────────────────────────────────── */
export function LineChart({
  days, series, unit = '', width = 340, bind,
}: {
  days: string[];
  series: Series[];
  unit?: string;
  width?: number;
  bind: (html: string) => Record<string, unknown>;
}) {
  const H = 190;
  const P = { t: 14, r: 44, b: 26, l: 34 };
  const W = width;
  const all = series.flatMap((s) => s.data);
  if (!all.length || !days.length) return null;
  const max = Math.ceil(Math.max(...all) / 5) * 5 || 5;
  const x = (i: number) => P.l + (i / (days.length - 1 || 1)) * (W - P.l - P.r);
  const y = (v: number) => H - P.b - (v / max) * (H - P.t - P.b);
  const ticks = [0, max / 2, max];
  const bandW = (W - P.l - P.r) / days.length;
  const labelIdx = [0, Math.floor((days.length - 1) / 2), days.length - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={P.l} y1={y(t)} x2={W - P.r} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
          <text className="axis-text" x={P.l - 6} y={y(t) + 3} textAnchor="end">{t}</text>
        </g>
      ))}
      {labelIdx.map((i) => (
        <text key={i} className="axis-text" x={x(i)} y={H - 8} textAnchor="middle">{days[i]}</text>
      ))}
      <line x1={P.l} y1={y(0)} x2={W - P.r} y2={y(0)} stroke="var(--baseline)" strokeWidth={1} />
      {series.map((s) => {
        const pts = s.data.map((v, i) => `${x(i)},${y(v)}`).join(' ');
        const li = s.data.length - 1;
        return (
          <g key={s.name}>
            {s.fill && (
              <polygon
                points={`${x(0)},${y(0)} ${pts} ${x(days.length - 1)},${y(0)}`}
                fill={s.color}
                opacity={0.1}
              />
            )}
            <polyline points={pts} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={x(li)} cy={y(s.data[li])} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />
            <text className="end-label" x={x(li) + 8} y={y(s.data[li]) + 4}>{s.data[li]}{unit}</text>
          </g>
        );
      })}
      {days.map((d, i) => (
        <rect
          key={i}
          x={x(i) - bandW / 2} y={P.t} width={bandW} height={H - P.t - P.b}
          fill="transparent"
          {...bind(`<b>${d}</b> ${series.map((s) => `${s.name} ${s.data[i]}${unit}`).join(' · ')}`)}
        />
      ))}
    </svg>
  );
}

/* ── 가로 막대 (에이전트 호출) ────────────────────────────── */
export function BarChart({
  rows, bind,
}: {
  rows: [string, number][];
  bind: (html: string) => Record<string, unknown>;
}) {
  const W = 340, H = 190, P = { t: 8, r: 44, b: 8, l: 74 };
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => r[1]), 1);
  const bandH = (H - P.t - P.b) / rows.length;
  const barH = Math.min(18, bandH - 8);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img">
      {rows.map(([label, v], i) => {
        const yMid = P.t + bandH * i + bandH / 2;
        const w = Math.max(6, (v / max) * (W - P.l - P.r));
        return (
          <g key={label}>
            <text className="bar-label" x={P.l - 8} y={yMid + 4} textAnchor="end">{label}</text>
            {/* 데이터 끝만 4px 라운드, 베이스라인 쪽은 직각 */}
            <path
              d={`M${P.l},${yMid - barH / 2} h${w - 4} a4,4 0 0 1 4,4 v${barH - 8} a4,4 0 0 1 -4,4 h-${w - 4} Z`}
              fill="var(--s1)"
              {...bind(`<b>${label}</b> ${v}회`)}
            />
            <text className="bar-value" x={P.l + w + 7} y={yMid + 4}>{v}</text>
          </g>
        );
      })}
      <line x1={P.l} y1={P.t} x2={P.l} y2={H - P.b} stroke="var(--baseline)" strokeWidth={1} />
    </svg>
  );
}

/* ── 자산배분 도넛 ────────────────────────────────────────── */
export const ALLOC_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)'];

export function Donut({
  alloc, size = 120, bind,
}: {
  alloc: Record<string, number>;
  size?: number;
  bind: (html: string) => Record<string, unknown>;
}) {
  const entries = Object.entries(alloc);
  const total = entries.reduce((a, [, v]) => a + v, 0) || 1;
  const cx = size / 2, cy = size / 2, r = size / 2 - 6, ir = r - 16;
  let angle = -Math.PI / 2;
  const paths = entries.map(([k, v], i) => {
    const a2 = angle + (v / total) * Math.PI * 2;
    const large = a2 - angle > Math.PI ? 1 : 0;
    const p = (a: number, rr: number) => `${cx + rr * Math.cos(a)},${cy + rr * Math.sin(a)}`;
    const d = `M${p(angle, r)} A${r},${r} 0 ${large} 1 ${p(a2, r)} L${p(a2, ir)} A${ir},${ir} 0 ${large} 0 ${p(angle, ir)} Z`;
    angle = a2;
    return (
      <path
        key={k}
        d={d}
        fill={ALLOC_COLORS[i % ALLOC_COLORS.length]}
        stroke="var(--surface)"
        strokeWidth={2}
        {...bind(`<b>${k}</b> ${v}%`)}
      />
    );
  });
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="자산배분">
      {paths}
    </svg>
  );
}
