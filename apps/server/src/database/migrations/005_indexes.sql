CREATE INDEX change_log_site_version_idx ON change_log (site_id, version);
CREATE INDEX entities_snapshot_idx ON entities (site_id, entity, id) WHERE NOT deleted;
CREATE INDEX entities_part_ticket_idx ON entities ((data->>'ticketId')) WHERE entity = 'part' AND NOT deleted;
CREATE INDEX entities_tombstone_idx ON entities (version) WHERE deleted;
DROP INDEX entities_site_idx;
