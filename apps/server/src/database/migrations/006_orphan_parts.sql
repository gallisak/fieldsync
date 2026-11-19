-- Ids were accepted in upper case before they had to be lower case, and the uuid columns hide the difference.
-- No log entry: 007 changes the epoch, so every client takes a snapshot of these rows.
UPDATE entities
   SET data = data
       || jsonb_build_object('id', lower(data->>'id'), 'siteId', lower(data->>'siteId'))
       || CASE WHEN entity = 'part' THEN jsonb_build_object('ticketId', lower(data->>'ticketId'))
               WHEN data->>'assigneeId' IS NOT NULL THEN jsonb_build_object('assigneeId', lower(data->>'assigneeId'))
               ELSE '{}'::jsonb END
 WHERE data IS NOT NULL
   AND (data->>'id' <> lower(data->>'id') OR data->>'siteId' <> lower(data->>'siteId')
        OR data->>'ticketId' <> lower(data->>'ticketId') OR data->>'assigneeId' <> lower(data->>'assigneeId'));

-- Parts the starter's ticket delete left behind (F19): deleted for every client through the log, as one change.
WITH orphans AS (
  SELECT p.id, p.site_id, row_number() OVER (ORDER BY p.id) AS n
    FROM entities p
   WHERE p.entity = 'part' AND NOT p.deleted
     AND NOT EXISTS (
       SELECT 1 FROM entities t WHERE t.entity = 'ticket' AND NOT t.deleted AND t.id::text = p.data->>'ticketId'
     )
), allocated AS (
  UPDATE sync_state SET last_version = last_version + (SELECT count(*) FROM orphans)
  RETURNING last_version - (SELECT count(*) FROM orphans) AS base
), logged AS (
  INSERT INTO change_log (version, tx_seq, site_id, entity, entity_id, op, data)
  SELECT a.base + o.n, a.base + 1, o.site_id, 'part', o.id, 'del', NULL FROM orphans o CROSS JOIN allocated a
  RETURNING entity_id, version
)
UPDATE entities e SET deleted = true, data = NULL, version = l.version
  FROM logged l
 WHERE e.entity = 'part' AND e.id = l.entity_id;
