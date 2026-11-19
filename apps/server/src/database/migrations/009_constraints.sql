-- What the code always wrote, now enforced by the database.
ALTER TABLE entities
  ADD CONSTRAINT entities_entity_check CHECK (entity IN ('ticket', 'part')),
  ADD CONSTRAINT entities_site_fk FOREIGN KEY (site_id) REFERENCES sites (id);
ALTER TABLE change_log
  ADD CONSTRAINT change_log_entity_check CHECK (entity IN ('ticket', 'part')),
  ADD CONSTRAINT change_log_op_check CHECK (op IN ('put', 'del'));
ALTER TABLE clients ADD CONSTRAINT clients_user_fk FOREIGN KEY (user_id) REFERENCES users (id);
