-- 복원용 데이터 덤프 (2026-07-28) — pb_sessions
--
-- ⚠️ 여기 담긴 고객 문의는 **전부 가상의 합성 데이터**다(고객 원본은 restore_pb_customers.sql).
--    실존 인물의 문의도, 실제 상담 기록도 아니다.
--
-- 이 테이블들은 **시드 소스가 유실돼 이 파일이 유일한 원본**이다.
-- 앱에는 pb_sessions를 만드는 코드가 아예 없다 — 지우면 이 파일 없이는 못 되살린다.
--
-- 복원:  docker exec -i ai-pb-agent-postgres-1 psql -U app -d app -c "TRUNCATE pb_sessions;" \
--        && docker exec -i ai-pb-agent-postgres-1 psql -U app -d app < backend/scripts/restore_pb_sessions.sql
-- (INSERT만 들어 있어 비우지 않고 다시 넣으면 PK 충돌이 난다.)

--
-- PostgreSQL database dump
--

\restrict Z7I5O5akPP6nXyGWTU2hzthlyxwX3ygYC1RWWfcOeza2rDogcNxUVLu0jtCR3Nc

-- Dumped from database version 16.14 (Debian 16.14-1.pgdg12+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: pb_sessions; Type: TABLE DATA; Schema: public; Owner: app
--

INSERT INTO public.pb_sessions VALUES (1, 1, 'active', '포트폴리오 리밸런싱 문의', NULL, '2026-07-20 00:25:38.147115+00', '2026-07-20 00:35:38.166222+00');
INSERT INTO public.pb_sessions VALUES (2, 2, 'active', '삼성전자 실적 관련 문의', NULL, '2026-07-20 00:18:38.147115+00', '2026-07-20 00:35:38.166879+00');
INSERT INTO public.pb_sessions VALUES (3, 3, 'active', '퇴직연금 운용 상담', NULL, '2026-07-20 00:11:38.147115+00', '2026-07-20 00:35:38.167167+00');
INSERT INTO public.pb_sessions VALUES (4, 4, 'active', '반도체 업황 문의', NULL, '2026-07-20 00:04:38.147115+00', '2026-07-20 00:35:38.167505+00');
INSERT INTO public.pb_sessions VALUES (5, 5, 'active', '채권 비중 확대 상담', NULL, '2026-07-19 23:57:38.147115+00', '2026-07-20 00:35:38.16779+00');
INSERT INTO public.pb_sessions VALUES (6, 6, 'active', 'ISA 계좌 활용 문의', NULL, '2026-07-19 23:50:38.147115+00', '2026-07-20 00:35:38.168008+00');
INSERT INTO public.pb_sessions VALUES (7, 7, 'active', '포트폴리오 리밸런싱 문의', NULL, '2026-07-19 23:43:38.147115+00', '2026-07-20 00:35:38.168336+00');
INSERT INTO public.pb_sessions VALUES (8, 8, 'active', '삼성전자 실적 관련 문의', NULL, '2026-07-19 23:36:38.147115+00', '2026-07-20 00:35:38.168634+00');
INSERT INTO public.pb_sessions VALUES (9, 9, 'active', '퇴직연금 운용 상담', NULL, '2026-07-19 23:29:38.147115+00', '2026-07-20 00:35:38.168921+00');
INSERT INTO public.pb_sessions VALUES (10, 10, 'active', '반도체 업황 문의', NULL, '2026-07-19 23:22:38.147115+00', '2026-07-20 00:35:38.169164+00');
INSERT INTO public.pb_sessions VALUES (11, 11, 'active', '채권 비중 확대 상담', NULL, '2026-07-19 23:15:38.147115+00', '2026-07-20 00:35:38.169412+00');
INSERT INTO public.pb_sessions VALUES (12, 12, 'active', 'ISA 계좌 활용 문의', NULL, '2026-07-19 23:08:38.147115+00', '2026-07-20 00:35:38.169698+00');
INSERT INTO public.pb_sessions VALUES (14, 12, 'pending', '삼성전자 실적 관련 문의', '삼성전자 이번 실적이 좋았다던데, 지금이라도 더 담아도 될까요?', '2026-07-19 22:35:38.147115+00', '2026-07-20 00:35:38.170378+00');
INSERT INTO public.pb_sessions VALUES (15, 28, 'pending', '채권 비중 확대 상담', '금리가 내려간다는데 채권 비중을 늘리는 게 맞을까요?', '2026-07-19 21:35:38.147115+00', '2026-07-20 00:35:38.170624+00');
INSERT INTO public.pb_sessions VALUES (16, 43, 'pending', '퇴직연금 운용 상담', '퇴직연금 계좌를 좀 더 적극적으로 운용하고 싶은데 방법이 있을까요?', '2026-07-19 19:35:38.147115+00', '2026-07-20 00:35:38.170834+00');
INSERT INTO public.pb_sessions VALUES (17, 13, 'done', '포트폴리오 리밸런싱 문의', NULL, '2026-07-19 00:35:38.147115+00', '2026-07-20 00:35:38.171164+00');
INSERT INTO public.pb_sessions VALUES (18, 14, 'done', '삼성전자 실적 관련 문의', NULL, '2026-07-18 21:35:38.147115+00', '2026-07-20 00:35:38.171544+00');
INSERT INTO public.pb_sessions VALUES (19, 15, 'done', '퇴직연금 운용 상담', NULL, '2026-07-18 18:35:38.147115+00', '2026-07-20 00:35:38.171824+00');
INSERT INTO public.pb_sessions VALUES (20, 16, 'done', '반도체 업황 문의', NULL, '2026-07-18 15:35:38.147115+00', '2026-07-20 00:35:38.172108+00');
INSERT INTO public.pb_sessions VALUES (21, 17, 'done', '채권 비중 확대 상담', NULL, '2026-07-18 12:35:38.147115+00', '2026-07-20 00:35:38.172338+00');
INSERT INTO public.pb_sessions VALUES (22, 18, 'done', 'ISA 계좌 활용 문의', NULL, '2026-07-18 09:35:38.147115+00', '2026-07-20 00:35:38.172658+00');
INSERT INTO public.pb_sessions VALUES (23, 19, 'done', '포트폴리오 리밸런싱 문의', NULL, '2026-07-18 06:35:38.147115+00', '2026-07-20 00:35:38.172919+00');
INSERT INTO public.pb_sessions VALUES (24, 20, 'done', '삼성전자 실적 관련 문의', NULL, '2026-07-18 03:35:38.147115+00', '2026-07-20 00:35:38.173232+00');
INSERT INTO public.pb_sessions VALUES (25, 21, 'done', '퇴직연금 운용 상담', NULL, '2026-07-18 00:35:38.147115+00', '2026-07-20 00:35:38.173527+00');
INSERT INTO public.pb_sessions VALUES (26, 22, 'done', '반도체 업황 문의', NULL, '2026-07-17 21:35:38.147115+00', '2026-07-20 00:35:38.17388+00');
INSERT INTO public.pb_sessions VALUES (27, 23, 'done', '채권 비중 확대 상담', NULL, '2026-07-17 18:35:38.147115+00', '2026-07-20 00:35:38.174207+00');
INSERT INTO public.pb_sessions VALUES (28, 24, 'done', 'ISA 계좌 활용 문의', NULL, '2026-07-17 15:35:38.147115+00', '2026-07-20 00:35:38.174572+00');
INSERT INTO public.pb_sessions VALUES (29, 25, 'done', '포트폴리오 리밸런싱 문의', NULL, '2026-07-17 12:35:38.147115+00', '2026-07-20 00:35:38.17511+00');
INSERT INTO public.pb_sessions VALUES (30, 26, 'done', '삼성전자 실적 관련 문의', NULL, '2026-07-17 09:35:38.147115+00', '2026-07-20 00:35:38.175359+00');
INSERT INTO public.pb_sessions VALUES (13, 4, 'rejected', '포트폴리오 리밸런싱 문의', '요즘 시장이 불안한데, 제 포트폴리오에서 주식 비중을 줄이는 게 좋을까요?', '2026-07-20 00:17:38.147115+00', '2026-07-28 07:54:57.098289+00');


--
-- Name: pb_sessions_id_seq; Type: SEQUENCE SET; Schema: public; Owner: app
--

SELECT pg_catalog.setval('public.pb_sessions_id_seq', 30, true);


--
-- PostgreSQL database dump complete
--

\unrestrict Z7I5O5akPP6nXyGWTU2hzthlyxwX3ygYC1RWWfcOeza2rDogcNxUVLu0jtCR3Nc

