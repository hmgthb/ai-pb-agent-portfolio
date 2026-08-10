'use client';

/** F1 대화형 종목 Q&A (멀티턴).
 *
 *  `GET /api/chat/stream?q=...`의 SSE를 말풍선으로 옮긴다:
 *    blocked      → 입력 가드(MNPI·인젝션·PII) 차단 — 빨간 말풍선, 에이전트 안 돎
 *    routing      → 어느 에이전트로 갔는지 배지(감사 가능한 규칙 결정)
 *    answer_token → 답변 토큰 스트리밍(말풍선에 점진 표시)
 *    answer       → 최종 문장별 출처 배지 + 지연시세 고지
 *    run_error    → 실행 오류(연결 끊김과 구분)
 *
 *  멀티턴은 백엔드가 발급한 세션 id(`session` 이벤트)를 다음 턴에 붙여 이어간다 — Redis에는
 *  라우팅 맥락만 남고(TTL 1시간) 답변 본문은 담기지 않는다.
 *
 *  ⚠️ **대화는 이 컴포넌트의 state다.** 그래서 전역 F1(우하단 고정 버튼)은 모달을 닫아도
 *     **언마운트하지 않고 hidden으로만 감춘다**(page.tsx) — 언마운트되면 turns가 사라지는
 *     것은 물론이고 cleanup이 EventSource를 닫아 **답변이 오는 중이면 크레딧만 쓰고 버린다**
 *     (F3 생성 뷰와 같은 이유·같은 처방, HANDOFF §0-1).
 *  ⚠️ **새로 고치면 지워지는 건 그대로 둔다.** 답변을 sessionStorage에 남기면 고객 이야기가
 *     브라우저 저장소에 쌓인다 — 아래 입력창의 autoComplete를 끈 것과 같은 이유다.
 */

import { useEffect, useRef, useState } from 'react';
import { chatStreamUrl } from './api';
import { RedactionDetails } from './redaction';
import { mergeSources, SourceBadge } from './sources';
import type {
  ChatAnswer,
  ChatRedaction,
  ChatRouting,
  NoteSentence,
  PrepItem,
} from './types';

/* 라우팅 배지 이름표는 **여기 없다**(2026-08-09에 `backend/f1.ROUTE_LABEL`로 옮겼다).
 *
 * 화면에 표를 두었더니 라우트를 늘릴 때마다 조용히 빠졌다 — `portfolio_advice`는 빈 상자로
 * (2026-08-06), `situation`·`risk_review`는 `—`로 떴다(2026-08-09). 라우트를 정하는 곳이
 * 백엔드이므로 이름도 거기서 정해 `routing.label`에 실려 온다. **여기서 표를 다시 만들지 말 것.** */

type Turn = {
  q: string;
  routing?: ChatRouting;
  redaction?: ChatRedaction;
  streaming: string;
  answer?: ChatAnswer;
  blocked?: string[];
  /** 어느 문지기에 걸렸나: `input`=들어오는 질문, `egress`=나가는 프롬프트.
   *  둘은 사용자가 할 일이 다르다 — 앞은 질문을 고쳐 쓰고, 뒤는 데이터가 새는 것이라
   *  질문을 고쳐도 같은 결과일 수 있다. */
  blockedStage?: string;
  error?: string;
  running: boolean;
  /** 이 답이 키워드 형식인가 — **백엔드가 `session` 이벤트로 알려준다**(`main.keyword_format`).
   *  토큰이 흐르는 동안 원문 대신 키워드만 그릴지가 여기서 갈린다.
   *  ⚠️ 화면에서 `customerId != null`로 다시 판단하지 말 것. 규칙이 두 곳에 있으면 한쪽만
   *     고쳐져 조용히 어긋난다 — 라우팅 이름표에서 이미 두 번 겪었다(위 머리말). */
  kwFormat?: boolean;
};

/** 보내기 전 경고 — 입력창에 담당 고객 이름이나 계좌·주민번호 형식이 있으면 알린다.
 *
 *  ⚠️ **이건 게이트가 아니다.** 권위는 백엔드(`compliance.egress_guard`)에 있고 여기서는
 *     막지 않는다(보내기 버튼도 그대로 살아 있다) — 브라우저는 이미 `/api/customers`로
 *     이름·계좌·실금액을 받아 화면에 그리고 있어서, 여기서 가려 봐야 보장이 생기지 않는다.
 *     이 줄이 하는 일은 **누르기 전에 알려 주는 것**뿐이다(백엔드가 막으면 크레딧은 안 쓰지만
 *     왕복은 한다). 오탐이어도 사람이 그냥 보낼 수 있어야 해서 차단하지 않는다.
 *  ⚠️ 규칙은 백엔드와 **같은 뜻**으로 맞춘다: 3글자 이상 이름만, 계좌·주민번호는 숫자 형식.
 *     2글자를 안 잡는 이유도 같다(일반 낱말과 겹쳐 오탐). */
const _ACCOUNT_RE = /\d{2,3}\s*[-–]\s*\d{3,4}\s*[-–]\s*\d{4,6}/;
const _RRN_RE = /\d{6}\s*[-–]\s*[1-4]\d{6}/;
function outboundWarning(text: string, names: string[]): string | null {
  // 사유마다 할 일이 다르다 — 이름은 **바꿔** 물으면 되고(종목·비중이면 같은 답이 나온다),
  // 계좌·주민번호는 바꿀 게 아니라 **지우는** 것이다(답변에 쓸 데가 없다).
  const hit = names.find((n) => n.length >= 3 && text.includes(n));
  if (hit)
    return `고객 이름이 들어 있습니다(${hit}). 이름 대신 종목·비중으로 물어보세요.`;
  if (_RRN_RE.test(text) || _ACCOUNT_RE.test(text))
    return '계좌·주민번호 형식이 들어 있습니다. 지우고 물어보세요.';
  return null;
}

