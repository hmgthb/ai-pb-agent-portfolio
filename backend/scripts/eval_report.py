"""간이 eval — F3 노트 파이프라인의 라이브 산출물을 정량 측정한다.

**출처 부착률·게이트 위반은 DB의 notes에서 읽는다** — 대시보드(_citation_stats)와
정확히 같은 데이터라 둘이 갈라질 수 없다. 분류기(kind)를 바꾸면 reparse_notes로 DB를
먼저 맞춘 뒤 이 eval을 돌린다.

**핵심수치 정확도는 SSE에서 읽는다** — DART 원문 raw 수치(card(financials))가 DB 노트에는
저장되지 않기 때문이다. `curl -sN .../api/research/stream?...&stock_code=CODE > eval/CODE.sse`로
저장해 둔 실행 로그의 파일명(종목코드)으로 DB 노트와 짝짓는다. 에이전트를 다시 돌리지
않으므로(=크레딧 0원) 같은 실행을 여러 번 측정할 수 있다.

측정 항목
- **출처 부착률**: 사실 주장(claim) 문장 중 출처 각주가 실제 공시·뉴스와 매칭된 비율.
  해석·전망·고지문구는 분모에서 뺀다(citations.citation_stats — 프로덕션과 동일 정의).
- **핵심수치 정확도**: DART 원문 raw 수치를 a5가 노트에 옮길 때 값이 보존됐는가. a5가
  종목마다 단위 관습을 바꾸므로(조/억·백만원·원) 표기 후보를 모두 만들어 본문에서 찾는다.
- **게이트 위반 수**, **본문 길이**.

실행: DATABASE_URL=... backend/.venv/bin/python -m backend.scripts.eval_report <sse_dir>
"""

import asyncio
import json
import sys
from pathlib import Path

from backend import citations, db


def _parse_sse(text: str) -> list[tuple[str, dict]]:
    """event/data 쌍만 뽑는다. data가 JSON이 아니면(있을 리 없지만) 건너뛴다."""
    events: list[tuple[str, dict]] = []
    ev = None
    for line in text.splitlines():
        if line.startswith("event:"):
            ev = line[len("event:") :].strip()
        elif line.startswith("data:") and ev is not None:
            try:
                events.append((ev, json.loads(line[len("data:") :].strip())))
            except json.JSONDecodeError:
                pass
            ev = None
    return events


def _fmt_figure(raw: str) -> list[str]:
    """DART raw 원 단위를 a5가 실제로 쓰는 표기 후보 전부로 바꾼다.

    ⚠️ a5는 종목마다 단위 관습을 바꾼다(라이브 실측): 대부분 조/억("10조 7,377억")을
    쓰지만 기아 노트는 백만원("107,448,752백만원")으로 썼다. 후보를 조/억만 두면
    백만원 표기 노트를 "수치 누락"으로 오판한다 — 실제로 났던 false negative다.
    그래서 조/억·백만원·원(full) 표기를 모두 후보에 넣는다.

    비교는 공백·콤마를 지운 형태로 한다(호출부에서 노트도 같은 정규화를 거친다) —
    a5가 "10조 7,377억"처럼 공백을 넣기도, "10조7,377억"처럼 빼기도 하기 때문."""
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return []
    n = abs(n)
    out: list[str] = []
    if n >= 1_0000_0000_0000:  # 1조 이상 — 억까지 쪼갠 표기 + 반올림 조
        jo, rem = divmod(n, 1_0000_0000_0000)
        eok = rem // 1_0000_0000
        if eok:
            out.append(f"{jo}조{eok:,}억")
        out.append(f"{jo}조")
    elif n >= 1_0000_0000:  # 1억 이상
        out.append(f"{n // 1_0000_0000:,}억")
    if n >= 1_000_000:  # 백만원 표기 (기아 노트가 쓴 관습)
        out.append(f"{n // 1_000_000:,}백만원")
    out.append(f"{n:,}원")  # 원 단위 full 표기
    return out


def _norm(s: str) -> str:
    return s.replace(" ", "").replace(",", "").replace(" ", "")


def _figure_accuracy(financials: dict, note_text: str) -> tuple[int, int, list[str]]:
    """(맞은 수치, 검사한 수치, 누락 상세). 검사 대상은 당기 값(현재 사업연도)이다."""
    note_n = _norm(note_text)
    hit = total = 0
    misses: list[str] = []
    for item, vals in (financials.get("figures") or {}).items():
        raw = vals.get("당기")
        cands = _fmt_figure(raw)
        if not cands:
            continue  # 조·억 미만은 표기 다양성이 커서 자동 검사에서 제외(간이)
        total += 1
        # 후보 중 하나라도 본문에 있으면 값이 보존된 것으로 본다(공백·콤마 무시)
        if any(_norm(c) in note_n for c in cands):
            hit += 1
        else:
            misses.append(f"{item} 당기={raw} (기대표기 예: {cands[0]})")
    return hit, total, misses


