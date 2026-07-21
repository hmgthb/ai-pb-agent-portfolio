"""F2 모닝 브리프 조립.

에이전트(a1 공시·a4 뉴스)가 **도구로 실제 조회한 결과**와 krx 시세를 받아 카드형 브리프로
조립한다. LLM에게 산문을 쓰게 하지 않는 것이 핵심이다 — 브리프의 모든 줄은 조회 결과에서
그대로 나오므로 출처가 구조적으로 보장되고, F3 노트처럼 각주가 깨질 여지가 없다.

여기(조립)는 LLM이 개입하지 않는 순수 함수라 크레딧 없이 검증된다.
에이전트 위임은 backend/main.py의 파이프라인이 담당한다.
"""

from backend import compliance

FEATURE = "F2"


# 모닝 브리프는 "밤사이 뭐가 중요했나"를 훑는 화면이라 공시 종류마다 무게가 다르다.
# 대형주는 임원·주요주주 지분 보고가 매일 수십 건 올라와서(삼성전자 5일 = 81건) 그대로
# 실으면 중요 공시가 묻힌다. 그렇다고 빼버리면 조용한 날 브리프가 비어버리므로, 빼지 않고
# 뒤로 민다.
#
# DART list.json 응답에는 공시유형(pblntf_ty) 필드가 없고 보고서명만 오기 때문에
# 이름으로 분류한다. # ponytail: 유형별로 dart_search를 여러 번 부르면 정확하지만 종목당
# API 호출이 배로 든다 — 이름 매칭으로 충분하고, 못 알아본 건 중간 순위로 떨어질 뿐이다.
_MATERIAL_KEYWORDS = (
    "주요사항보고", "영업(잠정)", "실적", "매출액또는손익구조", "유상증자", "무상증자",
    "합병", "분할", "자기주식", "전환사채", "신주인수권", "감자", "소송", "회생", "상장폐지",
)
_PERIODIC_KEYWORDS = ("사업보고서", "반기보고서", "분기보고서")
_OWNERSHIP_KEYWORDS = ("소유상황보고", "대량보유상황보고")


def _disclosure_rank(report_nm: str) -> int:
    """작을수록 먼저 보여준다. 0=주요사항, 1=정기공시, 2=그 외, 3=지분공시."""
    name = report_nm.strip()
    if any(k in name for k in _MATERIAL_KEYWORDS):
        return 0
    if any(k in name for k in _PERIODIC_KEYWORDS):
        return 1
    if any(k in name for k in _OWNERSHIP_KEYWORDS):
        return 3
    return 2


def viewer_url(rcept_no: str) -> str:
    """공시 뷰어 링크는 접수번호에서 결정론적으로 만들어진다(dart_server와 같은 형식).
    공시 한 건마다 dart_fetch를 또 부르지 않으려고 여기서 조립한다."""
    return f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={rcept_no}"


def pick_disclosures(rows: list[dict], limit: int) -> list[dict]:
    """중요도 우선, 같은 중요도면 최신순으로 상위 N건.

    dart_search 결과에는 링크가 없으므로 여기서 붙여준다 — 화면(카드)과 게이트(문장 출처)가
    같은 링크를 쓰도록, 공식은 이 한 곳에만 둔다.
    """
    picked = sorted(
        rows, key=lambda r: (_disclosure_rank(r.get("report_nm", "")), _neg_date(r)),
    )[:limit]
    return [{**r, "viewer_url": r.get("viewer_url") or viewer_url(r["rcept_no"])} for r in picked]


def _neg_date(row: dict) -> str:
    """접수일 내림차순 정렬용 키 — 문자열 날짜라 자릿수를 뒤집어 역순을 만든다."""
    return "".join(str(9 - int(c)) if c.isdigit() else c for c in (row.get("rcept_dt") or ""))


def _quote_line(q: dict) -> tuple[str, dict]:
    """시세 줄. '지연시세'를 문구에 넣어 게이트의 지연시세 체크를 만족시킨다 —
    체크를 우회하는 게 아니라, 실제로 지연 데이터라서 그렇게 표기하는 것이다."""
    pct = q["change_pct"]
    arrow = "▲" if not str(pct).startswith("-") else "▼"
    text = (
        f"{q['corp_name']}({q['stock_code']}) 종가 {int(q['close']):,}원 "
        f"{arrow}{pct}% — {q['as_of']} 기준 지연시세(실시간 아님)."
    )
    return text, {"type": "krx", "as_of": q["as_of"], "label": q["source"]}


def _disclosure_line(d: dict) -> tuple[str, dict]:
    rcept_no = d["rcept_no"]
    # 같은 보고서명이 제출인만 달리해 여러 건 올라오는 경우가 흔하다(임원·주요주주 보고 등).
    # 제출인을 함께 적지 않으면 같은 줄이 반복되는 것처럼 보인다.
    filer = (d.get("flr_nm") or "").strip()
    who = f" · 제출 {filer}" if filer else ""
    text = f"공시: {d['report_nm'].strip()}{who} ({d['rcept_dt']} 접수)."
    return text, {
        "type": "dart",
        "rcept_no": rcept_no,
        "rcept_dt": d["rcept_dt"],
        "viewer_url": d.get("viewer_url") or viewer_url(rcept_no),
    }


def _news_line(n: dict) -> tuple[str, dict]:
    text = f"뉴스: {n['title']}"
    return text, {"type": "news", "url": n["link"], "pub_date": n["pub_date"]}


def assemble(items: list[dict]) -> tuple[str, list[dict]]:
    """종목별 조회 결과 → (마크다운 본문, 문장+출처 목록).

    items: [{stock_code, corp_name, quote, disclosures, news}, ...]
    반환한 sentences는 그대로 compliance.check_note에 넘겨 게이트를 태운다.
    """
    lines: list[str] = []
    sentences: list[dict] = []

    def add(text: str, source: dict | None, *, heading: bool = False) -> None:
        lines.append(f"## {text}" if heading else f"- {text}")
        sentences.append({"text": text, "source": source, "is_heading": heading})

    for item in items:
        add(f"{item['corp_name']}({item['stock_code']})", None, heading=True)
        if item.get("quote"):
            add(*_quote_line(item["quote"]))
        for d in item.get("disclosures") or []:
            add(*_disclosure_line(d))
        for n in item.get("news") or []:
            add(*_news_line(n))
        # 조회 결과가 하나도 없으면 빈 채로 두지 않고 그 사실을 적는다 — 빈 카드는
        # "조회 실패"인지 "해당 없음"인지 화면에서 구분되지 않는다.
        if not any((item.get("quote"), item.get("disclosures"), item.get("news"))):
            add("전일 공시·밤사이 뉴스·시세 모두 조회된 항목이 없습니다.", None)

    content_md = compliance.apply_notice("\n".join(lines), FEATURE)
    return content_md, sentences


def check(content_md: str, sentences: list[dict]) -> list[str]:
    """F2 게이트. 필수 고지문구가 F3 워터마크가 아니라 '내부 참고용'인지도 여기서 걸러진다."""
    return compliance.check_note(content_md, sentences, FEATURE)
