'use client';

/** 문장 출처 표시 — 노트 모달(F3)과 대화 답변(F1)이 **같은 모듈을 쓴다.**
 *
 *  원래 `ReviewModal.tsx`와 `F1Chat.tsx`에 거의 같은 배지 함수가 따로 있었고 이미 갈라져
 *  있었다(모달에만 '접수일 미상' 폴백이 있었다). 출처 표시는 가드레일 3이 걸린 자리라
 *  두 화면이 다르게 보이면 안 된다 — 규칙은 여기 하나다.
 *
 *  **모양은 둘로 갈린다**(2026-07-28, 화면 성격이 달라서다):
 *    · 노트 모달 = **번호 각주 + 하단 출처 목록**. 노트는 문서라서 각주가 그 장르의 표기법이고,
 *      본문에서 배지를 걷어내야 문장이 폭 100%를 쓴다 — 배지가 먹던 건 자기 면적(측정 6.8%)이
 *      아니라 `.stext`를 55%로 눌러 생기던 **줄 수**였다.
 *    · F1 대화 = **인라인 압축 배지**. 답변이 2~4문장뿐이라 하단 목록을 따로 두면
 *      목록이 답변보다 길어진다.
 *
 *  날짜는 `fmtDate` 한 곳으로 찍는다: 공시는 `20260722`, 뉴스는 RFC 2822로 원본 형식이
 *  달라서 화면마다 자르다 **`뉴스 Wed, 22 Ju`가 사용자에게 나간 적이 있다.**
 */

import { useState } from 'react';
import { fmtDate } from './api';
import type { NoteSentence, NoteSource } from './types';

/** 같은 출처인지 가르는 값. **URL·접수번호까지 봐야 한다** — "같은 날짜 뉴스"로 뭉치면
 *  서로 다른 기사 둘이 하나로 합쳐져 한쪽 링크가 사라진다(가드레일 3 위반). */
export function sourceKey(src: NoteSource): string {
  if (src.type === 'dart') return `dart:${src.rcept_no}`;
  if (src.type === 'news') return `news:${src.url}`;
  if (src.type === 'krx') return `krx:${src.as_of}`;
  return 'holdings';
}

/** 출처 원문 주소. 없는 종류(시세·보유)는 null — 그때는 링크가 아니라 그냥 표시다. */
export function sourceHref(src: NoteSource): string | null {
  if (src.type === 'dart') return src.viewer_url || null;
  if (src.type === 'news') return src.url || null;
  return null; // krx: 조회 API에 사람이 볼 페이지가 없다 / holdings: 내부 데이터
}

function sourceKind(src: NoteSource): string {
  if (src.type === 'dart') return '공시';
  if (src.type === 'news') return '뉴스';
  if (src.type === 'krx') return '시세';
  return '보유';
}

function sourceDate(src: NoteSource): string {
  if (src.type === 'dart') return fmtDate(src.rcept_dt) || '접수일 미상';
  if (src.type === 'news') return fmtDate(src.pub_date) || '시점 미상';
  if (src.type === 'krx') return fmtDate(src.as_of);
  return src.as_of ? fmtDate(src.as_of) : '';
}

/** 인라인 배지의 날짜 — **올해면 연도를 뗀다.** 상담 중 읽는 값이라 짧을수록 좋은데,
 *  해가 다른 출처(작년 공시)는 연도가 빠지면 최근 것처럼 읽히므로 그때는 남긴다. */
function compactDate(src: NoteSource): string {
  const d = sourceDate(src);
  const y = String(new Date().getFullYear());
  return d.startsWith(`${y}-`) ? d.slice(5) : d;
}

/** 각주 목록 오른쪽에 붙는 설명. **없는 것을 지어내지 않는다** — 공시에는 문서명이 없다
 *  (저장된 출처가 접수번호·URL·접수일뿐이라 dart_search의 `report_nm`이 안 들어 있다). */
function sourceDetail(src: NoteSource): string {
  if (src.type === 'dart') return `전자공시 접수번호 ${src.rcept_no}`;
  if (src.type === 'news') return src.title || '뉴스 원문';
  return src.label;
}

/* ── 인라인 배지 (F1 대화) ───────────────────────────────────────── */

export function SourceBadge({
  src,
  count = 1,
}: {
  src: NoteSource | null;
  /** 같은 출처를 여러 번 인용했을 때 `×2`. **다른 출처끼리는 절대 합치지 않는다.** */
  count?: number;
}) {
  if (!src) return <span className="sbadge un">UNSOURCED</span>;

  // 보유데이터만 다른 배지다 — 공개데이터가 아닌 유일한 출처(가드레일 1의 예외)라
  // 공시·뉴스와 같은 색으로 두면 같은 급으로 읽힌다.
  const cls = src.type === 'holdings' ? 'sbadge hold' : 'sbadge src';
  const href = sourceHref(src);
  const label =
    `${sourceKind(src)} ${compactDate(src)}`.trim() +
    (count > 1 ? ` ×${count}` : '');
  const title = sourceDetail(src);

  if (!href) {
    return (
      <span className={cls} title={title}>
        {label}
      </span>
    );
  }
  return (
    <a
      className={`${cls} is-link`}
      href={href}
      /* 새 탭으로 연다. 같은 탭이면 **열려 있던 모달과 검토 맥락을 잃는다.**
         noopener은 새 탭이 window.opener로 이 페이지를 조작하지 못하게 막는다
         (출처 URL은 공시·뉴스에서 온 값이라 우리가 통제하는 주소가 아니다). */
      target="_blank"
      rel="noopener noreferrer"
      title={`${title} (새 탭에서 열기)`}
    >
      {label}
      <span className="sbadge-ext" aria-hidden="true">
        ↗
      </span>
    </a>
  );
}

