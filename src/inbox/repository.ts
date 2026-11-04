import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { BatchId, InboxEventId } from './ids.js'
import { asBatchId, asInboxEventId } from './ids.js'
import type { ChannelCursor, InboxEventRecord, InboxStatus, InboundEnvelope, MessageBatch } from './domain.js'
import { deserializeInboundEnvelope, serializeInboundEnvelope } from './codec.js'
import { CursorRepository } from './cursor-repository.js'
import { InboxSqliteProvider } from './provider.js'

export interface InboxPageItem {
  envelope: InboundEnvelope
  status?: 'ready' | 'filtered'
}

export interface InboxPageResult {
  inserted: number
  duplicate: number
  eventIds: InboxEventId[]
}

export interface ClaimedInboxBatch {
  batch: MessageBatch
  events: InboxEventRecord[]
}

type BatchRow = {
  id: string; conversation_key: string; session_id: string | null; event_ids_json: string; status: string
  first_received_at: number; last_received_at: number; ready_at: number; attempt_count: number
  lease_owner: string | null; lease_until: number | null; created_at: number; updated_at: number; last_error: string | null
}
type EventRow = {
  id: string; channel_config_id: string; platform: string; account_id: string; external_event_id: string
  external_message_id: string; conversation_key: string; actor_id: string; payload_json: string; status: string
  batch_id: string | null; attempt_count: number; received_at: number; processed_at: number | null; last_error: string | null
}

const statuses = new Set<InboxStatus>(['received', 'filtered', 'buffered', 'ready', 'processing', 'completed', 'retryable_failed', 'dead_letter', 'interrupted'])

function batchFromRow(row: BatchRow): MessageBatch {
  if (!statuses.has(row.status as InboxStatus)) throw new Error('Durable Inbox batch status is corrupt')
  const eventIds = JSON.parse(row.event_ids_json) as unknown
  if (!Array.isArray(eventIds) || eventIds.some(item => typeof item !== 'string')) throw new Error('Durable Inbox batch event list is corrupt')
  return {
    id: asBatchId(row.id), conversationKey: row.conversation_key as MessageBatch['conversationKey'],
    ...(row.session_id === null ? {} : { sessionId: row.session_id as NonNullable<MessageBatch['sessionId']> }),
    eventIds: eventIds.map(asInboxEventId), status: row.status as InboxStatus,
    firstReceivedAt: Number(row.first_received_at), lastReceivedAt: Number(row.last_received_at), readyAt: Number(row.ready_at),
    attemptCount: Number(row.attempt_count), ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_until === null ? {} : { leaseUntil: Number(row.lease_until) }), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  }
}

function eventFromRow(row: EventRow): InboxEventRecord {
  if (!statuses.has(row.status as InboxStatus)) throw new Error('Durable Inbox event status is corrupt')
  return {
    id: asInboxEventId(row.id), channelConfigId: row.channel_config_id, platform: row.platform as InboxEventRecord['platform'],
    accountId: row.account_id, externalEventId: row.external_event_id as InboxEventRecord['externalEventId'],
    externalMessageId: row.external_message_id as InboxEventRecord['externalMessageId'], conversationKey: row.conversation_key as InboxEventRecord['conversationKey'],
    actorId: row.actor_id, payload: deserializeInboundEnvelope(row.payload_json), status: row.status as InboxStatus,
    ...(row.batch_id === null ? {} : { batchId: asBatchId(row.batch_id) }), attemptCount: Number(row.attempt_count), receivedAt: Number(row.received_at),
    ...(row.processed_at === null ? {} : { processedAt: Number(row.processed_at) }), ...(row.last_error === null ? {} : { lastError: row.last_error }),
  }
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(\b(?:token|access_token|auth|key|password)\s*=\s*)[^&\s]+/gi, '$1[redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 2000) || 'Unknown processing error'
}

/** Durable inbox operations. Every accepted page and its cursor commit in one SQLite transaction. */
export class InboxRepository {
  constructor(private readonly provider: InboxSqliteProvider) {}

