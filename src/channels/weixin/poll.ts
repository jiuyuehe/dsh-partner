import { setTimeout } from 'node:timers/promises'
import type { GetUpdatesResponse } from './types.js'
import { WeixinHttpError, WeixinResponseError, weixinAuthenticationFailure, weixinTransientFailure } from './errors.js'

interface PollOptions {
  initialBuffer?: string
  getUpdates(buffer: string, timeoutMs: number, signal: AbortSignal): Promise<GetUpdatesResponse>
  receive(response: GetUpdatesResponse, nextBuffer: string): void | Promise<void>
  state(value: { status: 'starting' | 'running'; lastError?: string }): void
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}

/** Polling retries do not replay agent work or resend outgoing messages. */
export async function pollWeixin(signal: AbortSignal, options: PollOptions): Promise<void> {
  let buffer = options.initialBuffer ?? '', timeoutMs = 35_000, failures = 0, permanentFailures = 0
  const wait = options.wait ?? ((ms, lifetime) => setTimeout(ms, undefined, { signal: lifetime }))
  while (!signal.aborted) {
    let response: GetUpdatesResponse
    try {
      response = await options.getUpdates(buffer, timeoutMs, signal)
      if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) throw new WeixinResponseError(response.ret ?? 0, response.errcode ?? 0)
    } catch (error) {
      if (signal.aborted) return
      if (weixinAuthenticationFailure(error)) throw new Error('微信登录凭据失效或访问被拒绝，请重新扫码连接')
      const transient = weixinTransientFailure(error)
      failures = Math.min(failures + 1, 30)
      permanentFailures = transient ? 0 : permanentFailures + 1
      if (permanentFailures >= 6) throw new Error(`微信接口持续返回非网络错误，请检查配置后重连（${error instanceof WeixinResponseError || error instanceof WeixinHttpError ? error.message : '响应异常'}）`)
      const backoff = Math.min(60_000, 1000 * 2 ** Math.min(failures - 1, 6))
      const delay = Math.max(Math.round(backoff * (0.8 + Math.random() * 0.2)), error instanceof WeixinHttpError ? error.retryAfterMs : 0)
      const reason = error instanceof WeixinHttpError ? `HTTP ${error.status}` : transient ? '网络中断或请求超时' : '接口响应异常'
      options.state({ status: 'starting', lastError: `${reason}，${Math.ceil(delay / 1000)} 秒后${transient ? '自动重连' : '重试'}（第 ${failures} 次）` })
      try { await wait(delay, signal) } catch (error) { if (signal.aborted) return; throw error }
      continue
    }
    if (signal.aborted) return
    failures = 0; permanentFailures = 0
    options.state({ status: 'running' })
    const nextBuffer = response.get_updates_buf ?? buffer
    if (response.longpolling_timeout_ms !== undefined && Number.isFinite(response.longpolling_timeout_ms)) timeoutMs = Math.min(120_000, Math.max(5000, response.longpolling_timeout_ms))
    // The caller durably stores the page and its cursor before this poller adopts the cursor.
    await options.receive(response, nextBuffer)
    buffer = nextBuffer
  }
}
