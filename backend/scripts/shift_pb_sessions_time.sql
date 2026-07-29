-- 시각 보정 (2026-07-29) — pb_sessions
--
-- restore_pb_sessions.sql은 2026-07-17~07-20에 만들어진 시드를 그대로 담고 있다.
-- 복원 직후에는 큐(`started_at DESC`)가 며칠 지난 문의로 서기 때문에, 복원 뒤 이걸 돌려
-- 가장 최근 문의가 "지금"이 되도록 전체를 **통째로 민다**. 절대시각을 박지 않는 이유는
-- 문의 사이의 간격(며칠에 걸쳐 들어온 모양)이 데모에서 의미를 갖기 때문이다.
--
-- ⚠️ updated_at에 least(..., now())를 씌운다 — id=13은 앞선 세션에서 실제로 처리해
--    updated_at(07-28)이 started_at(07-20)보다 8일 늦다. 같은 폭으로 밀면 이 행만
--    **미래 시각**이 된다. 처리 시각은 지금을 넘지 못하게 자른다.
--
-- 재실행해도 안전하다 — 두 번째부터는 shift가 0에 가까워 사실상 no-op이다.
--
-- 실행:  docker exec -i ai-pb-agent-postgres-1 psql -U app -d app < backend/scripts/shift_pb_sessions_time.sql
-- (선행: restore_pb_sessions.sql로 행을 넣어 둘 것 — 빈 테이블이면 UPDATE 0으로 끝난다.)

UPDATE pb_sessions s
SET started_at = s.started_at + x.shift,
    updated_at = least(s.updated_at + x.shift, now())
FROM (SELECT now() - max(started_at) AS shift FROM pb_sessions) x;

-- 결과 확인
SELECT count(*) AS rows,
       min(started_at) AS oldest,
       max(started_at) AS newest,
       max(updated_at) AS last_touched
FROM pb_sessions;
