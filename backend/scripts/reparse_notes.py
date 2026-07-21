"""저장된 노트의 sentences_json을 현재 citations 분류기로 다시 계산한다 (크레딧 0원).

에이전트를 다시 돌리지 않고, **이미 저장된 sentences_json에서 출처 맵을 복원**해
content_md를 재파싱한다 — 분류기(kind)·boilerplate 규칙을 바꿨을 때 기존 노트를
새 기준으로 맞추기 위한 것이다(§1-3 후속). 재파싱은 멱등이라 이미 최신인 노트에
돌려도 결과가 같다.

⚠️ 출처 맵은 기존 문장이 실제로 인용에 성공한 태그만 담는다 — content_md의 태그 중
맵에 없는 것(원래 미인용/조작 의심)은 재파싱 후에도 미인용으로 남는다. 없는 출처를
새로 만들어 채우지 않는다(가드레일 3).

실행: DATABASE_URL=... backend/.venv/bin/python -m backend.scripts.reparse_notes [코드...]
      코드를 안 주면 모든 노트를 대상으로 한다.
"""

import asyncio
import json
import sys

from backend import citations, compliance, db


def _rebuild_source_maps(sentences: list[dict]) -> tuple[dict, dict]:
    """기존 문장들에 붙어 있던 출처 객체에서 dart/news 맵을 복원한다."""
    dart: dict[str, dict] = {}
    news: dict[str, dict] = {}
    for s in sentences:
        for src in s.get("sources") or ([s["source"]] if s.get("source") else []):
            if not src:
                continue
            if src.get("type") == "dart":
                dart[src["rcept_no"]] = {
                    "viewer_url": src.get("viewer_url"),
                    "rcept_dt": src.get("rcept_dt"),
                }
            elif src.get("type") == "news":
                news[src["url"]] = {
                    "title": src.get("title"),
                    "pub_date": src.get("pub_date"),
                }
    return dart, news


async def _update(note_id: int, sentences: list[dict], violations: list[str]) -> None:
    await db.pool().execute(
        "UPDATE notes SET sentences_json = $2::jsonb, violations_json = $3::jsonb, "
        "updated_at = now() WHERE id = $1",
        note_id,
        json.dumps(sentences, ensure_ascii=False),
        json.dumps(violations, ensure_ascii=False),
    )


async def main(codes: list[str]) -> None:
    await db.init_pool()
    try:
        rows = await db.pool().fetch(
            "SELECT id, stock_code, corp_name, content_md, sentences_json FROM notes ORDER BY id"
        )
        for r in rows:
            if codes and r["stock_code"] not in codes:
                continue
            old = json.loads(r["sentences_json"])
            dart, news = _rebuild_source_maps(old)
            new = citations.parse_sentences(r["content_md"], dart, news)
            violations = compliance.check_note(r["content_md"], new, "F3")

            os, ns = citations.citation_stats(old), citations.citation_stats(new)
            await _update(r["id"], new, violations)
            print(
                f"#{r['id']} {r['corp_name']:<8} "
                f"부착 {os[0]}/{os[1]} → {ns[0]}/{ns[1]}  "
                f"해석 {os[2]}→{ns[2]}  미인용(게이트) {citations.unsourced_count(old)}→{citations.unsourced_count(new)}"
            )
    finally:
        await db.close_pool()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