  persistPage(items: readonly InboxPageItem[], cursor: ChannelCursor): InboxPageResult {
    return this.provider.transaction(database => {
      const result: InboxPageResult = { inserted: 0, duplicate: 0, eventIds: [] }
      for (const item of items) {
        const envelope = JSON.parse(serializeInboundEnvelope(item.envelope)) as InboundEnvelope
        if (envelope.channelConfigId !== cursor.channelConfigId || envelope.platform !== cursor.platform) {
          throw new Error('inbox event source does not match cursor source')
        }
        const existing = database.prepare('SELECT id FROM inbox_events WHERE channel_config_id = ? AND external_event_id = ?')
          .get(envelope.channelConfigId, envelope.externalEventId) as { id: string } | undefined
        if (existing) {
          result.duplicate++
          result.eventIds.push(asInboxEventId(existing.id))
          continue
        }
        const eventId = asInboxEventId(randomUUID())
        const batchId = asBatchId(randomUUID())
        const status = item.status ?? 'ready'
        const receivedAt = envelope.receivedAt
        const processedAt = status === 'filtered' ? cursor.updatedAt : null
        database.prepare(`INSERT INTO message_batches
          (id, conversation_key, session_id, status, event_ids_json, first_received_at, last_received_at, ready_at, attempt_count, lease_owner, lease_until, last_error, created_at, updated_at)
          VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?, ?)`)
          .run(batchId, envelope.conversationKey, status, JSON.stringify([eventId]), receivedAt, receivedAt, receivedAt, cursor.updatedAt, cursor.updatedAt)
        database.prepare(`INSERT INTO inbox_events
          (id, channel_config_id, platform, account_id, external_event_id, external_message_id, conversation_key, actor_id, payload_json, status, batch_id, attempt_count, received_at, processed_at, last_error)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`)
          .run(eventId, envelope.channelConfigId, envelope.platform, envelope.accountId, envelope.externalEventId, envelope.externalMessageId,
            envelope.conversationKey, envelope.actorId, serializeInboundEnvelope(envelope), status, batchId, receivedAt, processedAt)
        result.inserted++
        result.eventIds.push(eventId)
      }
      CursorRepository.writeInTransaction(database, cursor)
      return result
    })
  }

  getEvent(channelConfigId: string, externalEventId: string): InboxEventRecord | undefined {
    return this.provider.read(database => eventFromMaybe(database.prepare(`SELECT * FROM inbox_events
      WHERE channel_config_id = ? AND external_event_id = ?`).get(channelConfigId, externalEventId) as EventRow | undefined))
  }

  listEvents(status?: InboxStatus, limit = 100): InboxEventRecord[] {
    const bounded = Math.max(1, Math.min(1000, Math.floor(limit)))
    return this.provider.read(database => {
      const rows = status
        ? database.prepare('SELECT * FROM inbox_events WHERE status = ? ORDER BY received_at, id LIMIT ?').all(status, bounded)
        : database.prepare('SELECT * FROM inbox_events ORDER BY received_at, id LIMIT ?').all(bounded)
      return rows.map(row => eventFromRow(row as EventRow))
    })
  }

