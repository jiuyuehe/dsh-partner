import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { ClaimedInboxBatch, InboxRepository } from './repository.js'
import type { BatchId, ConversationKey } from './ids.js'

export type InboxBatchDisposition = 'completed' | 'filtered'

export interface InboxDispatcherObserver {
  (event: {
    kind: 'claimed' | 'completed' | 'filtered' | 'failed' | 'steered' | 'queue-pressure'
    batch: ClaimedInboxBatch
    detail?: string
    pendingGlobal?: number
    pendingConversation?: number
  }): void
}

export interface InboxBatchProcessor {
  process(batch: ClaimedInboxBatch, signal: AbortSignal): Promise<InboxBatchDisposition | void>
  canSteer?(active: ClaimedInboxBatch, incoming: ClaimedInboxBatch): boolean
  steer?(active: ClaimedInboxBatch, incoming: ClaimedInboxBatch, signal: AbortSignal): Promise<boolean>
}

export interface InboxDispatcherOptions {
  workerId?: string
  maxConcurrentLanes?: number
  maxPendingGlobal?: number
  maxPendingPerConversation?: number
  pollIntervalMs?: number
  leaseMs?: number
  leaseRenewMs?: number
  maxAttempts?: number
  observer?: InboxDispatcherObserver
}

interface ActiveLane {
  batch: ClaimedInboxBatch
  controller: AbortController
  task: Promise<void>
  steerAttempts: Set<string>
  reservedSteers: Set<BatchId>
  steering: Promise<boolean> | undefined
  processingFinished: boolean
}

/** SQLite 是唯一等待队列；内存只保留有限数量的活跃会话 lane。 */
export class InboxDispatcher {
  private readonly workerId: string
  private readonly maxConcurrentLanes: number
  private readonly maxPendingGlobal: number
  private readonly maxPendingPerConversation: number
  private readonly pollIntervalMs: number
  private readonly leaseMs: number
  private readonly leaseRenewMs: number
  private readonly maxAttempts: number
  private readonly observer: InboxDispatcherObserver
  private readonly active = new Map<ConversationKey, ActiveLane>()
  private readonly pressureReported = new Set<string>()
  private timer: ReturnType<typeof setInterval> | undefined
  private pumping: Promise<void> | undefined
  private started = false
  private closed = false

  constructor(
    private readonly repository: InboxRepository,
    private readonly processor: InboxBatchProcessor,
    observer: InboxDispatcherObserver = () => {},
    options: InboxDispatcherOptions = {},
  ) {
    this.workerId = options.workerId ?? `inbox-worker-${randomUUID()}`
    this.maxConcurrentLanes = positiveLimit(options.maxConcurrentLanes, 6)
    this.maxPendingGlobal = positiveLimit(options.maxPendingGlobal, 200)
    this.maxPendingPerConversation = positiveLimit(options.maxPendingPerConversation, 50)
    this.pollIntervalMs = positiveLimit(options.pollIntervalMs, 250)
    this.leaseMs = positiveLimit(options.leaseMs, 30_000)
    this.leaseRenewMs = positiveLimit(options.leaseRenewMs, 10_000)
    this.maxAttempts = positiveLimit(options.maxAttempts, 5)
    this.observer = options.observer ?? observer
  }

  start(): void {
    if (this.started || this.closed) return
    this.started = true
    this.timer = setInterval(() => this.kick(), this.pollIntervalMs)
    this.timer.unref?.()
    this.kick()
  }

