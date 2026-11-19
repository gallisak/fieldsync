-- The hourly GC deletes by age; without these both deletes scan the whole table.
CREATE INDEX mutation_rejections_created_idx ON mutation_rejections (created_at);
CREATE INDEX clients_last_seen_idx ON clients (last_seen_at);
