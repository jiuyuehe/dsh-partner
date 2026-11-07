import type { DatabaseSync } from 'node:sqlite'
import type { ChannelCursor, ChannelPlatform, CursorType } from './domain.js'
import { InboxSqliteProvider } from './provider.js'

type CursorRow = {
  channel_config_id: string
  scope_id: string
  platform: string
  cursor_type: string
  cursor_json: string
  high_watermark: number | null
  updated_at: number
}

function safeTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`)
}

function validateCursor(cursor: ChannelCursor): void {
  if (!cursor.channelConfigId.trim()) throw new Error('channelConfigId is required')
  if (cursor.platform !== 'weixin' && cursor.platform !== 'mattermost') throw new Error('cursor platform is invalid')
  if (cursor.cursorType !== 'timestamp' && cursor.cursorType !== 'opaque-buffer') throw new Error('cursor type is invalid')
  if (typeof cursor.cursorJson !== 'string') throw new Error('cursorJson must be a string')
  const parsed: unknown = JSON.parse(cursor.cursorJson)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('cursorJson must encode an object')
  safeTimestamp(cursor.updatedAt, 'updatedAt')
  if (cursor.cursorType === 'timestamp') {
    if (cursor.platform !== 'mattermost' || cursor.highWatermark === undefined) throw new Error('timestamp cursor requires a Mattermost highWatermark')
    safeTimestamp(cursor.highWatermark, 'highWatermark')
  } else if (cursor.platform !== 'weixin' || cursor.highWatermark !== undefined) {
    throw new Error('opaque-buffer cursor requires WeChat and must not have a highWatermark')
  }
}

export function cursorFromRow(row: CursorRow | undefined): ChannelCursor | undefined {
  if (!row) return undefined
  const platform = row.platform as ChannelPlatform
  const cursorType = row.cursor_type as CursorType
  if ((platform !== 'weixin' && platform !== 'mattermost') || (cursorType !== 'timestamp' && cursorType !== 'opaque-buffer')) {
    throw new Error('Durable Inbox cursor row is corrupt')
  }
  return {
    channelConfigId: row.channel_config_id,
    ...(row.scope_id ? { scopeId: row.scope_id } : {}),
    platform,
    cursorType,
    cursorJson: row.cursor_json,
    ...(row.high_watermark === null ? {} : { highWatermark: Number(row.high_watermark) }),
    updatedAt: Number(row.updated_at),
  }
}

/** Persisted cursor access. Page ingestion calls writeInTransaction to commit events and cursor together. */
export class CursorRepository {
  constructor(private readonly provider: InboxSqliteProvider) {}

  get(channelConfigId: string, scopeId = ''): ChannelCursor | undefined {
    return this.provider.read(database => cursorFromRow(database.prepare(
      'SELECT channel_config_id, scope_id, platform, cursor_type, cursor_json, high_watermark, updated_at FROM channel_cursors WHERE channel_config_id = ? AND scope_id = ?',
    ).get(channelConfigId, scopeId) as CursorRow | undefined))
  }

  commit(cursor: ChannelCursor): void {
    this.provider.transaction(database => CursorRepository.writeInTransaction(database, cursor))
  }

  static writeInTransaction(database: DatabaseSync, cursor: ChannelCursor): void {
    validateCursor(cursor)
    const scopeId = cursor.scopeId ?? ''
    if (scopeId.length > 512 || scopeId !== scopeId.trim()) throw new Error('cursor scopeId is invalid')
    const previous = cursorFromRow(database.prepare(
      'SELECT channel_config_id, scope_id, platform, cursor_type, cursor_json, high_watermark, updated_at FROM channel_cursors WHERE channel_config_id = ? AND scope_id = ?',
    ).get(cursor.channelConfigId, scopeId) as CursorRow | undefined)
    if (previous && (previous.platform !== cursor.platform || previous.cursorType !== cursor.cursorType)) {
      throw new Error('cursor platform or type changed for an existing channel')
    }
    if (previous?.highWatermark !== undefined && cursor.highWatermark !== undefined && cursor.highWatermark < previous.highWatermark) {
      throw new Error('cursor highWatermark cannot move backwards')
    }
    database.prepare(`INSERT INTO channel_cursors (channel_config_id, scope_id, platform, cursor_type, cursor_json, high_watermark, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_config_id, scope_id) DO UPDATE SET platform=excluded.platform, cursor_type=excluded.cursor_type,
        cursor_json=excluded.cursor_json, high_watermark=excluded.high_watermark, updated_at=excluded.updated_at`)
      .run(cursor.channelConfigId, scopeId, cursor.platform, cursor.cursorType, cursor.cursorJson, cursor.highWatermark ?? null, cursor.updatedAt)
  }
}
