-- audit_log.actor 원래 값 복원 (2026-07-27 정규화 이전 상태)
--
-- 왜 이 파일이 있나: 이 제품은 PB 1인·준법 1인용인데, 여럿이 공유하는 줄 알고 만들던 시절의
-- 사람 이름(박PB·정준법)과 지난 체제의 라벨(관리자·김애널)이 감사로그에 남아 있었다.
-- 실제로 다른 사람이 아니라 같은 한 명에게 붙였던 이름표라, 화면·DB 모두 역할명(PB·준법)으로
-- 정규화했다:  정준법→준법,  박PB·관리자·김애널→PB (관리자·김애널 기록이 마침 검토·심의뿐이라
-- §0-1대로 전부 PB로 딱 떨어진다).
--
-- 역매핑은 유일하지 않으므로(PB가 박PB였는지 관리자였는지 알 수 없다) id별 원본을 그대로 스냅샷했다.
-- 되돌리려면 이 파일을 실행한다:
--   docker exec -i ai-pb-agent-postgres-1 psql -U app -d app < backend/scripts/restore_audit_actors.sql

UPDATE audit_log SET actor = '김애널' WHERE id = 3;
UPDATE audit_log SET actor = '김애널' WHERE id = 5;
UPDATE audit_log SET actor = '정준법' WHERE id = 6;
UPDATE audit_log SET actor = '정준법' WHERE id = 7;
UPDATE audit_log SET actor = '박PB' WHERE id = 10;
UPDATE audit_log SET actor = '정준법' WHERE id = 11;
UPDATE audit_log SET actor = '관리자' WHERE id = 12;
UPDATE audit_log SET actor = '정준법' WHERE id = 13;
UPDATE audit_log SET actor = '정준법' WHERE id = 16;
UPDATE audit_log SET actor = '관리자' WHERE id = 556;
UPDATE audit_log SET actor = '관리자' WHERE id = 557;
UPDATE audit_log SET actor = '정준법' WHERE id = 558;
UPDATE audit_log SET actor = '정준법' WHERE id = 559;
UPDATE audit_log SET actor = '정준법' WHERE id = 560;
UPDATE audit_log SET actor = '정준법' WHERE id = 561;
UPDATE audit_log SET actor = '정준법' WHERE id = 562;
UPDATE audit_log SET actor = '정준법' WHERE id = 563;
UPDATE audit_log SET actor = '관리자' WHERE id = 564;
UPDATE audit_log SET actor = '관리자' WHERE id = 565;
UPDATE audit_log SET actor = '정준법' WHERE id = 566;
UPDATE audit_log SET actor = '정준법' WHERE id = 567;
UPDATE audit_log SET actor = '정준법' WHERE id = 568;
UPDATE audit_log SET actor = '정준법' WHERE id = 569;
UPDATE audit_log SET actor = '박PB' WHERE id = 588;
UPDATE audit_log SET actor = '박PB' WHERE id = 589;
UPDATE audit_log SET actor = '박PB' WHERE id = 590;
UPDATE audit_log SET actor = '정준법' WHERE id = 591;
UPDATE audit_log SET actor = '정준법' WHERE id = 592;

-- notes 테이블도 같은 이유로 정규화했다: 검토자·심의자·발행자·생성자 컬럼과
-- 확인 기록(acks_json 안의 actor)에 남아 있던 사람 이름을 역할명으로 바꿨다.
-- 되돌릴 때 acks_json은 원본 JSON을 통째로 되돌린다.
UPDATE notes SET reviewer='관리자', deliberator='관리자', publisher=NULL, created_by=NULL, acks_json='[]'::jsonb WHERE id=7;
UPDATE notes SET reviewer='관리자', deliberator='관리자', publisher='정준법', created_by=NULL, acks_json='[{"ts": "2026-07-23T00:58:01.924859+00:00", "text": "매출액 등 다른 손익 항목은 이번 입력 자료에 포함되지 않아 수익성 악화의 세부 원인을 이 노트만으로 단정하", "actor": "정준법", "index": 4, "reason": "해석·전망"}, {"ts": "2026-07-23T00:58:01.947747+00:00", "text": "영업이익이 전년 대비 크게 줄어든 흐름과, 석유화학 부문의 불황을 배경으로 한 나주공장 라인 축소 보도는 방", "actor": "정준법", "index": 9, "reason": "해석·전망"}, {"ts": "2026-07-23T00:58:01.969448+00:00", "text": "다만 나주공장 재편이 연결 실적 수치에 미친 정량적 영향은 제공된 자료로 확인되지 않으므로, 둘의 인과관계를", "actor": "정준법", "index": 10, "reason": "해석·전망"}, {"ts": "2026-07-23T00:58:01.990181+00:00", "text": "이번 노트는 2024년 영업이익 한 개 지표와 나주공장 관련 뉴스에 한정된 자료를 바탕으로 하므로, 매출·부", "actor": "정준법", "index": 14, "reason": "해석·전망"}]'::jsonb WHERE id=10;
UPDATE notes SET reviewer='박PB', deliberator='박PB', publisher=NULL, created_by='박PB', acks_json='[]'::jsonb WHERE id=13;