  claimNext(workerId: string, now = Date.now(), leaseMs = 30_000): ClaimedInboxBatch | undefined {
    if (!workerId.trim() || workerId !== workerId.trim()) throw new Error('workerId must be a non-empty stable identifier')
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error('lease time is invalid')
    return this.provider.transaction(database => {
      const row = database.prepare(`SELECT * FROM message_batches
        WHERE ((status IN ('ready', 'retryable_failed', 'interrupted')) AND ready_at <= ?)
          OR (status = 'processing' AND (lease_until IS NULL OR lease_until <= ?))
        ORDER BY ready_at, created_at, id LIMIT 1`).get(now, now) as BatchRow | undefined
      if (!row) return undefined
      const leaseUntil = now + leaseMs
      const changed = database.prepare(`UPDATE message_batches SET status='processing', lease_owner=?, lease_until=?,
        attempt_count=attempt_count+1, updated_at=? WHERE id=? AND (((status IN ('ready', 'retryable_failed', 'interrupted')) AND ready_at <= ?)
        OR (status='processing' AND (lease_until IS NULL OR lease_until <= ?)))`)
        .run(workerId, leaseUntil, now, row.id, now, now)
      if (Number(changed.changes) !== 1) return undefined
      database.prepare('UPDATE inbox_events SET status=\'processing\', attempt_count=attempt_count+1 WHERE batch_id=?').run(row.id)
      const claimedRow = database.prepare('SELECT * FROM message_batches WHERE id=?').get(row.id) as BatchRow
      const events = database.prepare('SELECT * FROM inbox_events WHERE batch_id=? ORDER BY received_at, id').all(row.id) as EventRow[]
      return { batch: batchFromRow(claimedRow), events: events.map(eventFromRow) }
    })
  }

  settle(batchId: BatchId, workerId: string, now = Date.now()): void {
    this.provider.transaction(database => {
      const batch = this.assertLease(database, batchId, workerId, now)
      database.prepare(`UPDATE message_batches SET status='completed', lease_owner=NULL, lease_until=NULL, last_error=NULL, updated_at=? WHERE id=?`)
        .run(now, batch.id)
      database.prepare(`UPDATE inbox_events SET status='completed', processed_at=?, last_error=NULL WHERE batch_id=?`)
        .run(now, batch.id)
    })
  }

  fail(batchId: BatchId, workerId: string, error: unknown, now = Date.now(), options: { maxAttempts?: number; retryDelayMs?: number } = {}): 'retryable_failed' | 'dead_letter' {
    const maxAttempts = options.maxAttempts ?? 5
    const retryDelayMs = options.retryDelayMs ?? 1000
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) throw new Error('retry policy is invalid')
    return this.provider.transaction(database => {
      const batch = this.assertLease(database, batchId, workerId, now)
      const status = batch.attempt_count >= maxAttempts ? 'dead_letter' : 'retryable_failed'
      const detail = safeError(error)
      const readyAt = status === 'dead_letter' ? now : now + retryDelayMs
      database.prepare('UPDATE message_batches SET status=?, ready_at=?, lease_owner=NULL, lease_until=NULL, last_error=?, updated_at=? WHERE id=?')
        .run(status, readyAt, detail, now, batch.id)
      database.prepare('UPDATE inbox_events SET status=?, last_error=? WHERE batch_id=?')
        .run(status, detail, batch.id)
      return status
    })
  }

  deadLetters(limit = 100): Array<{ batch: MessageBatch; events: InboxEventRecord[] }> {
    const bounded = Math.max(1, Math.min(1000, Math.floor(limit)))
    return this.provider.read(database => {
      const rows = database.prepare("SELECT * FROM message_batches WHERE status='dead_letter' ORDER BY updated_at DESC, id LIMIT ?").all(bounded) as BatchRow[]
      return rows.map(row => ({
        batch: batchFromRow(row),
        events: (database.prepare('SELECT * FROM inbox_events WHERE batch_id=? ORDER BY received_at, id').all(row.id) as EventRow[]).map(eventFromRow),
      }))
    })
  }

  private assertLease(database: DatabaseSync, batchId: BatchId, workerId: string, now: number): BatchRow {
    const row = database.prepare('SELECT * FROM message_batches WHERE id=?').get(batchId) as BatchRow | undefined
    if (!row || row.status !== 'processing' || row.lease_owner !== workerId || row.lease_until === null || row.lease_until <= now) {
      throw new Error('inbox batch lease is missing, expired or owned by another worker')
    }
    return row
  }
}

function eventFromMaybe(row: EventRow | undefined): InboxEventRecord | undefined {
  return row ? eventFromRow(row) : undefined
}
