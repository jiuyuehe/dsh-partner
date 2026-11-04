CREATE TABLE message_batches (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_key TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'received', 'filtered', 'buffered', 'ready', 'processing', 'completed',
    'retryable_failed', 'dead_letter', 'interrupted'
  )),
  event_ids_json TEXT NOT NULL DEFAULT '[]',
  first_received_at INTEGER NOT NULL CHECK (first_received_at >= 0),
  last_received_at INTEGER NOT NULL CHECK (last_received_at >= first_received_at),
  ready_at INTEGER NOT NULL CHECK (ready_at >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner TEXT,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);

CREATE TABLE inbox_events (
  id TEXT PRIMARY KEY NOT NULL,
  channel_config_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('weixin', 'mattermost')),
  account_id TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  external_message_id TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'received', 'filtered', 'buffered', 'ready', 'processing', 'completed',
    'retryable_failed', 'dead_letter', 'interrupted'
  )),
  batch_id TEXT REFERENCES message_batches(id) ON DELETE SET NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  received_at INTEGER NOT NULL CHECK (received_at >= 0),
  processed_at INTEGER,
  last_error TEXT,
  UNIQUE(channel_config_id, external_event_id)
);

CREATE TABLE channel_cursors (
  channel_config_id TEXT PRIMARY KEY NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('weixin', 'mattermost')),
  cursor_type TEXT NOT NULL CHECK (cursor_type IN ('timestamp', 'opaque-buffer')),
  cursor_json TEXT NOT NULL,
  high_watermark INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
);

CREATE TABLE outbound_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_key TEXT NOT NULL,
  target_json TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES message_batches(id) ON DELETE RESTRICT,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'unknown', 'failed')),
  external_message_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  last_error TEXT
);

CREATE INDEX idx_inbox_events_status_received ON inbox_events(status, received_at);
CREATE INDEX idx_inbox_events_conversation_received ON inbox_events(conversation_key, received_at);
CREATE INDEX idx_inbox_events_batch ON inbox_events(batch_id);
CREATE INDEX idx_message_batches_status_ready ON message_batches(status, ready_at);
CREATE INDEX idx_outbound_deliveries_status_updated ON outbound_deliveries(status, updated_at);
