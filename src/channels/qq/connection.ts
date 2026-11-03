import { randomUUID } from 'node:crypto'

export class OneBotError extends Error {
  constructor(message: string, readonly retryable = true) { super(message) }
}

/** A completed API error response, distinct from an unknown transport outcome. */
export class OneBotApiError extends OneBotError {
  constructor(readonly retcode: unknown, wording: unknown) {
    // Preserve protocol diagnostics, never echo arbitrary server text/URLs/secrets into prompts.
    const oidb = typeof wording === 'string' ? wording.match(/OIDB error (\d+) on (0x[0-9a-f]+_\d+)/i) : null
    super(`QQ 接口明确返回失败（retcode ${Number.isFinite(retcode)?retcode:'未知'}）${oidb?`; OIDB ${oidb[1]} / ${oidb[2]}`:''}${typeof wording==='string'&&wording.includes('Process_Nudge failed')?'; Process_Nudge failed':''}`,false)
  }
}

/** One universal forward WS carries events and echo-correlated API responses.
 * Mutating API requests are never replayed after disconnect or timeout. */
export class OneBotConnection {
  private socket: WebSocket | undefined
  private opening: Promise<void> | undefined
  private readonly pending = new Map<string, { resolve(value: any): void; reject(error: Error): void }>()
  private events: unknown[] = []
  private readonly messageAuthors=new Map<string,string>()
  private rememberAuthor(groupId:unknown,messageId:unknown,userId:unknown):void {
    if(![groupId,messageId,userId].every(value=>['string','number'].includes(typeof value)&&String(value).length<=128))return
    const key=String(groupId)+':'+String(messageId)
    this.messageAuthors.delete(key);this.messageAuthors.set(key,String(userId))
    if(this.messageAuthors.size>512)this.messageAuthors.delete(this.messageAuthors.keys().next().value!)
  }
  quotedTarget(groupId:string,messageId:string,accountId:string):'self'|'other'|undefined {
    const author=this.messageAuthors.get(groupId+':'+messageId)
    return author===undefined?undefined:author==='$self'||author===accountId?'self':'other'
  }
  private wake: (() => void) | undefined
  private fault: OneBotError | undefined
  private stopped = false
  constructor(private readonly address: string, private readonly token: string) {}

  async connect(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.stopped) throw new OneBotError('QQ 渠道已停止', false)
    if (this.fault && !this.fault.retryable) throw this.fault
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (!this.opening) {
      this.opening = this.open().finally(() => { this.opening = undefined })
    }
    await this.withAbort(this.opening, signal)
  }

  private open(): Promise<void> {
    const url = new URL(this.address)
    if (this.token) url.searchParams.set('access_token', this.token)
    const socket = new WebSocket(url)
    this.socket = socket
    this.fault = undefined
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new OneBotError('QQ WebSocket 连接超时，请检查地址、端口和 WS Token'))
        socket.close()
      }, 15000)
      const fail = () => {
        clearTimeout(timer)
        const error = this.fault ?? new OneBotError('QQ WebSocket 已断开，请检查 SnowLuma 登录状态和 WS Token')
        reject(error)
        if (this.socket !== socket) return
        this.socket = undefined
        this.fault = error
        for (const pending of this.pending.values()) pending.reject(error)
        this.pending.clear()
        this.wake?.()
      }
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', fail)
      socket.addEventListener('close', fail)
      socket.addEventListener('message', event => {
        if (this.socket !== socket || this.stopped) return
        try {
          if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 8 * 1024 * 1024) throw Error()
          const data = JSON.parse(event.data)
          if (!data || typeof data !== 'object') throw Error()
          if (typeof data.echo === 'string') {
            const pending = this.pending.get(data.echo)
            if (!pending) return
            this.pending.delete(data.echo)
            if (data.status === 'ok' && data.retcode === 0) pending.resolve(data.data)
            else pending.reject(new OneBotApiError(data.retcode, data.wording ?? data.message))
          } else if ((data.post_type === 'message' && ['private','group'].includes(data.message_type)) || (data.post_type === 'notice' && data.notice_type === 'notify' && data.sub_type === 'poke')) {
            if (this.events.length >= 500) {
              this.fault = new OneBotError('QQ 消息积压超过 500 条，请检查处理状态后重新启用渠道', false)
              socket.close(); this.wake?.(); return
            }
            if(data.message_type==='group')this.rememberAuthor(data.group_id,data.message_id,data.user_id)
            this.events.push({...data, _partnerReceivedAt: Date.now()})
            this.wake?.()
          }
        } catch {
          this.fault = new OneBotError('QQ 返回了无效或过大的协议消息', false)
          socket.close(); this.wake?.()
        }
      })
    })
  }

  async call(action: string, params: Record<string, unknown>, signal = AbortSignal.timeout(30000), beforeSend?:()=>void): Promise<any> {
    const lifetime = AbortSignal.any([signal, AbortSignal.timeout(30000)])
    await this.connect(lifetime)
    lifetime.throwIfAborted()
    beforeSend?.()
    const echo = randomUUID()
    let abort: () => void = () => {}
    try {
      const result=await new Promise<any>((resolve, reject) => {
        abort = () => { this.pending.delete(echo); reject(new OneBotError('QQ 请求已取消或超时；发送结果未知，不会自动重发')) }
        lifetime.addEventListener('abort', abort, { once: true })
        this.pending.set(echo, { resolve, reject })
        try { this.socket!.send(JSON.stringify({ action, params, echo })) }
        catch { this.pending.delete(echo); reject(new OneBotError('QQ 连接不可用，操作未确认')) }
      })
      if(action==='send_group_msg'&&result?.message_id!==undefined)this.rememberAuthor(params.group_id,result.message_id,'$self')
      return result
    } finally { lifetime.removeEventListener('abort', abort); this.pending.delete(echo) }
  }

  async read(signal: AbortSignal, waitMs: number): Promise<unknown[]> {
    await this.connect(signal)
    if (!this.events.length && waitMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined
      let abort: () => void = () => {}
      try {
        await new Promise<void>((resolve, reject) => {
          this.wake = resolve
          timer = setTimeout(resolve, waitMs)
          abort = () => reject(signal.reason)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        })
      } finally { clearTimeout(timer); this.wake = undefined; signal.removeEventListener('abort', abort) }
    }
    signal.throwIfAborted()
    if (this.fault) throw this.fault
    return this.events.splice(0)
  }

  close(): void {
    this.stopped = true
    for (const pending of this.pending.values()) pending.reject(new OneBotError('QQ 渠道已停止', false))
    this.pending.clear()
    this.socket?.close(); this.socket = undefined
    this.wake?.(); this.events = []
  }

  private async withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    let abort: () => void = () => {}
    try { return await Promise.race([promise, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })]) } finally { signal.removeEventListener('abort', abort) }
  }
}
