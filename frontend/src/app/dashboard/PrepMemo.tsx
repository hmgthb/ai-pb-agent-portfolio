'use client';

/** 상담 준비 메모 — 보유 종목에 대해 **이미 수집된 사실**만 모아 보여준다.
 *
 *  여기서 에이전트를 새로 돌리지 않는다(크레딧 0) — 브리프(F2)와 종목 노트(F3)가 출처와
 *  함께 이미 가진 것을 고객 기준으로 다시 배열할 뿐이다("공통 인프라 1 + 얇은 레이어 N").
 *  확인된 게 없으면 없다고 말한다 — 빈 줄을 그럴듯한 문장으로 채우지 않는다(가드레일 3).
 *
 *  자리가 둘이라 page.tsx에서 이 파일로 옮겼다(2026-07-29):
 *    ① 고객 포트폴리오 카드 — 전 보유 종목. 바로 위에 보유 표가 있어 금액·비중은 안 적는다.
 *    ② 고객 문의 모달 — 문의가 가리키는 **한 종목만**(`only`), 금액·비중까지(`amounts`).
 *       그 화면에는 보유 표가 없어서 "얼마나 들고 있나"를 여기 말고 말할 자리가 없다.
 *  ⚠️ 두 벌로 복사하지 말 것 — 출처 줄의 개수(공시 2·뉴스 1)와 빈 상태 문구가 갈린다.
 */

import { useState } from 'react';
import { fmtDate, fmtKRW } from './api';
import { PILL, type Brief, type Customer, type NoteDetail } from './types';

/** 한 종목의 준비 줄(공시 2 · 뉴스 1 · 노트) — **이 파일이 유일한 정본**이다.
 *
 *  자리가 셋으로 늘었다(2026-08-03): 고객 카드의 **보유 표 안**(펼친 행) · 고객 문의 모달 ·
 *  아래 `PrepMemo`. 표 안으로 들어간 이유는 §고객 카드 주석에 있다 — 종목 이름이 표에
 *  한 번, 준비 메모에 또 한 번 나와 같은 목록이 두 벌이었다.
 *  ⚠️ 개수(공시 2·뉴스 1)와 빈 상태 문구를 여기 말고 다른 데서 다시 쓰지 말 것. */
export function PrepLines({
  code,
  brief,
  notes,
  onOpenNote,
}: {
  code: string;
  brief: Brief | null;
  notes: Record<string, NoteDetail>;
  onOpenNote: (code: string) => void;
}) {
  const b = brief?.items.find((i) => i.stock_code === code) ?? null;
  const note = notes[code] ?? null;
  const lines = [
    ...(b?.disclosures ?? []).slice(0, 2).map((d) => ({
      tag: '공시',
      text: d.report_nm.trim(),
      href: d.viewer_url,
      meta: fmtDate(d.rcept_dt),
    })),
    ...(b?.news ?? []).slice(0, 1).map((n) => ({
      tag: '뉴스',
      text: n.title,
      href: n.link,
      meta: fmtDate(n.pub_date),
    })),
  ];
  return (
    <>
      {lines.map((l, i) => (
        <div className="prep-line" key={i}>
          <span className="btag">{l.tag}</span>
          <a href={l.href || '#'} target="_blank" rel="noreferrer">
            {l.text}
          </a>
          <span className="bcode"> {l.meta}</span>
        </div>
      ))}
      {note && (
        <div className="prep-line">
          <span className="btag">노트</span>
          <button className="linklike" onClick={() => onOpenNote(code)}>
            {note.corp_name} 종목 노트 열기
          </button>
          <span className="bcode"> · {PILL[note.status]?.[0] ?? note.status}</span>
        </div>
      )}
      {!lines.length && !note && (
        <div className="prep-line muted">
          오늘 브리핑·노트에 이 종목은 없습니다.
        </div>
      )}
    </>
  );
}

