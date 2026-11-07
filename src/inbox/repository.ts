import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { BatchId, InboxEventId } from './ids.js'
import { asBatchId, asInboxEventId } from './ids.js'
import type { ChannelCursor, InboxEventRecord, InboxStatus, InboundEnvelope, MessageBatch } from './domain.js'
import { deserializeInboundEnvelope, serializeInboundEnvelope } from './codec.js'
import { CursorRepository } from './cursor-repository.js'
import { InboxSqliteProvider } from './provider.js'
import { canAppendEnvelope, coalescedReadyAt, type InboxBatchPolicy } from './coalescer.js'

export interface InboxPageItem {
  envelope: InboundEnvelope
  status?: 'ready' | 'filtered'
}

export interface InboxPageResult {
  inserted: number
  duplicate: number
  eventIds: InboxEventId[]
  newEventIds: InboxEventId[]
  coalesced: number
}

export type InboxAcknowledgementStatus = 'pending' | 'sending' | 'sent' | 'unknown' | 'failed'

const NO_COALESCING: InboxBatchPolicy = {
  debounceMs: 0, maxCollectionMs: 4_000, maxMessages: 8, maxTextBytes: 32 * 1024,
  maxAttachments: 8, maxAttachmentBytes: 64 * 1024 * 1024,
}

