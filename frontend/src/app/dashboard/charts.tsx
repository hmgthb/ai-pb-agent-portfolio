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
      {/* 마지막 구간 강조는 --accent가 아니라 --accent-text다 — 브랜드 원색은 밝은 배경에서
          2.8:1이라 2px 선이 배경에 묻는다(도형 대비 기준 3:1). 미터 채움과 같은 이유. */}
      <line
        x1={x(li - 1)} y1={y(data[li - 1])} x2={x(li)} y2={y(data[li])}
        stroke="var(--accent-text)" strokeWidth={2} strokeLinecap="round"
      />
      <circle cx={x(li)} cy={y(data[li])} r={2.5} fill="var(--accent-text)" stroke="var(--surface)" strokeWidth={1.5} />
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

/* ── 자산배분 도넛 ──────────────────────────────────────────
   자산군은 그냥 이름표가 아니라 **순서가 있는 값**이다(위험도: 현금성<채권<펀드<국내주식).
   그래서 범주형 4색이 아니라 한 색조(청록) 4단계를 쓴다 — 진할수록 위험자산이라
   "쏠림"이 색 농도로 바로 읽힌다. 이 화면의 위험 플래그 규칙이 보는 것도 그 쏠림이다.
   색조가 하나라 등락(적·청)·강조(주황) 어느 것과도 안 겹친다: 가장 가까운 쌍이
   하락 청과 ΔE 23.5로, "구분 어려움" 기준선(15)에서 멀다.
   ※ 범주형 4색은 이 화면에서 불가능하다 — 적·청·주황을 빼면 문서 팔레트에 남는 색조가
     셋뿐이고, 그중 aqua+green은 다크에서 서로 무너진다(ΔE 11.9). */
export const ALLOC_ORDER: string[] = ['현금성', '채권', '펀드', '국내주식'];
export const ALLOC_COLORS = [
  'var(--alloc-1)',
  'var(--alloc-2)',
  'var(--alloc-3)',
  'var(--alloc-4)',
];

/** 위험도 순으로 정렬한다. 모르는 자산군은 뒤에 원래 순서대로 붙인다 — 시드가 바뀌어도
    조각이 조용히 사라지면 안 된다(합이 100%가 아니게 된다). */
export function allocEntries(
  alloc: Record<string, number>,
): [string, number][] {
  const known = ALLOC_ORDER.filter((k) => k in alloc).map(
    (k) => [k, alloc[k]] as [string, number],
  );
  const rest = Object.entries(alloc).filter(([k]) => !ALLOC_ORDER.includes(k));
  return [...known, ...rest];
}

export function Donut({
  alloc, size = 120, bind,
}: {
  alloc: Record<string, number>;
  size?: number;
  bind: (html: string) => Record<string, unknown>;
}) {
  const entries = allocEntries(alloc);
  const total = entries.reduce((a, [, v]) => a + v, 0) || 1;
  const cx = size / 2, cy = size / 2, r = size / 2 - 6, ir = r - 16;
  /* 시작 각도는 누적 변수로 굴리지 않는다 — 렌더 중 재할당이라 React 컴파일러가 막는다
     (`react-hooks/immutability`). 앞 조각들의 합으로 그때그때 구한다(조각 4개). */
  const sweep = entries.map(([, v]) => (v / total) * Math.PI * 2);
  const paths = entries.map(([k, v], i) => {
    const a1 = sweep.slice(0, i).reduce((a, b) => a + b, -Math.PI / 2);
    const a2 = a1 + sweep[i];
    const large = sweep[i] > Math.PI ? 1 : 0;
    const p = (a: number, rr: number) => `${cx + rr * Math.cos(a)},${cy + rr * Math.sin(a)}`;
    const d = `M${p(a1, r)} A${r},${r} 0 ${large} 1 ${p(a2, r)} L${p(a2, ir)} A${ir},${ir} 0 ${large} 0 ${p(a1, ir)} Z`;
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