export default function PrepMemo({
  customer,
  brief,
  notes,
  onOpenNote,
  only,
  amounts,
}: {
  customer: Customer;
  brief: Brief | null;
  notes: Record<string, NoteDetail>;
  onOpenNote: (code: string) => void;
  /** 종목코드 하나 — 주면 그 종목만 그린다(문의 모달). 없으면 전 보유 종목. */
  only?: string;
  /** 종목 이름 줄에 평가금액·주식 내 비중을 같이 적는다. 보유 표가 없는 화면에서만 켠다. */
  amounts?: boolean;
}) {
  const holdings = only
    ? customer.holdings.filter((h) => h.code === only)
    : customer.holdings;
  /* 종목별로 접는다(2026-08-03). 접힌 줄은 이름·코드(+`amounts`면 금액·비중)뿐이다.
     ⚠️ 기본값이 화면마다 다르다: 문의 모달(`only`, 종목 하나)은 **펼침**이고 그 밖은
        **접힘**이다. 전자는 그 종목 하나를 보려고 연 화면이라 접어 두면 열자마자 다시
        눌러야 한다.
     상태는 컴포넌트 안에 둔다 — 고객을 바꾸면 부모가 다시 그리므로 자연히 초기화된다. */
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (code: string) => open[code] ?? !!only;

  // 라벨을 두지 않는다. 이 구역의 이름이 될 만한 말은 전부 화면 어딘가가 이미 쓰고 있었다 —
  // "상담 준비"는 PB 탭 이름이고, "보유 종목"은 바로 위 표(aria-label)와 오른쪽 채팅 머리말이
  // 쓴다. 두 블록의 경계는 .prep의 border-top이 이미 만들고 있어서 라벨이 없어도 섞이지 않는다.
  return (
    <div className="prep">
      {holdings.map((h) => {
        // 시세는 싣지 않는다. 브리프에 든 종목만 시세가 잡혀서 같은 목록인데 어떤 줄은
        // 가격·등락률이 붙고 어떤 줄은 이름만 나왔다 — 그 차이가 "이 종목이 더 중요하다"로
        // 읽히지만 실제 뜻은 "오늘 브리핑 3종목에 들었다"일 뿐이다. 시세가 필요하면
        // 브리핑 카드에 있다. 여기서는 이름·코드만 같은 모양으로 둔다.
        const shown = isOpen(h.code);
        return (
          <div className="prep-row" key={h.code}>
            {/* 종목 이름 줄이 그대로 여는 버튼이다(브리핑 카드와 같은 규칙) — 접으면
                이 줄만 남으므로, 누를 곳을 따로 만들면 접힌 상태에 조작이 하나 더 선다. */}
            <button
              type="button"
              className="prep-name"
              aria-expanded={shown}
              title={
                shown ? '접기 — 공시·뉴스·노트를 숨깁니다' : '펴기 — 공시·뉴스·노트를 봅니다'
              }
              onClick={() => setOpen((o) => ({ ...o, [h.code]: !shown }))}
            >
              {h.name} <span className="bcode">{h.code}</span>
              {/* 분모와 반올림은 백엔드 `f1.portfolio_facts`가 단일 출처다 — 화면에서 다시
                  나누지 않는다. 비중이 없으면 그 조각만 뺀다(0%로 적지 않는다). */}
              {amounts && (
                <span className="bcode">
                  {' '}
                  · ₩{fmtKRW(h.amt)}
                  {h.pct_of_equity != null && ` · 주식 내 ${h.pct_of_equity}%`}
                </span>
              )}
              <span className="bcaret" aria-hidden="true">
                {shown ? '⌄' : '›'}
              </span>
            </button>
            {shown && (
              <PrepLines
                code={h.code}
                brief={brief}
                notes={notes}
                onOpenNote={onOpenNote}
              />
            )}
          </div>
        );
      })}
      {!holdings.length && <div className="hint">보유 종목이 없습니다.</div>}
    </div>
  );
}
