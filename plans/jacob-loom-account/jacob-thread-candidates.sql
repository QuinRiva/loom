-- Candidate list: root threads Jacob created or drove on Carl's instance.
-- No column records the auth session behind a command, so this unions four indirect signals.
WITH
root_of AS (
  SELECT t.thread_id,
         COALESCE(w.root_thread_id, json_extract(t.payload_json, '$.lineage.rootThreadId'), t.thread_id) AS root
  FROM orchestration_v2_projection_threads t
  LEFT JOIN loom_thread_workstream w ON w.thread_id = t.thread_id
),
-- W: a human-typed web message while Jacob's was the only browser session that could be connected.
-- Carl's last browser connection: 2026-08-19T00:37Z; his next pairing: 2026-09-20T08:43Z.
-- 2026-08-19 itself is a handover day (Carl "about to logoff" 07:00Z, still on web ~12:00Z), counted apart.
-- Slack-bridge messages start with '[' and name their sender, so they are excluded here.
win AS (
  SELECT r.root, SUM(m.created_at >= '2026-08-20T00:00:00Z') AS n, SUM(m.created_at < '2026-08-20T00:00:00Z') AS n_handover
  FROM orchestration_v2_projection_messages m JOIN root_of r ON r.thread_id = m.thread_id
  WHERE m.role = 'user'
    AND m.created_at >= '2026-08-19T00:38:00Z' AND m.created_at < '2026-09-20T08:43:05Z'
    AND json_extract(m.payload_json, '$.createdBy') = 'user'
    AND substr(json_extract(m.payload_json, '$.text'), 1, 1) <> '['
  GROUP BY r.root
),
-- S: Jacob names himself, or an agent relays "the human (Jacob)".
self_id AS (
  SELECT r.root, COUNT(*) AS n
  FROM loom_thread_search s JOIN root_of r ON r.thread_id = s.thread_id
  WHERE loom_thread_search MATCH 'jacob'
    AND s.kind IN ('user', 'brief', 'purpose')
    AND (lower(s.text) LIKE '%i am jacob%' OR lower(s.text) LIKE '%i''m jacob%'
      OR lower(s.text) LIKE '%jacob here%' OR lower(s.text) LIKE '%me (jacob)%'
      OR lower(s.text) LIKE '%from me jacob%' OR lower(s.text) LIKE '%logged in as jacob@%'
      OR lower(s.text) LIKE '%the human (jacob%' OR lower(s.text) LIKE '%the human, jacob%'
      OR lower(s.text) LIKE '%human side of this work (jacob%'
      OR lower(s.text) LIKE '%jacob (the requester)%' OR lower(s.text) LIKE '%jacob (the human)%'
      OR lower(s.text) LIKE '%jacob (covering for carl%' OR lower(s.text) LIKE '%(the human owner%'
      OR lower(s.text) LIKE '%just jacob, carl is not%')
  GROUP BY r.root
),
-- K: Jacob over the Slack bridge (his Slack user id is in the bridge's message header).
slack AS (
  SELECT r.root, COUNT(*) AS n
  FROM loom_thread_search s JOIN root_of r ON r.thread_id = s.thread_id
  WHERE loom_thread_search MATCH '"U04V79SPF9T"' AND s.kind = 'user'
  GROUP BY r.root
),
-- L: Jacob types the pronoun as lowercase "i" and never "I"; Carl did so in 1 of 2,565 messages
-- before Jacob had access, Jacob in 32 of 217 while he was the only browser user.
style AS (
  SELECT r.root, COUNT(*) AS n
  FROM orchestration_v2_projection_messages m JOIN root_of r ON r.thread_id = m.thread_id,
       (SELECT char(10) AS nl) AS c
  WHERE m.role = 'user' AND json_extract(m.payload_json, '$.createdBy') = 'user'
    AND substr(json_extract(m.payload_json, '$.text'), 1, 1) NOT IN ('[', '#', '*')
    AND length(json_extract(m.payload_json, '$.text')) < 3000
    AND (json_extract(m.payload_json, '$.text') GLOB '* i *' OR json_extract(m.payload_json, '$.text') GLOB 'i *'
      OR json_extract(m.payload_json, '$.text') GLOB '* i''[a-z]*' OR json_extract(m.payload_json, '$.text') GLOB 'i''[a-z]*'
      OR json_extract(m.payload_json, '$.text') GLOB ('*' || c.nl || 'i *'))
    AND NOT (json_extract(m.payload_json, '$.text') GLOB '* I *' OR json_extract(m.payload_json, '$.text') GLOB 'I *'
      OR json_extract(m.payload_json, '$.text') GLOB '* I''[a-z]*' OR json_extract(m.payload_json, '$.text') GLOB 'I''[a-z]*'
      OR json_extract(m.payload_json, '$.text') GLOB ('*' || c.nl || 'I *'))
  GROUP BY r.root
),
cand AS (
  SELECT root FROM win UNION SELECT root FROM self_id UNION SELECT root FROM slack UNION SELECT root FROM style
)
SELECT c.root AS thread_id,
       t.title,
       p.title AS project,
       substr(t.created_at, 1, 10) AS created,
       substr(t.updated_at, 1, 10) AS last_active,
       CASE WHEN t.archived_at IS NULL THEN 'no' ELSE 'yes' END AS archived,
       (SELECT COUNT(*) FROM loom_thread_workstream w WHERE w.root_thread_id = c.root AND w.thread_id <> c.root) AS children,
       trim(
         CASE WHEN si.n IS NOT NULL THEN 'self-id/relayed(' || si.n || ') ' ELSE '' END ||
         CASE WHEN sl.n IS NOT NULL THEN 'slack(' || sl.n || ') ' ELSE '' END ||
         CASE WHEN st.n IS NOT NULL THEN 'lowercase-i(' || st.n || ') ' ELSE '' END ||
         CASE WHEN wi.n > 0 THEN 'window(' || wi.n || ') ' ELSE '' END ||
         CASE WHEN wi.n_handover > 0 THEN 'handover-day(' || wi.n_handover || ') ' ELSE '' END ||
         CASE WHEN wi.root IS NOT NULL AND t.created_at < '2026-08-19T00:38:00Z' THEN 'root-predates-window' ELSE '' END
       ) AS signal
FROM cand c
JOIN orchestration_v2_projection_threads t ON t.thread_id = c.root
LEFT JOIN projection_projects p ON p.project_id = t.project_id
LEFT JOIN win wi ON wi.root = c.root
LEFT JOIN self_id si ON si.root = c.root
LEFT JOIN slack sl ON sl.root = c.root
LEFT JOIN style st ON st.root = c.root
WHERE t.deleted_at IS NULL
ORDER BY (si.n IS NOT NULL OR sl.n IS NOT NULL) DESC, (COALESCE(wi.n, 0) > 0 OR st.n IS NOT NULL) DESC, t.updated_at DESC;