/** 같은 출처의 반복만 묶는다(키가 같은 것끼리). 순서는 첫 등장 순. */
export function mergeSources(
  srcs: NoteSource[],
): { src: NoteSource; count: number }[] {
  const out: { src: NoteSource; count: number }[] = [];
  const at = new Map<string, number>();
  for (const s of srcs) {
    const k = sourceKey(s);
    const i = at.get(k);
    if (i === undefined) {
      at.set(k, out.length);
      out.push({ src: s, count: 1 });
    } else {
      out[i].count += 1;
    }
  }
  return out;
}

/* ── 번호 각주 (노트 모달) ───────────────────────────────────────── */

export type Footnotes = {
  /** sourceKey → 각주 번호 */
  numberOf: Map<string, number>;
  items: { n: number; src: NoteSource }[];
};

/** 화면에 **보이는 순서대로** 번호를 매긴다. 노트 모달은 문장을 검토 등급으로 다시
 *  정렬하므로(reviewTier), 원문 순서로 매기면 목록이 1,5,2…로 튄다.
 *  같은 출처를 여러 문장이 인용하면 **번호를 공유한다** — 각주의 본래 동작이고,
 *  덕분에 중복 배지 문제가 번호 단계에서 자연히 사라진다(노트 #7 실측 중복 4건). */
export function buildFootnotes(rows: { s: NoteSentence }[]): Footnotes {
  const numberOf = new Map<string, number>();
  const items: { n: number; src: NoteSource }[] = [];
  for (const { s } of rows) {
    for (const src of s.sources ?? (s.source ? [s.source] : [])) {
      const k = sourceKey(src);
      if (numberOf.has(k)) continue;
      const n = items.length + 1;
      numberOf.set(k, n);
      items.push({ n, src });
    }
  }
  return { numberOf, items };
}

/** 문장 끝에 붙는 윗첨자 번호들. 누르면 하단 목록의 해당 항목으로 내려가 잠깐 빛난다.
 *  ⚠️ 번호 자체를 외부 링크로 걸지 않는다 — 누르는 순간 DART로 튀어나가면 "이 번호가
 *     무슨 출처인지" 확인할 방법이 사라진다. 원문으로 가는 링크는 목록 쪽에 있다. */
export function FootnoteRefs({
  ns,
  onJump,
}: {
  ns: number[];
  onJump: (n: number) => void;
}) {
  if (!ns.length) return null;
  return (
    <sup className="fnrefs">
      {ns.map((n, i) => (
        <span key={n}>
          {i > 0 && <span className="fnref-sep">,</span>}
          <button
            className="fnref"
            onClick={() => onJump(n)}
            aria-label={`출처 ${n}번으로 이동`}
            title={`출처 ${n} 보기`}
          >
            {n}
          </button>
        </span>
      ))}
    </sup>
  );
}

export function FootnoteList({
  items,
  flash,
}: {
  items: { n: number; src: NoteSource }[];
  /** 방금 눌린 번호 — 잠깐 배경을 밝혀 어디로 왔는지 알린다. */
  flash: number | null;
}) {
  if (!items.length) return null;
  return (
    <section className="fnlist" aria-label="출처">
      <div className="fnlist-head">출처 {items.length}건</div>
      <ol>
        {items.map(({ n, src }) => {
          const href = sourceHref(src);
          return (
            <li
              key={n}
              id={`fn-${n}`}
              className={flash === n ? 'is-flash' : undefined}
            >
              <span className="fn-n">{n}</span>
              <span className="fn-kind">{sourceKind(src)}</span>
              <span className="fn-date">{sourceDate(src)}</span>
              {href ? (
                <a
                  className="fn-title"
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`${sourceDetail(src)} (새 탭에서 열기)`}
                >
                  {sourceDetail(src)}
                  <span className="sbadge-ext" aria-hidden="true">
                    ↗
                  </span>
                </a>
              ) : (
                /* 시세·보유데이터는 사람이 볼 원문 페이지가 없다 — 링크로 만들지 않는다.
                   "누를 수 있게 생겼는데 아무 일도 안 일어나는" 것이 더 나쁘다. */
                <span className="fn-title is-plain">{sourceDetail(src)}</span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** 각주 점프 상태. 번호(본문)와 목록이 떨어져 있어 두 곳이 같은 값을 봐야 한다. */
export function useFootnoteJump() {
  const [flash, setFlash] = useState<number | null>(null);
  const jump = (n: number) => {
    setFlash(n);
    // 스크롤 컨테이너는 `.m-body`다 — 요소를 직접 찾아 가운데로 보낸다.
    document.getElementById(`fn-${n}`)?.scrollIntoView({
      block: 'center',
      behavior: 'smooth',
    });
  };
  return { flash, jump };
}
