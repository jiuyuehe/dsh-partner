import type { ChannelCursor } from './domain.js'

export const MATTERMOST_CURSOR_OVERLAP_MS = 60_000

/** Re-read a bounded overlap so posts sharing one create_at millisecond cannot be skipped. */
export function mattermostSinceCursor(cursor: ChannelCursor | undefined): string | undefined {
  if (!cursor) return undefined
  if (cursor.platform !== 'mattermost' || cursor.cursorType !== 'timestamp' || cursor.highWatermark === undefined) {
    throw new Error('Mattermost Durable Inbox cursor has an unexpected type')
  }
  return String(Math.max(0, cursor.highWatermark - MATTERMOST_CURSOR_OVERLAP_MS))
}

export function mattermostHighWatermark(cursorValue: string, previous?: number): number {
  const parsed = Number(cursorValue)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Mattermost response cursor is not a safe timestamp')
  return Math.max(previous ?? 0, parsed)
}

export function legacyMattermostHighWatermark(cursor: string | undefined): number | undefined {
  if (cursor === undefined || cursor === '') return undefined
  const parsed = Number(cursor)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}
