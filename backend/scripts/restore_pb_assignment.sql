-- pb_customers.pb 원래 배정 복원 (2026-07-23 이전 상태)
--
-- 왜 이 파일이 있나: 이 제품은 PB 1인용이라 고객 50명을 전부 한 사람에게 몰았다
-- (UPDATE pb_customers SET pb = 'PB'). 그런데 pb_customers는 **시드 소스가 유실돼
-- .pyc만 남아 있어**(HANDOFF §2) 원래 3인 배정을 다시 만들 방법이 없다.
-- 되돌리려면 이 파일을 실행한다:
--   docker exec -i ai-pb-agent-postgres-1 psql -U app -d app < backend/scripts/restore_pb_assignment.sql

UPDATE pb_customers SET pb = '박PB' WHERE id = 1;
UPDATE pb_customers SET pb = '이PB' WHERE id = 2;
UPDATE pb_customers SET pb = '최PB' WHERE id = 3;
UPDATE pb_customers SET pb = '박PB' WHERE id = 4;
UPDATE pb_customers SET pb = '이PB' WHERE id = 5;
UPDATE pb_customers SET pb = '최PB' WHERE id = 6;
UPDATE pb_customers SET pb = '박PB' WHERE id = 7;
UPDATE pb_customers SET pb = '이PB' WHERE id = 8;
UPDATE pb_customers SET pb = '최PB' WHERE id = 9;
UPDATE pb_customers SET pb = '박PB' WHERE id = 10;
UPDATE pb_customers SET pb = '이PB' WHERE id = 11;
UPDATE pb_customers SET pb = '최PB' WHERE id = 12;
UPDATE pb_customers SET pb = '박PB' WHERE id = 13;
UPDATE pb_customers SET pb = '이PB' WHERE id = 14;
UPDATE pb_customers SET pb = '최PB' WHERE id = 15;
UPDATE pb_customers SET pb = '박PB' WHERE id = 16;
UPDATE pb_customers SET pb = '이PB' WHERE id = 17;
UPDATE pb_customers SET pb = '최PB' WHERE id = 18;
UPDATE pb_customers SET pb = '박PB' WHERE id = 19;
UPDATE pb_customers SET pb = '이PB' WHERE id = 20;
UPDATE pb_customers SET pb = '최PB' WHERE id = 21;
UPDATE pb_customers SET pb = '박PB' WHERE id = 22;
UPDATE pb_customers SET pb = '이PB' WHERE id = 23;
UPDATE pb_customers SET pb = '최PB' WHERE id = 24;
UPDATE pb_customers SET pb = '박PB' WHERE id = 25;
UPDATE pb_customers SET pb = '이PB' WHERE id = 26;
UPDATE pb_customers SET pb = '최PB' WHERE id = 27;
UPDATE pb_customers SET pb = '박PB' WHERE id = 28;
UPDATE pb_customers SET pb = '이PB' WHERE id = 29;
UPDATE pb_customers SET pb = '최PB' WHERE id = 30;
UPDATE pb_customers SET pb = '박PB' WHERE id = 31;
UPDATE pb_customers SET pb = '이PB' WHERE id = 32;
UPDATE pb_customers SET pb = '최PB' WHERE id = 33;
UPDATE pb_customers SET pb = '박PB' WHERE id = 34;
UPDATE pb_customers SET pb = '이PB' WHERE id = 35;
UPDATE pb_customers SET pb = '최PB' WHERE id = 36;
UPDATE pb_customers SET pb = '박PB' WHERE id = 37;
UPDATE pb_customers SET pb = '이PB' WHERE id = 38;
UPDATE pb_customers SET pb = '최PB' WHERE id = 39;
UPDATE pb_customers SET pb = '박PB' WHERE id = 40;
UPDATE pb_customers SET pb = '이PB' WHERE id = 41;
UPDATE pb_customers SET pb = '최PB' WHERE id = 42;
UPDATE pb_customers SET pb = '박PB' WHERE id = 43;
UPDATE pb_customers SET pb = '이PB' WHERE id = 44;
UPDATE pb_customers SET pb = '최PB' WHERE id = 45;
UPDATE pb_customers SET pb = '박PB' WHERE id = 46;
UPDATE pb_customers SET pb = '이PB' WHERE id = 47;
UPDATE pb_customers SET pb = '최PB' WHERE id = 48;
UPDATE pb_customers SET pb = '박PB' WHERE id = 49;
UPDATE pb_customers SET pb = '이PB' WHERE id = 50;