/** 토큰이 흐르는 동안 보여줄 **키워드만** 뽑는다 — `[[키워드, …], …]`(순수 함수).
 *
 *  왜 필요한가: 답이 오는 동안 원문을 그대로 찍으면 **최종 화면에서는 접힐 문장이 통째로
 *  지나간다.** 읽는 사람은 그걸 이미 읽어 버려서, 키워드로 접어 둔 뜻이 없어진다.
 *  그래서 도착한 만큼에서 `::` 앞부분(키워드)만 그린다.
 *
 *  ⚠️ **이건 진행 표시지 답이 아니다.** 여기서 그린 키워드는 백엔드 검사(`f1.valid_label` —
 *     문장의 조각인지 대조)를 아직 안 거쳤고, `answer` 이벤트가 오면 검사를 통과한 것으로
 *     통째로 갈린다. 그래서 여기 나왔다가 사라지는 키워드가 있을 수 있다(정상이다).
 *  ⚠️ 숫자가 든 조각은 **여기서도 뺀다.** 백엔드가 막는 것과 같은 이유이고(접힌 채 근거 없이
 *     보이는 수치 · 가드레일 3), 잠깐 스쳐 지나가는 화면이라고 예외를 두지 않는다.
 *  ⚠️ `::`가 아직 안 온 줄은 **키워드를 치는 중**으로 본다. 다만 그 상태로 너무 길어지면
 *     형식이 깨진 것이므로(모델이 산문을 쓰고 있다) 그 줄은 그리지 않는다 — 안 그러면
 *     막으려던 산문이 그대로 다시 흐른다. 없으면 `조회 중…`이 그대로 서는 것이 맞다. */
const LIVE_HEAD_MAX = 70; // 키워드 3개(각 20자)와 구분자가 들어갈 만큼

export function liveKeywords(buf: string): string[][] {
  return buf
    .split('\n')
    .map((line) => {
      const cut = line.indexOf('::');
      const head = cut >= 0 ? line.slice(0, cut) : line;
      // `::`가 아직 없는 줄에서 길이나 마침표가 나오면 키워드가 아니라 **산문**이다
      // (모델이 형식을 깼다). 그리지 않는다 — 막으려던 문장이 그대로 흐르게 된다.
      if (cut < 0 && (head.length > LIVE_HEAD_MAX || head.includes('.'))) return [];
      return head
        .split('|')
        .map((w) => w.trim())
        .filter((w) => w && !/\d/.test(w));
    })
    .filter((kws) => kws.length > 0);
}

/** 입력창에 질문을 채워 넣는 신호. 같은 종목을 두 번 눌러도 다시 채워져야 하므로
 *  문자열이 아니라 **눌린 횟수(n)를 같이** 들고 다닌다 — 값이 같으면 effect가 안 돈다. */
export type ChatPrefill = { q: string; n: number };

/** `담기` 버튼이 자기가 담은 것을 알아보는 값. 상담 메모(부모가 들고 있다)와 답변 문장은
 *  서로 다른 자료구조라, **무엇이 이미 담겼는지**는 이 키로만 이어진다.
 *  종류를 앞에 붙이는 이유: 선택지 이름과 같은 문장이 답변에 나와도 둘은 다른 항목이다.
 *  ⚠️ 본문으로 맞추는 것은 의도다 — 담은 뒤 메모 상자에서 ×로 뺀 것도 여기서 풀려야
 *     버튼이 `✓ 담김`으로 남아 거짓말을 하지 않는다. */
export function prepKey(it: PrepItem): string {
  return it.kind === 'option' ? `option:${it.label}` : `${it.kind}:${it.text}`;
}

/** 언마운트를 넘겨 대화를 들고 있는 자리. **부모가 소유한다**(여기서 만들면 같이 사라진다).
 *
 *  전역 F1은 모달을 `hidden`으로만 감춰서 이것이 필요 없다. 이건 **감출 수 없는 자리**를 위한
 *  것이다 — 고객 문의 모달은 큐의 한 건에 딸려 있어 감춰 두면 어느 문의의 대화인지가 화면에서
 *  사라지고, 고객 카드의 채팅은 고객을 바꾸는 순간 그 자리가 다른 고객의 것이 된다.
 *  그래서 대화를 **문의별·고객별로** 들고 있다가 같은 건을 다시 열 때 돌려준다.
 *  ⚠️ 키가 갈리면 대화도 갈린다 — 대화마다 세션 id가 따로 보관되므로, 다른 고객으로 갔다
 *     돌아와도 후속 질문은 **자기 대화의 종목**을 이어받는다(키를 뭉뚱그리면 이 보장이 깨진다).
 *  ⚠️ 새로 고치면 사라진다(전역 F1과 같은 기준) — `sessionStorage`에 담지 않는 이유도 같다. */
export type ChatKeep = Map<
  string,
  { turns: ChatTurn[]; session: string | null; input: string }
>;
export type ChatTurn = Turn;

