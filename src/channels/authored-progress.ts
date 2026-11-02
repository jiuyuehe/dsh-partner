import type { ReplyProgress } from '../execution/reply-progress.js'

/** Forward model-authored speech before tools, never fixed labels or tool data.
 * Best effort, bounded, and drained before the final reply. Unknown sends are not retried. */
export class AuthoredProgress {
  private pending: Promise<void> = Promise.resolve()
  private readonly seen = new Map<string,Promise<void>>()
  private closed = false
  constructor(private readonly send: (text: string) => Promise<unknown>, private readonly allowed: () => boolean, private readonly signal: AbortSignal, private readonly limit=3) {}
  update: ReplyProgress = Object.assign((activity:Parameters<ReplyProgress>[0]) => {
    if (this.closed || typeof activity === 'string' || activity.kind !== 'text') return
    void this.acknowledge(activity.text).catch(()=>{})
  }, {acknowledge:(text:string)=>this.acknowledge(text)})
  async acknowledge(raw:string):Promise<void>{
    const text=raw.trim()
    const existing=this.seen.get(text)
    if(existing)return existing
    if(this.closed || !text || text.length>6000 || this.seen.size>=this.limit)throw Error('本轮前置回应已关闭或超出限制')
    const job=this.pending.then(async()=>{
      if(this.closed || this.signal.aborted || !this.allowed())throw Error('前置回应目标已失效')
      await this.send(text)
    })
    this.seen.set(text,job)
    this.pending=job.catch(()=>{this.closed=true})
    return job
  }
  async finish(): Promise<void> { await this.pending; this.closed = true }
}
