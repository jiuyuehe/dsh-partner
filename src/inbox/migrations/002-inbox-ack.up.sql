CREATE TABLE inbox_acknowledgements (
  event_id TEXT PRIMARY KEY NOT NULL REFERENCES inbox_events(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'unknown', 'failed')),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  last_error TEXT
);

CREATE INDEX idx_inbox_acknowledgements_status_updated
  ON inbox_acknowledgements(status, updated_at);