  /** 持久化提交后唤醒 worker；不会把平台消息放入易失内存队列。 */
  notify(): void { this.kick() }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.started = false
      if (this.timer) clearInterval(this.timer)
      this.timer = undefined
    }
    const tasks = [...this.active.values()]
    for (const lane of tasks) lane.controller.abort(new Error('Inbox dispatcher is shutting down'))
    // Agent turn 可能仍在等待模型；两秒后由租约超时交给下次启动恢复。
    const pending = [...tasks.map(lane => lane.task), ...(this.pumping ? [this.pumping] : [])]
    await Promise.race([Promise.allSettled(pending), delay(2_000)])
  }

  private kick(): void {
    if (!this.started || this.closed || this.pumping) return
    this.pumping = this.pump().finally(() => { this.pumping = undefined })
  }

  private async pump(): Promise<void> {
    await this.trySteers()
    if (!this.started || this.closed) return
    this.reportQueuePressure()
    while (this.active.size < this.maxConcurrentLanes && this.started && !this.closed) {
      const claimed = this.repository.claimNext(this.workerId, Date.now(), this.leaseMs, [...this.active.keys()])
      if (!claimed) break
      const key = claimed.batch.conversationKey as ConversationKey
      const lane: ActiveLane = { batch: claimed, controller: new AbortController(), task: Promise.resolve(), steerAttempts: new Set(), reservedSteers: new Set(), steering: undefined, processingFinished: false }
      this.active.set(key, lane)
      this.observer({ kind: 'claimed', batch: claimed })
      lane.task = this.run(lane)
    }
  }

  private async trySteers(): Promise<void> {
    if (!this.processor.canSteer || !this.processor.steer || this.active.size === 0) return
    for (const [key, lane] of this.active) {
      // 同一活跃会话按来源顺序逐条插入；Agent 正在收尾或 lane 已被替换时立即停止。
      for (let count = 0; count < 16; count++) {
        if (this.active.get(key) !== lane || lane.controller.signal.aborted || lane.processingFinished || this.closed) break
        let incoming: ClaimedInboxBatch | undefined
        try { incoming = this.repository.nextReadyForConversation(key, Date.now(), lane.batch.batch.id) }
        catch (error) { this.observer({ kind: 'failed', batch: lane.batch, detail: errorText(error) }); break }
        if (!incoming || incoming.batch.id === lane.batch.batch.id) break
        const attemptKey = `${lane.batch.batch.id}:${incoming.batch.id}`
        // 一个 lane 内只尝试每个来源一次，避免不符合权限/边界的首批挡不住后仍反复自旋。
        if (lane.steerAttempts.has(attemptKey)) break
        let eligible = false
        try { eligible = this.processor.canSteer(lane.batch, incoming) }
        catch (error) { lane.steerAttempts.add(attemptKey); this.observer({ kind: 'failed', batch: incoming, detail: errorText(error) }); break }
        if (!eligible) { lane.steerAttempts.add(attemptKey); break }
        lane.steerAttempts.add(attemptKey)
        const steering = this.steerReservedBatch(lane, incoming)
        lane.steering = steering
        let attached = false
        try { attached = await steering }
        finally { if (lane.steering === steering) lane.steering = undefined }
        if (!attached) break
      }
    }
  }

  private async steerReservedBatch(lane: ActiveLane, incoming: ClaimedInboxBatch): Promise<boolean> {
    let reserved = false
    try {
      // 先冻结来源，再触发 DSH；这保证模型实际收到的正文与持久化事件集合一致。
      reserved = this.repository.reserveReadyBatchForActiveSteer(incoming.batch.id, lane.batch.batch.id, this.workerId)
      if (!reserved) return false
      lane.reservedSteers.add(incoming.batch.id)
      const accepted = await this.processor.steer!(lane.batch, incoming, lane.controller.signal)
      if (!accepted) {
        if (incoming.events.some(event => event.payload.platform === 'mattermost')) {
          // Mattermost 同来源消息不能因 DSH 竞争态被静默改成新的 FIFO 回合。
          this.repository.quarantineReservedSteerBatch(incoming.batch.id, this.workerId,
            'Mattermost 活跃会话未接受原生 steer；为避免另开排队回合，已隔离此批消息，请确认 Agent 状态后重发')
          this.observer({ kind: 'failed', batch: incoming, detail: 'Mattermost 活跃会话未接受原生 steer；消息已隔离，没有转入 FIFO' })
        } else {
          this.repository.releaseReservedSteerBatch(incoming.batch.id, this.workerId)
        }
        return false
      }
      if (lane.controller.signal.aborted || this.closed) {
        this.repository.quarantineReservedSteerBatch(incoming.batch.id, this.workerId, 'Agent 已接受补充，但 DSH 正在退出；已隔离避免下次重复注入')
        return false
      }
      const attached = this.repository.attachReservedSteerBatch(incoming.batch.id, lane.batch.batch.id, this.workerId)
      if (!attached) throw new Error('Agent 已接受补充，但预留的 Inbox 批次无法合并到当前租约')
      lane.batch = this.repository.getBatch(lane.batch.batch.id) ?? lane.batch
      this.observer({ kind: 'steered', batch: incoming })
      return true
    } catch (error) {
      const detail = errorText(error)
      // 异常返回可能发生在 Agent 已接收消息之后；不自动重试这条补充。
      if (reserved) {
        try { this.repository.quarantineReservedSteerBatch(incoming.batch.id, this.workerId, `steer result is ambiguous: ${detail}`) }
        catch { /* 过期租约仍由持久化队列诊断，不重复触发该来源。 */ }
      }
      this.observer({ kind: 'failed', batch: incoming, detail })
      return false
    } finally {
      lane.reservedSteers.delete(incoming.batch.id)
    }
  }

  private async run(lane: ActiveLane): Promise<void> {
    let leaseLost = false
    const renewer = setInterval(() => {
      try {
        const now = Date.now()
        this.repository.renewLease(lane.batch.batch.id, this.workerId, now, this.leaseMs)
        // steer 调用可能较慢，续租来源批次，避免其他 worker 接管仍在处理的补充。
        for (const batchId of lane.reservedSteers) this.repository.renewLease(batchId, this.workerId, now, this.leaseMs)
      }
      catch (error) { leaseLost = true; lane.controller.abort(error) }
    }, this.leaseRenewMs)
    renewer.unref?.()
    try {
      let disposition: InboxBatchDisposition | void = undefined
      let processingError: unknown
      let processingFailed = false
      try { disposition = await this.processor.process(lane.batch, lane.controller.signal) }
      catch (error) { processingError = error; processingFailed = true }
      lane.processingFinished = true
      // 等待全部已开始的 steer；等待期间禁止再为已结束的 Agent 开始新的插入。
      while (lane.steering) {
        const steering = lane.steering
        await steering
        if (lane.steering === steering) lane.steering = undefined
      }
      lane.batch = this.repository.getBatch(lane.batch.batch.id) ?? lane.batch
      if (processingFailed) throw processingError
      if (this.closed) return
      if (leaseLost) throw new Error('inbox batch lease was lost while Agent work was running')
      if (lane.controller.signal.aborted) throw lane.controller.signal.reason ?? new Error('inbox batch processing was aborted')
      if (disposition === 'filtered') {
        this.repository.discard(lane.batch.batch.id, this.workerId, '渠道授权或配置在执行前发生变化')
        this.observer({ kind: 'filtered', batch: lane.batch })
      } else {
        this.repository.settle(lane.batch.batch.id, this.workerId)
        this.observer({ kind: 'completed', batch: lane.batch })
      }
    } catch (error) {
      if (this.closed) return
      try {
        if (lane.controller.signal.aborted && !leaseLost) {
          this.repository.interrupt(lane.batch.batch.id, this.workerId)
        } else {
          this.repository.fail(lane.batch.batch.id, this.workerId, error, Date.now(), {
            maxAttempts: error instanceof PermanentInboxError ? 1 : this.maxAttempts,
            retryDelayMs: retryDelay(lane.batch.batch.attemptCount),
          })
        }
      } catch (settlementError) {
        this.observer({ kind: 'failed', batch: lane.batch, detail: errorText(settlementError) })
      }
      this.observer({ kind: 'failed', batch: lane.batch, detail: errorText(error) })
    } finally {
      clearInterval(renewer)
      const key = lane.batch.batch.conversationKey as ConversationKey
      if (this.active.get(key) === lane) this.active.delete(key)
      if (this.started && !this.closed) this.kick()
    }
  }

  private reportQueuePressure(): void {
    let counts: ReturnType<InboxRepository['pendingCounts']>
    try { counts = this.repository.pendingCounts() } catch { return }
    for (const [key, count] of counts.byConversation) {
      const pressureKey = `conversation:${key}`
      if (count > this.maxPendingPerConversation && !this.pressureReported.has(pressureKey)) {
        this.pressureReported.add(pressureKey)
        const batch = this.repository.nextReadyForConversation(key, Date.now())
        if (batch) this.observer({ kind: 'queue-pressure', batch, pendingGlobal: counts.total, pendingConversation: count })
      } else if (count <= this.maxPendingPerConversation) this.pressureReported.delete(pressureKey)
    }
    if (counts.total > this.maxPendingGlobal && !this.pressureReported.has('global')) {
      const lane = this.active.values().next().value as ActiveLane | undefined
      // 队列刚启动时可能还没有活跃 lane；此时先找到一个持久化批次再记录，避免把“尚未能报告”误记为已报告。
      const batch = lane?.batch ?? [...counts.byConversation.keys()]
        .map(key => this.repository.nextReadyForConversation(key, Number.MAX_SAFE_INTEGER))
        .find((item): item is ClaimedInboxBatch => item !== undefined)
      if (batch) {
        this.pressureReported.add('global')
        this.observer({ kind: 'queue-pressure', batch, pendingGlobal: counts.total })
      }
    } else if (counts.total <= this.maxPendingGlobal) this.pressureReported.delete('global')
  }
}

export class PermanentInboxError extends Error {}

function positiveLimit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1) throw new Error('Inbox dispatcher limits must be positive integers')
  return result
}

function retryDelay(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.min(Math.max(0, attempt - 1), 5))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