def _financials_from_sse(path: Path) -> dict | None:
    """SSE 로그에서 card(financials)를 꺼낸다 — DART 원문 raw 수치(정확도 검사용).

    ⚠️ **마지막** financials 카드를 쓴다. a2가 연도를 바꿔가며 dart_parse를 여러 번
    호출하면(예: LG화학은 2025 잠정 → 2024 확정 순) 카드가 여러 개 흐르고, 백엔드는
    `financials = parsed`로 **마지막 것**을 a5에게 넘긴다(main.py). 첫 카드로 검사하면
    a5가 실제로 받지 않은 연도의 수치와 대조해 오탐이 난다 — 실측으로 LG화학이 0%로
    잘못 찍혔다."""
    latest = None
    for ev, data in _parse_sse(path.read_text()):
        if ev == "card" and data.get("type") == "financials":
            latest = data
    return latest


def measure_note(note_row, sse_dir: Path) -> dict:
    """DB 노트 1건을 측정한다. 재무 수치 정확도만 SSE에서 짝지어 본다."""
    sentences = json.loads(note_row["sentences_json"])
    violations = json.loads(note_row["violations_json"])
    sourced, claims, interp = citations.citation_stats(sentences)
    note_text = " ".join(s["text"] for s in sentences if not s.get("is_heading"))

    result = {
        "corp_name": note_row["corp_name"],
        "stock_code": note_row["stock_code"],
        "citation_sourced": sourced,
        "citation_claims": claims,
        "citation_interp": interp,
        "citation_rate": round(sourced / claims * 100, 1) if claims else None,
        "violations": violations,
        "body_chars": len(note_text),
        "figure_rate": None,
        "figure_hit": 0,
        "figure_total": 0,
        "figure_misses": [],
    }

    sse = sse_dir / f"{note_row['stock_code']}.sse"
    fin = _financials_from_sse(sse) if sse.exists() else None
    if fin:
        hit, ftotal, misses = _figure_accuracy(fin, note_text)
        result.update(
            figure_hit=hit, figure_total=ftotal,
            figure_rate=round(hit / ftotal * 100, 1) if ftotal else None,
            figure_misses=misses,
        )
    return result


async def _load_notes():
    await db.init_pool()
    try:
        return await db.pool().fetch(
            "SELECT stock_code, corp_name, sentences_json, violations_json FROM notes ORDER BY id"
        )
    finally:
        await db.close_pool()


def main(sse_dir: str) -> int:
    sdir = Path(sse_dir)
    note_rows = asyncio.run(_load_notes())
    if not note_rows:
        print("DB에 노트가 없습니다.")
        return 1

    rows = [measure_note(n, sdir) for n in note_rows]

    print(f"\n{'법인':<12}{'부착률':>8}{'(부착/분모)':>12}{'해석':>5}{'수치정확':>9}{'위반':>5}{'본문자':>7}")
    print("-" * 60)
    agg_s = agg_c = agg_fh = agg_ft = 0
    for r in rows:
        agg_s += r["citation_sourced"]; agg_c += r["citation_claims"]
        agg_fh += r["figure_hit"]; agg_ft += r["figure_total"]
        cr = f"{r['citation_rate']}%" if r["citation_rate"] is not None else "—"
        fr = f"{r['figure_rate']}%" if r["figure_rate"] is not None else "—"
        frac = f"({r['citation_sourced']}/{r['citation_claims']})"
        print(
            f"{r['corp_name']:<12}{cr:>8}{frac:>12}{r['citation_interp']:>5}"
            f"{fr:>9}{len(r['violations']):>5}{r['body_chars']:>7}"
        )

    print("-" * 60)
    cr = f"{agg_s / agg_c * 100:.1f}%" if agg_c else "—"
    fr = f"{agg_fh / agg_ft * 100:.1f}%" if agg_ft else "—"
    print(f"{'합계':<12}{cr:>8}{f'({agg_s}/{agg_c})':>12}{'':>5}{fr:>9}   노트 {len(rows)}건")

    # 상세: 수치 누락·게이트 위반은 감추지 않고 전부 나열
    for r in rows:
        if r.get("figure_misses"):
            print(f"\n[{r['corp_name']}] 수치 누락:")
            for m in r["figure_misses"]:
                print(f"  - {m}")
        if r.get("violations"):
            print(f"\n[{r['corp_name']}] 게이트 위반 {len(r['violations'])}건:")
            for v in r["violations"]:
                print(f"  - {v}")

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "eval"))
