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