// 活跃 Agent 的补充会逐条 steer，不应被初始收集批次的 8 条上限拒绝。
const ACTIVE_STEER_POLICY: InboxBatchPolicy = {
  debounceMs: 1, maxCollectionMs: Number.MAX_SAFE_INTEGER, maxMessages: 256,
  maxTextBytes: 2 * 1024 * 1024, maxAttachments: 256, maxAttachmentBytes: 512 * 1024 * 1024,
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

/** 持久化收件箱操作；每页获准事件和渠道游标在同一 SQLite 事务中提交。 */
export class InboxRepository {
  constructor(private readonly provider: InboxSqliteProvider) {}

  persistPage(items: readonly InboxPageItem[], cursor: ChannelCursor, policy: InboxBatchPolicy = NO_COALESCING): InboxPageResult {
    validateBatchPolicy(policy)
    return this.provider.transaction(database => {
      const result: InboxPageResult = { inserted: 0, duplicate: 0, eventIds: [], newEventIds: [], coalesced: 0 }
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
        const status = item.status ?? 'ready'
        const receivedAt = envelope.receivedAt
        const processedAt = status === 'filtered' ? cursor.updatedAt : null
        const candidates = status === 'ready' && policy.debounceMs > 0
          ? database.prepare(`SELECT * FROM message_batches WHERE conversation_key=? AND status='ready' AND ready_at>?
              ORDER BY created_at DESC, id DESC LIMIT 20`).all(envelope.conversationKey, receivedAt) as BatchRow[]
          : []
        let targetBatch = candidates.find(candidate => {
          const currentEvents = (database.prepare('SELECT * FROM inbox_events WHERE batch_id=? ORDER BY received_at, rowid').all(candidate.id) as EventRow[])
            .map(eventFromRow)
          return canAppendEnvelope(currentEvents.map(event => event.payload), envelope, policy)
        })
        let batchId: BatchId
        if (targetBatch) {
          const currentBatch = batchFromRow(targetBatch)
          const eventIds = [...currentBatch.eventIds, eventId]
          const lastReceivedAt = Math.max(currentBatch.lastReceivedAt, receivedAt)
          const readyAt = coalescedReadyAt(currentBatch.firstReceivedAt, lastReceivedAt, policy)
          database.prepare(`UPDATE message_batches SET event_ids_json=?, last_received_at=?, ready_at=?, updated_at=? WHERE id=? AND status='ready'`)
            .run(JSON.stringify(eventIds), lastReceivedAt, readyAt, cursor.updatedAt, currentBatch.id)
          batchId = currentBatch.id
          result.coalesced++
        } else {
          batchId = asBatchId(randomUUID())
          const readyAt = status === 'ready' ? coalescedReadyAt(receivedAt, receivedAt, policy) : receivedAt
          database.prepare(`INSERT INTO message_batches
            (id, conversation_key, session_id, status, event_ids_json, first_received_at, last_received_at, ready_at, attempt_count, lease_owner, lease_until, last_error, created_at, updated_at)
            VALUES (?, ?, NULL, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?, ?)`)
            .run(batchId, envelope.conversationKey, status, JSON.stringify([eventId]), receivedAt, receivedAt, readyAt, cursor.updatedAt, cursor.updatedAt)
        }
        database.prepare(`INSERT INTO inbox_events
          (id, channel_config_id, platform, account_id, external_event_id, external_message_id, conversation_key, actor_id, payload_json, status, batch_id, attempt_count, received_at, processed_at, last_error)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`)
          .run(eventId, envelope.channelConfigId, envelope.platform, envelope.accountId, envelope.externalEventId, envelope.externalMessageId,
            envelope.conversationKey, envelope.actorId, serializeInboundEnvelope(envelope), status, batchId, receivedAt, processedAt)
        if (status === 'ready') database.prepare(`INSERT INTO inbox_acknowledgements (event_id, status, updated_at, last_error)
          VALUES (?, 'pending', ?, NULL)`).run(eventId, cursor.updatedAt)
        result.inserted++
        result.eventIds.push(eventId)
        result.newEventIds.push(eventId)
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
        ? database.prepare('SELECT * FROM inbox_events WHERE status = ? ORDER BY received_at, rowid LIMIT ?').all(status, bounded)
        : database.prepare('SELECT * FROM inbox_events ORDER BY received_at, rowid LIMIT ?').all(bounded)
      return rows.map(row => eventFromRow(row as EventRow))
    })
  }

  getEventById(eventId: InboxEventId): InboxEventRecord | undefined {
    return this.provider.read(database => eventFromMaybe(database.prepare('SELECT * FROM inbox_events WHERE id=?').get(eventId) as EventRow | undefined))
  }

  getBatch(batchId: BatchId): ClaimedInboxBatch | undefined {
    return this.provider.read(database => this.readBatch(database, batchId))
  }

  /** 每条获准入站消息至多发送一次确认；崩溃后的 sending 不会自动重试。 */
  claimAcknowledgement(eventId: InboxEventId, now = Date.now()): boolean {
    return this.provider.transaction(database => {
      const changed = database.prepare(`UPDATE inbox_acknowledgements SET status='sending', updated_at=?, last_error=NULL
        WHERE event_id=? AND status='pending'`).run(now, eventId)
      return Number(changed.changes) === 1
    })
  }

  finishAcknowledgement(eventId: InboxEventId, status: Exclude<InboxAcknowledgementStatus, 'pending' | 'sending'>, error?: unknown, now = Date.now()): void {
    const detail = error === undefined ? null : safeError(error)
    this.provider.transaction(database => {
      database.prepare(`UPDATE inbox_acknowledgements SET status=?, updated_at=?, last_error=? WHERE event_id=? AND status='sending'`)
        .run(status, now, detail, eventId)
    })
  }

  acknowledgementStatus(eventId: InboxEventId): InboxAcknowledgementStatus | undefined {
    return this.provider.read(database => {
      const row = database.prepare('SELECT status FROM inbox_acknowledgements WHERE event_id=?').get(eventId) as { status: string } | undefined
      return row?.status as InboxAcknowledgementStatus | undefined
    })
  }

  /** 活跃任务读取紧随自己的批次时可越过合批静默时间，其他读取仍等待批次到期。 */
  nextReadyForConversation(conversationKey: string, now = Date.now(), activeBatchId?: BatchId): ClaimedInboxBatch | undefined {
    return this.provider.read(database => {
      const rows = database.prepare(`SELECT * FROM message_batches WHERE conversation_key=?
        AND status IN ('ready','processing','retryable_failed','interrupted')
        ORDER BY first_received_at, created_at, id LIMIT 3`).all(conversationKey) as BatchRow[]
      if (rows.length === 0) return undefined
      const [first, second] = rows
      let row: BatchRow | undefined
      if (first!.id === activeBatchId && first!.status === 'processing') row = second
      else row = first
      if (!row || row.status !== 'ready' || (activeBatchId === undefined && row.ready_at > now)) return undefined
      return row ? this.readBatch(database, asBatchId(row.id)) : undefined
    })
  }

  /** 队列压力只作为诊断；消息本体始终留在 SQLite，不因上限被丢弃。 */
  pendingCounts(): { total: number; byConversation: Map<string, number> } {
    return this.provider.read(database => {
      const rows = database.prepare(`SELECT conversation_key, COUNT(*) AS count FROM message_batches
        WHERE status IN ('ready','processing','retryable_failed','interrupted') GROUP BY conversation_key`).all() as Array<{ conversation_key: string; count: number }>
      const byConversation = new Map(rows.map(row => [row.conversation_key, Number(row.count)]))
      return { total: [...byConversation.values()].reduce((sum, count) => sum + count, 0), byConversation }
    })
  }

  claimNext(workerId: string, now = Date.now(), leaseMs = 30_000, excludedConversationKeys: readonly string[] = []): ClaimedInboxBatch | undefined {
    if (!workerId.trim() || workerId !== workerId.trim()) throw new Error('workerId must be a non-empty stable identifier')
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error('lease time is invalid')
    return this.provider.transaction(database => {
      const excluded = [...new Set(excludedConversationKeys)]
      const exclusionSql = excluded.length ? `AND b.conversation_key NOT IN (${excluded.map(() => '?').join(',')})` : ''
      const row = database.prepare(`SELECT b.* FROM message_batches b
        WHERE (((b.status IN ('ready', 'retryable_failed', 'interrupted')) AND b.ready_at <= ?)
          OR (b.status = 'processing' AND (b.lease_until IS NULL OR b.lease_until <= ?)))
          ${exclusionSql}
          AND NOT EXISTS (
            SELECT 1 FROM message_batches earlier
            WHERE earlier.conversation_key=b.conversation_key AND earlier.id<>b.id
              AND earlier.status IN ('ready','processing','retryable_failed','interrupted')
              AND (earlier.first_received_at < b.first_received_at
                OR (earlier.first_received_at=b.first_received_at AND earlier.created_at < b.created_at)
                OR (earlier.first_received_at=b.first_received_at AND earlier.created_at=b.created_at AND earlier.id < b.id))
          )
        ORDER BY b.ready_at, b.first_received_at, b.created_at, b.id LIMIT 1`).get(now, now, ...excluded) as BatchRow | undefined
      if (!row) return undefined
      const leaseUntil = now + leaseMs
      const changed = database.prepare(`UPDATE message_batches SET status='processing', lease_owner=?, lease_until=?,
        attempt_count=attempt_count+1, updated_at=? WHERE id=? AND (((status IN ('ready', 'retryable_failed', 'interrupted')) AND ready_at <= ?)
        OR (status='processing' AND (lease_until IS NULL OR lease_until <= ?)))`)
        .run(workerId, leaseUntil, now, row.id, now, now)
      if (Number(changed.changes) !== 1) return undefined
      database.prepare('UPDATE inbox_events SET status=\'processing\', attempt_count=attempt_count+1 WHERE batch_id=?').run(row.id)
      const claimedRow = database.prepare('SELECT * FROM message_batches WHERE id=?').get(row.id) as BatchRow
      const events = database.prepare('SELECT * FROM inbox_events WHERE batch_id=? ORDER BY received_at, rowid').all(row.id) as EventRow[]
      return { batch: batchFromRow(claimedRow), events: events.map(eventFromRow) }
    })
  }

  renewLease(batchId: BatchId, workerId: string, now = Date.now(), leaseMs = 30_000): void {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error('lease time is invalid')
    this.provider.transaction(database => {
      this.assertLease(database, batchId, workerId, now)
      const changed = database.prepare(`UPDATE message_batches SET lease_until=?, updated_at=?
        WHERE id=? AND status='processing' AND lease_owner=? AND lease_until>?`).run(now + leaseMs, now, batchId, workerId, now)
      if (Number(changed.changes) !== 1) throw new Error('inbox batch lease was lost before renewal')
    })
  }

  /** 租约持有人在撤权/渠道变更后可安全过滤整批，阻止已入库消息继续执行。 */
  discard(batchId: BatchId, workerId: string, reason: unknown, now = Date.now()): void {
    this.provider.transaction(database => {
      const batch = this.assertLease(database, batchId, workerId, now)
      const detail = safeError(reason)
      database.prepare(`UPDATE message_batches SET status='filtered', lease_owner=NULL, lease_until=NULL, last_error=?, updated_at=? WHERE id=?`)
        .run(detail, now, batch.id)
      database.prepare(`UPDATE inbox_events SET status='filtered', processed_at=?, last_error=? WHERE batch_id=?`)
        .run(now, detail, batch.id)
    })
  }

  interrupt(batchId: BatchId, workerId: string, now = Date.now()): void {
    this.provider.transaction(database => {
      const batch = this.assertLease(database, batchId, workerId, now)
      database.prepare(`UPDATE message_batches SET status='interrupted', lease_owner=NULL, lease_until=NULL, updated_at=? WHERE id=?`)
        .run(now, batch.id)
      database.prepare(`UPDATE inbox_events SET status='interrupted' WHERE batch_id=?`).run(batch.id)
    })
  }

  /** 在调用 DSH steer 前冻结补充批次，防止账本正文与实际注入内容发生竞态。 */
  reserveReadyBatchForActiveSteer(sourceBatchId: BatchId, activeBatchId: BatchId, workerId: string, now = Date.now()): boolean {
    if (sourceBatchId === activeBatchId) return false
    return this.provider.transaction(database => {
      const active = this.assertLease(database, activeBatchId, workerId, now)
      const source = database.prepare('SELECT * FROM message_batches WHERE id=?').get(sourceBatchId) as BatchRow | undefined
      if (!source || source.status !== 'ready' || source.conversation_key !== active.conversation_key) return false
      const activeEvents = (database.prepare('SELECT * FROM inbox_events WHERE batch_id=? ORDER BY received_at,rowid').all(activeBatchId) as EventRow[]).map(eventFromRow)
      const sourceEvents = (database.prepare('SELECT * FROM inbox_events WHERE batch_id=? ORDER BY received_at,rowid').all(sourceBatchId) as EventRow[]).map(eventFromRow)
      if (sourceEvents.length === 0) return false
      const merged = [...activeEvents.map(event => event.payload)]
      for (const event of sourceEvents) {
        if (!canAppendEnvelope(merged, event.payload, ACTIVE_STEER_POLICY)) return false
        merged.push(event.payload)
      }
      const reserved = database.prepare(`UPDATE message_batches SET status='processing', lease_owner=?, lease_until=?, updated_at=?
        WHERE id=? AND status='ready'`).run(workerId, active.lease_until, now, sourceBatchId)
      if (Number(reserved.changes) !== 1) return false
      database.prepare(`UPDATE inbox_events SET status='processing' WHERE batch_id=? AND status='ready'`).run(sourceBatchId)
      return true
    })
  }

  /** DSH 明确接受 steer 后，把已冻结来源原子并入活动租约。 */
  attachReservedSteerBatch(sourceBatchId: BatchId, activeBatchId: BatchId, workerId: string, now = Date.now()): boolean {
    if (sourceBatchId === activeBatchId) return false
    return this.provider.transaction(database => {
      const active = this.assertLease(database, activeBatchId, workerId, now)
      const source = this.assertLease(database, sourceBatchId, workerId, now)
      if (source.conversation_key !== active.conversation_key) return false
      const sourceEvents = (database.prepare('SELECT * FROM inbox_events WHERE batch_id=? ORDER BY received_at,rowid').all(sourceBatchId) as EventRow[]).map(eventFromRow)
      if (sourceEvents.length === 0) return false
      // 来源批次已在 reserve 事务中通过容量与会话校验并冻结；外部 Agent 接受后不可再因重复校验拒绝记账。
      const activeBatch = batchFromRow(active)
      const combinedIds = [...activeBatch.eventIds, ...sourceEvents.map(event => event.id)]
      database.prepare('UPDATE inbox_events SET batch_id=?, status=\'processing\' WHERE batch_id=?').run(activeBatchId, sourceBatchId)
      database.prepare(`UPDATE message_batches SET event_ids_json=?, last_received_at=?, updated_at=? WHERE id=?`)
        .run(JSON.stringify(combinedIds), Math.max(activeBatch.lastReceivedAt, Number(source.last_received_at)), now, activeBatchId)
      database.prepare('DELETE FROM message_batches WHERE id=?').run(sourceBatchId)
      return true
    })
  }

  /** DSH 明确拒绝 steer 时放回原队列，允许该消息之后作为独立轮次正常处理。 */
  releaseReservedSteerBatch(sourceBatchId: BatchId, workerId: string, now = Date.now()): void {
    this.provider.transaction(database => {
      const source = this.assertLease(database, sourceBatchId, workerId, now)
      database.prepare(`UPDATE message_batches SET status='ready', lease_owner=NULL, lease_until=NULL, ready_at=?, updated_at=? WHERE id=?`)
        .run(now, now, source.id)
      database.prepare(`UPDATE inbox_events SET status='ready' WHERE batch_id=? AND status='processing'`).run(source.id)
    })
  }

  /** steer 异常可能已注入 DSH；隔离来源，避免之后自动重复执行。 */
  quarantineReservedSteerBatch(sourceBatchId: BatchId, workerId: string, reason: unknown, now = Date.now()): void {
    const detail = safeError(reason)
    this.provider.transaction(database => {
      const source = database.prepare('SELECT * FROM message_batches WHERE id=?').get(sourceBatchId) as BatchRow | undefined
      if (!source || source.status !== 'processing' || source.lease_owner !== workerId) return
      database.prepare(`UPDATE message_batches SET status='dead_letter', lease_owner=NULL, lease_until=NULL, last_error=?, updated_at=? WHERE id=?`)
        .run(detail, now, sourceBatchId)
      database.prepare(`UPDATE inbox_events SET status='dead_letter', last_error=? WHERE batch_id=?`).run(detail, sourceBatchId)
    })
  }

  /** 对 steer 已接受但未能落库的事件停止自动重试，避免重复注入 DSH。 */
  quarantineUnclaimed(batchId: BatchId, reason: unknown, now = Date.now()): void {
    this.provider.transaction(database => {
      const batch = database.prepare('SELECT * FROM message_batches WHERE id=?').get(batchId) as BatchRow | undefined
      if (!batch || !['ready', 'retryable_failed', 'interrupted'].includes(batch.status)) return
      const detail = safeError(reason)
      database.prepare(`UPDATE message_batches SET status='dead_letter', lease_owner=NULL, lease_until=NULL, last_error=?, updated_at=? WHERE id=?`)
        .run(detail, now, batchId)
      database.prepare(`UPDATE inbox_events SET status='dead_letter', last_error=? WHERE batch_id=?`).run(detail, batchId)
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

  private readBatch(database: DatabaseSync, batchId: BatchId): ClaimedInboxBatch | undefined {
    const row = database.prepare('SELECT * FROM message_batches WHERE id=?').get(batchId) as BatchRow | undefined
    if (!row) return undefined
    const events = database.prepare('SELECT * FROM inbox_events WHERE batch_id=? ORDER BY received_at,rowid').all(batchId) as EventRow[]
    return { batch: batchFromRow(row), events: events.map(eventFromRow) }
  }
}

function eventFromMaybe(row: EventRow | undefined): InboxEventRecord | undefined {
  return row ? eventFromRow(row) : undefined
}

function validateBatchPolicy(policy: InboxBatchPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`inbox batching policy ${name} is invalid`)
  }
  if (policy.maxMessages < 1 || policy.maxTextBytes < 1 || policy.maxAttachments < 0 || policy.maxCollectionMs < 1) {
    throw new Error('inbox batching policy limits are invalid')
  }
}
