'use client';

/** `AI가 보는 정보` — 고객 데이터가 외부 모델에 **어떤 꼴로 나가는가**를 화면에 그린다.
 *
 *  핵심은 형식이다: 고객 상세 패널(`.detail`)과 **같은 마크업·같은 CSS 클래스**로 그리고
 *  값만 변환본으로 바꾼다. 그래야 왼쪽 상세와 나란히 놓고 무엇이 빠졌는지 눈으로 걸린다 —
 *  `잔고 ₩14.3억` 자리에 `잔고 구간 10억~50억`이, `평가금액 ₩5.8억` 자리에 `가림`이 선다.
 *  ⚠️ **불릿으로 "무엇을 가렸는지" 늘어놓지 말 것**(2026-07-29에 걷어냈다) — 표가 제자리에서
 *     이미 말하는 것을 산문으로 한 번 더 적으면 상자가 답변보다 길어진다.
 *
 *  ⚠️ **라벨은 `AI가 보는 정보` 하나다**(2026-07-29 확정). 되돌리지 말 것:
 *    - `비식별화`였는데 **부정확했다** — 이름을 가명(`고객 #1`)으로, 나이를 나이대로 바꾼 건
 *      개인정보보호법 용어로 **가명처리**다(익명이 아니다). `비식별화`는 현행법 용어가 아니다.
 *    - 그렇다고 `가명처리`로 가지 않은 건 **읽는 사람이 PB**여서다. PB가 실제로 품는 질문이
 *      "내 고객 정보 중 뭐가 AI한테 가지?"이고, 이 대시보드는 이미 `AI가 오늘 한 일`이라는
 *      같은 말투의 접이식 한 줄을 쓴다 — 둘이 한 화면에서 짝이 된다.
 *    - 뒷말(`질문하면 이 형태로 나갑니다`)도 지웠다. **자리가 어느 쪽인지를 말한다**:
 *      입력창 위면 "물어보면 볼 것", 답변 말풍선 안이면 "이 답을 만들 때 본 것".
 *      같은 말이 두 뜻을 다 담아서 분기가 필요 없다.
 */

import { ALLOC_COLORS, allocEntries, Donut } from './charts';
import type { ChatRedaction, EgressPortfolio } from './types';

/** 도넛 툴팁을 안 붙인다 — 이 상자는 접혀 있다가 열리는 부가 표시라, 툴팁을 띄우려면
 *  `Tip` 렌더 지점까지 끌고 와야 하는데 그만한 값이 없다. 같은 수치를 범례가 이미 적는다. */
const NO_TIP = () => ({});

/** 고객 상세 패널의 **가려진 쌍둥이**. `.detail` 클래스를 그대로 빌려 써서 두 패널이
 *  같은 글자 크기·같은 표 모양으로 선다(`.egress-twin`이 칸 테두리만 지운다).
 *  ⚠️ 왼쪽 상세의 마크업이 바뀌면 여기도 같이 봐야 한다 — 형식이 갈리는 순간 이 상자의
 *     값어치(나란히 놓고 대조)가 사라진다. */
