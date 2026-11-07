-- Mattermost 每个频道独立续读；旧的单游标迁移到空作用域保持兼容。
ALTER TABLE channel_cursors RENAME TO channel_cursors_v2;

CREATE TABLE channel_cursors (
  channel_config_id TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL CHECK (platform IN ('weixin', 'mattermost')),
  cursor_type TEXT NOT NULL CHECK (cursor_type IN ('timestamp', 'opaque-buffer')),
  cursor_json TEXT NOT NULL,
  high_watermark INTEGER,
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (channel_config_id, scope_id)
);

INSERT INTO channel_cursors (channel_config_id, scope_id, platform, cursor_type, cursor_json, high_watermark, updated_at)
SELECT channel_config_id, '', platform, cursor_type, cursor_json, high_watermark, updated_at FROM channel_cursors_v2;

DROP TABLE channel_cursors_v2;
