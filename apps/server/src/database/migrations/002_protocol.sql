CREATE TABLE sync_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  last_version bigint NOT NULL,
  min_retained_version bigint NOT NULL DEFAULT 0
);
INSERT INTO sync_state (last_version) SELECT COALESCE(max(version), 0) FROM change_log;

ALTER TABLE change_log
  ADD COLUMN client_id text,
  ADD COLUMN mutation_id bigint,
  ADD COLUMN tx_seq bigint NOT NULL DEFAULT 0;

ALTER TABLE clients ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE mutation_rejections (
  client_id text NOT NULL,
  mutation_id bigint NOT NULL,
  code text NOT NULL,
  message text NOT NULL,
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, mutation_id)
);