function EgressTwin({ p }: { p: EgressPortfolio }) {
  const alloc = Object.fromEntries(p.alloc.map((a) => [a.class, a.pct]));
  return (
    <div className="detail egress-twin">
      {/* 왼쪽 상세의 `1 강준서` 자리 — **가명**이 대신 선다. "이름 없음"이라고 적어 봤지만
          주어가 빈 채로 읽혀서(2026-07-29), 나가는 값을 그대로 보이는 쪽으로 바꿨다.
          ⚠️ 가명은 익명이 아니다 — 원본 DB와 대조하면 사람이 특정된다(HANDOFF §0-1). */}
      <div className="name">
        {p.customer_ref ?? '고객'}{' '}
        {/* 왼쪽 상세 이름 옆과 **같은 글리프**다. payload의 `flags`가 비지 않았다는 뜻이라
            여기 서는 게 맞고(아래 사유 줄과 한 덩어리), 형식이 같아야 대조가 된다. */}
        {p.flags.length > 0 && (
          <span
            className="flag"
            title={p.flags.map((f) => f.text).join(' · ')}
            aria-label={`위험 플래그: ${p.flags.map((f) => f.text).join(' · ')}`}
          >
            ⚑
          </span>
        )}
      </div>
      {/* 왼쪽의 `110-***-107675 · 38세 · 공격투자형` 자리. 계좌는 안 나가고 나이는 나이대로. */}
      <div className="acct">
        {[p.age_band, p.risk_label].filter(Boolean).join(' · ') || '—'}
      </div>
      {/* ⚠️ 플래그가 없으면 **줄을 안 낸다.** 왼쪽 상세는 반대로 `위험 플래그 없음`을 적는데
          (비면 "규칙을 안 돌렸다"와 구분되지 않아서), 여기는 payload를 그리는 자리라
          빈 배열은 아무것도 아닌 게 맞다. 두 규칙이 다른 건 의도다. */}
      {p.flags.length > 0 && (
        <div className="flag-reasons">
          {p.flags.map((f) => f.text).join(' · ')}
        </div>
      )}
      <div className="row">
        <div className="kv">
          {/* 라벨이 `잔고`가 아니라 `잔고 구간`인 것 자체가 변환을 말한다. */}
          <div className="k">잔고 구간</div>
          <div className="v">{p.balance_band ?? '—'}</div>
        </div>
        <div className="kv">
          <div className="k">수익률 (연초 대비)</div>
          <div className={`v delta ${(p.return_pct ?? 0) >= 0 ? 'up' : 'down'}`}>
            {p.return_pct == null
              ? '—'
              : `${p.return_pct >= 0 ? '+' : ''}${p.return_pct.toFixed(1)}%`}
          </div>
        </div>
      </div>
      <div className="donut-wrap">
        <Donut alloc={alloc} bind={NO_TIP} size={96} />
        <div className="legend">
          {allocEntries(alloc).map(([k, v], i) => (
            <div className="li" key={k}>
              <span
                className="sw"
                style={{ background: ALLOC_COLORS[i % ALLOC_COLORS.length] }}
              />
              {k}
              <span className="pct">{v}%</span>
            </div>
          ))}
        </div>
      </div>
      <table className="holdings" aria-label="외부 모델로 나가는 보유 종목">
        <thead>
          <tr>
            <th>종목</th>
            <th className="num">평가금액</th>
            <th className="num">주식 내</th>
            {/* 왼쪽 상세에 없는 열이다 — 잔고 대비 비중은 실금액 대신 나가는 값이라
                여기서만 보인다(모델이 "계좌 전체에서 얼마나"를 답할 근거). */}
            <th className="num">잔고 대비</th>
          </tr>
        </thead>
        <tbody>
          {p.holdings.map((h) => (
            <tr key={h.code}>
              <td>
                <strong>{h.name}</strong>{' '}
                <span style={{ color: 'var(--muted)' }}>{h.code}</span>
              </td>
              {/* 열을 지우지 않고 **가려진 채로 남긴다.** 열이 통째로 없으면 왼쪽 상세와
                  줄이 어긋나 대조가 안 되고, 무엇이 빠졌는지도 "없는 것"으로만 남는다. */}
              <td className="num egress-mask" title="외부 모델로 나가지 않습니다">
                가림
              </td>
              <td className="num pct-eq">
                {h.pct_of_equity == null ? '—' : `${h.pct_of_equity}%`}
              </td>
              <td className="num pct-eq">
                {h.pct_of_balance == null ? '—' : `${h.pct_of_balance}%`}
              </td>
            </tr>
          ))}
          {!p.holdings.length && (
            <tr>
              <td colSpan={4} className="egress-gone">
                보유 종목 없음
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function RedactionDetails({ r }: { r: ChatRedaction }) {
  return (
    <details className="redact">
      <summary>AI가 보는 정보</summary>
      {/* **상자 안은 표 하나뿐이다**(2026-07-29). 설명문도 원문 JSON도 차례로 뺐다 —
          읽는 사람은 PB이지 개발자가 아니고, 표가 이미 같은 값을 같은 자리에서 말한다.
          "무엇이 빠졌나"는 표의 `가림`·`잔고 구간`·`고객 #1`이 제자리에서 답한다.
          ⚠️ 설명문을 되살리지 말 것. 되살리려면 먼저 "표로 안 되는 이유"가 있어야 한다.
             이 기능의 한계(가명이지 익명이 아니다 · 기밀성이 아니라 구조를 얻는다)는
             HANDOFF §0-1과 CLAUDE.md가 들고 있다. */}
      <div className="redact-body">
        <EgressTwin p={r.payload} />
      </div>
    </details>
  );
}