export default function F1Chat({
  prefill,
  compact,
  customerId,
  customerNames,
  preview,
  onClose,
  active,
  onRunningChange,
  keep,
  keepKey,
  onTurnsChange,
  viewMode,
  onPick,
  picked,
}: {
  /** 입력창을 채우는 유일한 경로(고객 카드의 보유 종목 칩·분석 칩).
   *  ⚠️ 마운트 시점 prop(`initial`)은 걷어냈다 — 전역 F1은 닫아도 언마운트되지 않으므로
   *     두 번째 열기부터 조용히 무시된다. 채워 여는 길은 이것 하나여야 한다. */
  prefill?: ChatPrefill | null;
  /** 카드 안에 인라인으로 놓을 때. 모달용 큰 머리말·안내문을 접고 높이를 부모에 맞춘다. */
  compact?: boolean;
  /** 붙이면 **포트폴리오 질문**까지 답한다(집중도·배분·성향 대비). 안 붙이면 종목 질문만.
   *  전역 F1(우하단 고정 버튼)에는 고객이 없으므로 undefined로 열린다. */
  customerId?: number;
  /** 담당 고객 명단 — 보내기 전 경고에만 쓴다. 브라우저가 이미 갖고 있는 값이라
   *  (`/api/customers`가 이름을 준다) 여기 넘긴다고 새로 노출되는 건 없다. */
  customerNames?: string[];
  /** 이 고객에 대해 물으면 무엇이 나가는가 — 질문 전에 미리 보여준다(크레딧 0).
   *  `GET /api/customers/{id}/egress-preview`가 준 값 그대로. */
  preview?: ChatRedaction | null;
  /** 머리말에 닫기(×)를 낸다. 모달로 열린 경우에만 넘어온다 — 인라인(카드 안)은 닫을
   *  것이 없고, 고객 문의 모달은 자기 ×가 이미 있다(둘이면 어느 쪽이 무엇을 닫는지 모른다). */
  onClose?: () => void;
  /** 지금 화면에 보이나. 감춰진 동안(`display: none`)은 높이가 0이라 자동 스크롤이 먹지
   *  않아서, 다시 열릴 때 한 번 더 내려야 최신 답변이 보인다. 안 넘기면 항상 보이는 것으로
   *  본다(인라인). */
  active?: boolean;
  /** 실행 중인지를 밖에 알린다 — 모달을 닫아도 스트림은 계속 도는데, 닫아 둔 동안에는
   *  화면에 그 사실을 말할 자리가 고정 버튼밖에 없다(F3 탭 라벨의 `●`과 같은 처방). */
  onRunningChange?: (running: boolean) => void;
  /** 답변 문장·선택지를 **상담 준비 메모에 담는다**(2026-08-06). 넘기지 않으면 담기 버튼이
   *  아예 안 그려진다 — 메모를 들고 있을 자리가 없는 화면(전역 F1)에서는 담을 수도 없다.
   *  ⚠️ 담는 것은 화면 상태일 뿐이다(서버에 저장하지 않는다). */
  onPick?: (item: PrepItem) => void;
  /** 이미 담긴 항목의 `prepKey` 모음 — 버튼이 `✓ 담김`으로 서고 문장에 옐로 바가 붙는다.
   *  **여기서 들고 있지 않는 건 의도다**: 담긴 것의 주인은 상담 메모(부모)이고, 메모에서
   *  ×로 뺀 것이 버튼에 바로 반영되어야 한다. 안 넘기면 상태 표시 없이 담기만 된다. */
  picked?: ReadonlySet<string>;
  /** 언마운트를 넘겨 대화를 보관한다(`ChatKeep`). 둘 다 줘야 동작한다.
   *  고객 카드도 붙인다(2026-08-06) — 한동안은 `key={고객id}`로 **새로 시작하는 것이 결정**
   *  이었는데, 고객을 오가며 훑는 것이 이 화면의 기본 동작이라 방금 받은 답이 목록 클릭 한
   *  번에 사라졌다(상담 준비 메모를 고객별로 남긴 것과 같은 이유).
   *  ⚠️ 새로 시작하게 만든 위험은 그대로 막혀 있다: 키가 고객별이라 **세션 id도 고객별**로
   *     보관되고, 돌아온 대화의 후속 질문은 앞 고객이 아니라 자기 대화의 종목을 이어받는다. */
  keep?: ChatKeep;
  keepKey?: string;
  /** 지금 대화에 말풍선이 몇 개인가 — 부모가 `새 대화`를 낼지 정하는 데만 쓴다(비어 있으면
   *  비울 것이 없다). 대화의 주인은 여전히 이쪽이고, 부모는 개수만 본다. */
  onTurnsChange?: (n: number) => void;
  /* 대화 로그 오른쪽 위에 조작을 겹치는 `corner` 슬롯이 있었다(2026-08-03~08-06).
     고객 카드의 `크게 보기`가 유일한 사용처였고 지금은 카드 제목 줄로 옮겼다 —
     로그 상자 안에 떠 있는 조작은 대화의 일부처럼 보이고, 첫 답변이 오면 그 위에 겹친다.
     ⚠️ 되살린다면 겹치는 것이 **대화를 가리지 않는지** 먼저 볼 것. */
  /** 지금 이 대화를 **어떻게 보고 있나**(고객 카드의 보통/크게 보기). 값이 바뀌면 미리보기
   *  접이식 상자가 접힌 상태로 돌아간다 — 크게 열었을 때 기본값이 접힘이어야 대화가 먼저
   *  보인다. ⚠️ 여기서 **컴포넌트를 옮겨 그리지 않는다**(page.tsx: 클래스만 바꾼다) —
   *     그래서 `<details>`의 열림이 그대로 살아남고, 이 신호가 필요하다. */
  viewMode?: string;
} = {}) {
  // 보관된 대화가 있으면 그것으로 시작한다(`useState` 초기값은 마운트에만 쓰인다 —
  // 다시 열릴 때 새 마운트이므로 여기서 한 번 읽는 것이 맞다).
  const kept = keep && keepKey ? keep.get(keepKey) : undefined;
  // 칩을 누르면 질문이 채워진 채로 선다. **보내지는 않는다** — 실행은 크레딧을 쓰고
  // 답변은 고객 앞에서 쓰일 수 있으니, 시작 버튼은 사람이 누른다.
  const [input, setInput] = useState(kept?.input ?? '');
  const [turns, setTurns] = useState<Turn[]>(kept?.turns ?? []);
  // 멀티턴: 백엔드가 발급한 세션 id를 들고 다음 턴에 붙인다 → "관련 뉴스는?"이 종목을 이어받는다.
  const sessionRef = useRef<string | null>(kept?.session ?? null);
  const esRef = useRef<EventSource | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const running = turns.length > 0 && turns[turns.length - 1].running;
  /** 펴 놓은 키워드 — `턴번호:문장번호`. **여러 개를 동시에 펼 수 있다**(하나만 열리는
   *  아코디언이 아니다): PB는 두 항목을 나란히 놓고 견주려고 펴는 것이라, 새로 누를 때
   *  앞의 것이 닫히면 방금 읽던 문장이 사라진다.
   *  ⚠️ 답변이 아니라 **보기 상태**다 — 대화 보관(`ChatKeep`)에 넣지 않는다. 다시 열면
   *     전부 접힌 채로 서는 것이 맞다(그게 이 형식의 기본 상태다). */
  const [openKw, setOpenKw] = useState<ReadonlySet<string>>(new Set());
  const toggleKw = (key: string) =>
    setOpenKw((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  // 렌더 중 계산이다(상태가 아니다) — 입력이 바뀌면 그 프레임에 같이 바뀌어야 하고,
  // effect로 두면 한 글자 늦게 뜬다. 순수 문자열 검사라 비용도 없다.
  const warning = outboundWarning(input, customerNames ?? []);

  // 대화·입력을 보관 자리에 계속 흘려 둔다(Map에 대입하는 것뿐이라 값이 싸다).
  // 세션 id는 ref라 여기서 읽는 값이 곧 현재값이다 — `session` 이벤트 뒤에는 반드시 turns가
  // 한 번 더 바뀌므로(답변·done) 마지막 기록에는 세션이 들어 있다.
  useEffect(() => {
    if (keep && keepKey)
      keep.set(keepKey, { turns, session: sessionRef.current, input });
  }, [turns, input, keep, keepKey]);

  useEffect(
    () => () => {
      esRef.current?.close();
      // 언마운트되는 순간 스트림도 끊긴다(모달을 닫거나, 고객 목록에서 다른 고객을 고르거나).
      // 보관된 마지막 턴이 `running`으로 남으면 다시 열었을 때 **끝나지 않는 `조회 중…`**이
      // 서므로, 끊겼다는 사실을 그 자리에 적어 둔다.
      if (!keep || !keepKey) return;
      const c = keep.get(keepKey);
      const last = c?.turns[c.turns.length - 1];
      if (!c || !last?.running) return;
      keep.set(keepKey, {
        ...c,
        turns: [
          ...c.turns.slice(0, -1),
          {
            ...last,
            running: false,
            error: '다른 화면으로 옮겨 중단됐습니다. 다시 물어보세요.',
          },
        ],
      });
    },
    [keep, keepKey],
  );
  // 감춰진 동안에는 상자 높이가 0이라 여기서 내려도 scrollTop이 0에 머문다 — 그래서
  // `active`도 의존성이다. 다시 열리는 프레임에 한 번 더 돌아야 방금 온 답변이 보인다.
  useEffect(() => {
    if (active === false) return;
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [turns, active]);
  // ResearchCard는 setRunning과 짝지어 직접 부르는데(effect 없이), 여기서는 running이
  // state가 아니라 **마지막 턴에서 파생된 값**이라 감시하는 쪽이 정확하다.
  useEffect(() => {
    onRunningChange?.(running);
  }, [running, onRunningChange]);
  // 보관된 대화로 다시 마운트될 때도 한 번은 돌아야 한다 — 부모의 `새 대화`는 이 값만 보고
  // 서고, 고객을 바꾼 직후가 정확히 그 상황이다(말풍선은 있는데 부모는 모르는 프레임).
  useEffect(() => {
    onTurnsChange?.(turns.length);
  }, [turns.length, onTurnsChange]);
  // 칩을 누르면 입력창만 채운다(보내지 않는 건 위와 같은 이유다).
  // effect가 아니라 **렌더 중 조정**이다 — 프리필은 화면에 그려지기 전에 반영돼야 하고,
  // effect로 하면 빈 입력창이 한 번 그려졌다가 채워진다. 신호는 n으로 소비 여부를
  // 판단한다: 같은 종목을 두 번 눌러도 q는 같으므로 문자열로는 구분되지 않는다.
  const [seenPrefill, setSeenPrefill] = useState(prefill?.n ?? 0);
  if (prefill && prefill.n !== seenPrefill) {
    setSeenPrefill(prefill.n);
    setInput(prefill.q);
  }

  const patchLast = (p: Partial<Turn>) =>
    setTurns((ts) =>
      ts.map((t, i) => (i === ts.length - 1 ? { ...t, ...p } : t)),
    );

  /** 새 대화 — 모달을 닫아도 대화가 남게 된 뒤로, 끊는 자리가 여기밖에 없다.
   *  말풍선만 비우는 게 아니라 **세션 id도 버린다**: 다음 질문이 앞 대화의 종목을
   *  이어받으면(멀티턴 last_entity) 다른 고객 이야기를 하는 중에 엉뚱한 종목이 답으로
   *  나온다. 고객 카드가 `key`로 대화를 새로 시작하는 것과 같은 이유이고, 여기는 고객이
   *  없으니 사람이 끊어 준다.
   *  ⚠️ 입력창은 비우지 않는다 — 지금 쓰고 있는 질문은 지난 대화가 아니라 사람의 것이다. */
  function reset() {
    if (running) return;
    esRef.current?.close();
    esRef.current = null;
    sessionRef.current = null;
    setTurns([]);
    // 보관 자리도 같이 비운다 — 안 비우면 다시 열었을 때 지운 대화가 돌아온다.
    if (keep && keepKey) keep.delete(keepKey);
  }

  function send() {
    const q = input.trim();
    if (!q || running) return;
    setInput('');
    setTurns((ts) => [...ts, { q, streaming: '', running: true }]);

    const es = new EventSource(
      chatStreamUrl(q, sessionRef.current, customerId ?? null),
    );
    esRef.current = es;
    let done = false;

    es.addEventListener('session', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      sessionRef.current = d.session;
      // 첫 토큰보다 먼저 온다 — 그래야 스트리밍을 무엇으로 그릴지 정할 수 있다.
      patchLast({ kwFormat: !!d.keyword_format });
    });
    es.addEventListener('routing', (e) =>
      patchLast({ routing: JSON.parse((e as MessageEvent).data) }),
    );
    es.addEventListener('blocked', (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      patchLast({ blocked: d.violations, blockedStage: d.stage ?? 'input' });
    });
    // 비식별화 경계를 지난 뒤에만 온다 — 이 이벤트가 있다는 건 "실제로 이것이 나갔다"는 뜻이다
    // (가드에 걸려 차단되면 오지 않는다).
    es.addEventListener('redaction', (e) =>
      patchLast({ redaction: JSON.parse((e as MessageEvent).data) }),
    );
    es.addEventListener('answer_token', (e) =>
      setTurns((ts) =>
        ts.map((t, i) =>
          i === ts.length - 1
            ? {
                ...t,
                streaming:
                  t.streaming + JSON.parse((e as MessageEvent).data).text,
              }
            : t,
        ),
      ),
    );
    es.addEventListener('answer', (e) =>
      patchLast({ answer: JSON.parse((e as MessageEvent).data) }),
    );
    // `options` 이벤트는 **듣지 않는다**(2026-08-06) — 카드를 지우면서 같이 뺐다.
    // 백엔드는 계속 보내고 있으니(진행 타임라인의 `options` 단계와 짝이다) 되살릴 때는
    // 여기 리스너와 `Turn.options`를 함께 되돌리면 된다.
    es.addEventListener('run_error', (e) =>
      patchLast({ error: JSON.parse((e as MessageEvent).data).message }),
    );

    es.addEventListener('done', () => {
      done = true;
      es.close();
      patchLast({ running: false });
    });
    es.onerror = () => {
      es.close();
      if (!done)
        patchLast({
          running: false,
          error: '스트림이 끊겼습니다 (백엔드 확인).',
        });
    };
  }

  /** 답변 문장 한 줄 — 출처 배지와 `담기`가 붙는다.
   *
   *  **함수로 떼어 둔 이유**: 키워드 형식에서는 이 줄이 접힌 채로 서고 이름표를 눌러야
   *  펴진다(아래 `chat-kw`). 감싸는 것이 하나 늘었을 뿐 줄 자체는 그대로여야 해서,
   *  둘을 한자리에 겹쳐 쓰지 않고 갈랐다 — 이름표가 없는 답변(전역 F1·형식이 깨진 줄)이
   *  **예전과 똑같이** 그려지는 것이 이 갈래의 요점이다.
   *  ⚠️ 컴포넌트가 아니라 함수다 — 컴포넌트로 두면 부모가 그려질 때마다 새 타입이 되어
   *     이 줄이 통째로 다시 마운트된다(여기 상태는 없지만, 그 차이를 모르고 상태를
   *     들이면 조용히 초기화된다). */
  const sentenceRow = (s: NoteSentence, on: boolean) => (
    <div
      className={`chat-sent${on ? ' is-picked' : ''}${onPick ? ' has-pick' : ''}`}
    >
      {/* 담기 — **AI가 낸 것 중 무엇을 상담에 가져갈지 고르는 자리**다.
      문장 **왼쪽 거터**에 선다(2026-08-06). 본문과 같은 줄의 형제였을
      때는 문장 길이가 배치를 정해, 긴 문장에서는 첫 줄만 버튼 옆에서
      시작하고 둘째 줄부터 왼쪽 끝으로 돌아왔다 — 조작이 글줄 밖으로
      나가야 본문 시작점이 문장마다 같다.
      ⚠️ 담을 때 **출처를 같이 들고 간다** — 문서에서도 각주가 붙어야
         한다(가드레일 3). 화면 배지와 같은 값을 그대로 넘긴다.
      ⚠️ **출처 배지와 같은 모양으로 만들지 말 것**(2026-08-06). 배지는
         문장이 무엇에 근거하는지 말하는 라벨(읽는 것·상태 없음)이고
         이건 PB가 누르는 조작이다. 갈라 주는 건 넷이다: **자리**(글줄
         밖 거터) · **모난 사각**(배지는 알약) · **아이콘**(＋/✓) ·
         **눌리면 변한다**(배지는 절대 안 변한다).
      ⚠️ 거터에 글자를 넣지 말 것 — 폭은 본문에서 나온다. `담기`라는 말은
         `aria-label`과 tooltip이 나른다(아이콘만으로는 스크린리더에
         아무것도 안 읽힌다). */}
      {onPick && (
        <button
          className={`pickbtn${on ? ' is-picked' : ''}`}
          aria-pressed={on}
          aria-label={
            on
              ? '상담 준비 메모에서 빼기'
              : '상담 준비 메모에 담기'
          }
          title={
            on
              ? '상담 준비 메모에서 뺍니다'
              : '상담 준비 메모에 담습니다'
          }
          onClick={() =>
            onPick({
              kind: 'sentence',
              text: s.text,
              sentence_kind: s.kind,
              sources: s.sources?.length
                ? s.sources
                : s.source
                  ? [s.source]
                  : [],
            })
          }
        >
          <span className="pick-ico" aria-hidden="true">
            {on ? '✓' : '＋'}
          </span>
        </button>
      )}
      {/* 문장과 배지가 **한 덩어리**다 — 배지를 본문 밖 형제로 두면 남는
      자리에 따라 자기 줄로 떨어져 어느 문장 것인지 흐려진다. */}
      <span className="sent-text">
        {s.text}
        {/* 같은 출처를 두 번 인용하면 배지도 두 개였다 — 하나로 묶고
        `×2`로 센다. **다른 출처끼리는 합치지 않는다**(합치면 한쪽
        링크가 사라져 가드레일 3 위반).

        ⚠️ `보유`(holdings)만 **화면에서 뺀다**(2026-08-09). 나머지
           출처와 달리 이 배지는 열어 볼 원문이 없어(`sourceHref`가 null)
           누를 수도 없고, 고객 패널에서는 모든 문장이 같은 값을 달아
           문장마다 같은 말이 반복됐다. 그 사실을 나르는 것은 원래 배지가
           아니라 **아래 F1 고지**다("보유·배분 수치는 내부 계좌데이터로
           공개데이터가 아니며…" · CLAUDE.md 가드레일 1의 F1 예외).
        ⚠️ **데이터에서 지우는 것이 아니라 표시만 뺀다.** `s.sources`는
           그대로라 담기(→ 상담 준비 메모·PDF)에는 각주가 따라간다 —
           거기서 빠지면 가드레일 3 위반이다.
        ⚠️ 공시·뉴스·시세 배지는 **남긴다.** 그쪽은 원문 링크가 달려 있고,
           한 답변에 여러 출처가 섞이면 어느 문장이 무엇에 근거하는지를
           이 배지 말고는 말할 것이 없다. */}
        {mergeSources(
          (s.sources?.length
            ? s.sources
            : s.source
              ? [s.source]
              : []
          ).filter((src) => src.type !== 'holdings'),
        ).map(({ src, count }, k) => (
          <SourceBadge key={k} src={src} count={count} />
        ))}
        {!s.source &&
          !s.sources?.length &&
          (s.kind === 'interpretation' ? (
            <span
              className="sbadge itp"
              title="해석·전망 문장은 각주 대상이 아닙니다"
            >
              해석
            </span>
          ) : (
            <SourceBadge src={null} />
          ))}
      </span>
    </div>
  );

  return (
    <>
      {/* 인라인(고객 카드)에서는 머리말·안내를 내지 않는다 — 부모가 이미 한 줄로 설명했고,
          좁은 칸에서 그 위에 안내문을 더 얹으면 정작 대화가 밀린다.
          ⚠️ 지우는 건 이 안내문뿐이다. 답변마다 붙는 F1 고지(chat-notice)는 백엔드가
          강제하는 것이라 여기와 무관하게 그대로 나온다. */}
      {!compact && (
        <>
          <div className="m-head">
            <h3>채팅 질문</h3>
            {/* 조작 둘을 한 상자에 모은다 — `.m-close` 혼자면 자기 `margin-left: auto`가
                오른쪽으로 밀어 주는데, 형제가 하나 늘면 auto가 둘로 갈려 사이가 벌어진다.
                `새 대화`는 대화가 있을 때만 낸다(빈 화면에서 비울 것이 없다). */}
            <div className="m-acts">
              {turns.length > 0 && (
                <button
                  className="btn"
                  onClick={reset}
                  disabled={running}
                  title="지금까지의 대화를 비웁니다. 다음 질문은 이전 종목을 이어받지 않습니다."
                >
                  ↻ 새 대화
                </button>
              )}
              {onClose && (
                <button className="m-close" aria-label="닫기" onClick={onClose}>
                  ×
                </button>
              )}
            </div>
          </div>
          <div className="chat-hint">
            상담 중 나온 질문을 물어보세요. (예: 삼성전자 최근 실적 → 주가는? →
            관련 뉴스는?)
            <br />
            후속 질문은 이전 종목을 이어받습니다.
          </div>
        </>
      )}

      {/* 질문 전 미리보기 — 대화 로그 **밖**, 입력 위다. 로그 안에 두면 답변이 쌓이면서
          위로 밀려 올라가는데, 이건 특정 턴에 딸린 게 아니라 이 고객에 대해 늘 참인 값이다.
          답변 위 배지와 **글자까지 같은 상자**를 쓴다: 자리가 뜻을 갈라 준다(입력창 위면
          "물어보면 볼 것", 말풍선 안이면 "이 답을 만들 때 본 것"). 미리 본 것과 실제 나간
          것이 다른 모양이면 미리보기가 약속 구실을 못 한다. */}
      {preview && (
        <div className="redact-preview">
          <RedactionDetails r={preview} collapseOn={viewMode} />
        </div>
      )}

      <div className="chat-logwrap">
        <div className="chat-log" ref={scrollRef}>
          {turns.length === 0 && (
            <div className="chat-empty">질문을 입력하면 대화가 시작됩니다.</div>
          )}
          {turns.map((t, i) => (
            <div key={i} className="chat-turn">
              <div className="bubble me">{t.q}</div>

              <div className="bubble ai">
                {/* 라우트 이름표(`상황·보유`·`뉴스` …)는 **그리지 않는다**(2026-08-09).
                  분류 자체는 그대로 돌고 `routing.label`로 실려 오지만(`f1.ROUTE_LABEL`),
                  화면에는 내지 않는다 — 답이 무엇에 근거하는지는 문장마다 붙는 출처와 아래
                  고지가 이미 말하고, 그 위에 라우트 이름이 하나 더 서면 같은 말이 두 번이다.
                  ⚠️ 그래서 이 상자는 **종목이나 이어받음이 있을 때만** 선다. 라우트만 있고
                     둘 다 없는 질문(고객 상황·성향 점검)에서는 아무것도 그리지 않는다 —
                     빈 상자가 뜨던 자리다. */}
                {t.routing &&
                  !t.routing.need_clarify &&
                  (t.routing.entity_name ||
                    t.routing.entity_code ||
                    t.routing.inherited) && (
                    <div className="route-badge" title={t.routing.reason}>
                      <span className="route-entity">
                        {t.routing.entity_name ?? t.routing.entity_code}
                      </span>
                      {t.routing.inherited && (
                        <span
                          className="route-carry"
                          title="이전 질문의 종목을 이어받았습니다"
                        >
                          ↩ 이어받음
                        </span>
                      )}
                    </div>
                  )}

                {/* `AI가 보는 정보` — 이 답을 만들 때 모델이 실제로 받은 것.
                  라우팅 배지 바로 아래인 건 둘이 같은 종류의 정보여서다: "왜 이 답이
                  나왔나"(어떤 데이터를 봤나) 옆에 "그 데이터가 어떤 꼴이었나"가 선다.
                  ⚠️ **미리보기가 있는 화면에서는 내지 않는다**(2026-08-06). 고객 카드는
                     입력창 위에 같은 상자를 이미 세워 두는데, 답변마다 하나가 더 붙으면
                     같은 라벨이 한 화면에 둘이 되어 어느 쪽을 읽어야 하는지가 흐려진다.
                     여기 남는 건 미리보기가 없는 자리뿐이다(고객 문의 모달 — 거기서는
                     물어본 뒤 이 상자로 본다). */}
                {!preview && t.redaction && (
                  <RedactionDetails r={t.redaction} />
                )}

                {t.blocked && (
                  <div className="chat-blocked">
                    {t.blockedStage === 'egress'
                      ? '⛔ 외부 모델로 보내기 전에 차단됐습니다. (에이전트를 실행하지 않았습니다)'
                      : '⛔ 입력이 차단됐습니다. (에이전트를 실행하지 않았습니다)'}
                    <ul>
                      {t.blocked.map((v, j) => (
                        <li key={j}>{v}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* 최종 답변: 문장별 출처 배지 */}
                {t.answer && !t.answer.clarify && (
                  <div className="chat-answer">
                    {t.answer.sentences.map((s, j) => {
                      const on = picked?.has(`sentence:${s.text}`) ?? false;
                      // 키워드 형식(`Next Best Action`) — 키워드가 붙은 문장은 **접힌 채로**
                      // 선다. 상담 직전에 훑는 자리라 키워드를 먼저 보고 필요한 것만 편다.
                      // ⚠️ **상자를 두르지 않는다.** 키워드는 카드가 아니라 글줄이고, 접었다
                      //    폈다 하는 일은 앞의 꺾쇠가 말한다 — 테두리를 두르면 답변 안에
                      //    작은 카드가 여러 장 생겨 무엇이 본문인지가 흐려진다.
                      // ⚠️ 키워드가 없으면 **접지 않는다.** 형식이 깨진 줄이거나 전역 F1의
                      //    답변인데, 접어 두면 화면에서 사라진 것처럼 보인다.
                      // ⚠️ 담긴 문장은 접혀 있어도 그 사실이 보여야 한다(`is-picked`) —
                      //    안 보이면 메모에 뭐가 들었는지 알려고 전부 펴야 한다.
                      const kwKey = `${i}:${j}`;
                      const kws = s.labels ?? [];
                      const shown = !kws.length || openKw.has(kwKey);
                      return (
                        <div className="chat-kw" key={j}>
                          {kws.length > 0 && (
                            <button
                              className={`kw-row${shown ? ' is-open' : ''}${on ? ' is-picked' : ''}`}
                              aria-expanded={shown}
                              onClick={() => toggleKw(kwKey)}
                              title={
                                shown
                                  ? '설명 접기'
                                  : '이 키워드를 설명하는 문장을 폅니다'
                              }
                            >
                              <span className="kw-caret" aria-hidden="true">
                                ▸
                              </span>
                              {/* 키워드 안에 `·`가 들어 있을 수 있어(`배당·이자`) 가운뎃점으로
                                  가르지 않는다 — 구분은 글자가 아니라 CSS 세로줄이 한다. */}
                              {kws.map((kw, k) => (
                                <span className="kw-word" key={k}>
                                  {kw}
                                </span>
                              ))}
                            </button>
                          )}
                          {shown && sentenceRow(s, on)}
                        </div>
                      );
                    })}
                    {t.answer.notice && (
                      <div className="chat-notice">{t.answer.notice}</div>
                    )}
                  </div>
                )}

                {/* 조정 선택지 카드가 여기 있었다(2026-08-06 추가 → 같은 날 제거).
                  `options` SSE로 받은 후보를 `＋ 담기`가 달린 카드로 그렸는데, **답변을 닫는
                  고지문 아래**에 머리말 없이 서서 답변의 일부인지 별개인지가 화면에서
                  갈리지 않았다. 말풍선은 고지문으로 닫히는 것이 맞다.
                  ⚠️ 후보 자체가 사라진 것은 아니다 — `f1.rebalance_options`가 계산해
                     프롬프트로 가고, 답변 산문이 선택지와 근거를 그대로 말한다(CLAUDE.md의
                     "선택지도 코드가 뽑는다"는 그대로다). 없어진 건 **카드로 담는 경로**뿐.
                  ⚠️ 되살린다면 고지문 **위**, 머리말과 함께 둘 것. `PrepItem`의 `option`
                     종류와 PDF의 `선택지:` 항목은 백엔드에 그대로 있다(테스트도 있다). */}

                {/* clarify: 종목 되묻기 */}
                {t.answer?.clarify && (
                  <div className="chat-clarify">{t.answer.text}</div>
                )}

                {/* 스트리밍 중(최종 answer 도착 전).
                  키워드 형식에서는 **원문을 흘리지 않는다** — 최종 화면에서 접힐 문장이
                  통째로 지나가면 읽는 사람이 이미 읽어 버려서, 접어 둔 뜻이 없어진다.
                  도착한 만큼에서 키워드만 뽑아 그리고(`liveKeywords`), 문장은 `answer`가
                  올 때 접힌 채로 처음 선다.
                  ⚠️ 여기 그려지는 건 **진행 표시지 답이 아니다** — 백엔드 검사를 아직 안
                     거쳤고 `answer`가 오면 통째로 갈린다(`liveKeywords` 주석).
                  ⚠️ 형식이 아닌 답(전역 F1)은 예전 그대로 원문을 흘린다. 거기서 키워드만
                     그리면 화면에 아무것도 안 뜬다. */}
                {!t.answer &&
                  !t.blocked &&
                  t.streaming &&
                  (t.kwFormat ? (
                    liveKeywords(t.streaming).map((kws, k) => (
                      <div className="kw-row is-live" key={k}>
                        <span className="kw-caret" aria-hidden="true">
                          ▸
                        </span>
                        {kws.map((kw, n) => (
                          <span className="kw-word" key={n}>
                            {kw}
                          </span>
                        ))}
                      </div>
                    ))
                  ) : (
                    <div className="chat-streaming">
                      {t.streaming}
                      {t.running && <span className="gen-caret">▌</span>}
                    </div>
                  ))}
                {/* 아직 그릴 것이 없을 때. 키워드 형식에서는 **첫 `::`가 오기 전까지**도
                  여기 머문다 — 그 사이 원문을 대신 흘리면 위에서 막은 것이 그대로 샌다. */}
                {!t.answer &&
                  !t.blocked &&
                  t.running &&
                  (!t.streaming ||
                    (t.kwFormat && liveKeywords(t.streaming).length === 0)) && (
                    <div className="chat-thinking">조회 중…</div>
                  )}
                {t.error && <div className="chat-blocked">⛔ {t.error}</div>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 보내기 전 경고 — 입력창 **바로 위**다(누르기 직전에 지나친다). 버튼은 살려 둔다:
          권위는 백엔드에 있고 이건 알림일 뿐이라, 오탐이면 그냥 보낼 수 있어야 한다. */}
      {warning && <div className="out-warn">⚠ {warning}</div>}

      <div className="chat-input">
        <input
          className="search"
          /* 자동완성 끄기 — 제안이 뜨는 것보다, 여기 친 질문이 브라우저 입력 이력에
             남는 쪽이 문제다(가드레일 1: 고객 관련 텍스트가 들어올 수 있는 칸이다). */
          autoComplete="off"
          /* ⚠️ 고객이 붙어 있을 때의 안내에서 `배분`을 뺐다(2026-08-07) — 이 자리에서
             자산배분을 묻지 않기로 했고, 안내가 걷어낸 기능을 계속 권하면 누른 사람이
             없는 버튼을 찾게 된다(`f1.clarify_text`도 같이 고쳤다). */
          placeholder={
            compact
              ? customerId != null
                ? '질문을 입력하세요.'
                : '질문을 입력하세요.'
              : '최근 이 회사 실적 어때?'
          }
          value={input}
          disabled={running}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') send();
          }}
        />
        <button
          className="btn primary"
          onClick={send}
          disabled={running || !input.trim()}
        >
          {running ? '…' : '보내기'}
        </button>
      </div>
    </>
  );
}
