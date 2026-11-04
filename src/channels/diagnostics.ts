export type ChannelDiagnosticLevel = 'log' | 'warn' | 'error'
export type ChannelDiagnosticPlatform = 'weixin' | 'matrix' | 'mattermost' | 'qq'

export interface ChannelDiagnostic {
  sequence: number
  at: number
  level: ChannelDiagnosticLevel
  platform: ChannelDiagnosticPlatform
  channelId: string
  phase: string
  detail: string
  messageId?: string
  conversationId?: string
  senderId?: string
  textPreview?: string
  metadata?: Record<string, string | number | boolean>
}

export type ChannelDiagnosticInput = Omit<ChannelDiagnostic, 'sequence' | 'at'>

const DIAGNOSTIC_LIMIT = 200
const MESSAGE_PREVIEW_LIMIT = 1000

/** 渠道诊断只保留近期、可排查的消息元数据，不触碰令牌或微信回复上下文。 */
export class ChannelDiagnosticBuffer {
  private sequence = 0
  private readonly entries: ChannelDiagnostic[] = []

  record(input: ChannelDiagnosticInput, at = Date.now()): ChannelDiagnostic {
    const entry: ChannelDiagnostic = {
      ...input,
      detail: redactDiagnosticText(input.detail).slice(0, 500),
      ...(input.textPreview === undefined ? {} : { textPreview: redactDiagnosticText(input.textPreview).slice(0, MESSAGE_PREVIEW_LIMIT) }),
      sequence: ++this.sequence,
      at,
    }
    this.entries.push(entry)
    if (this.entries.length > DIAGNOSTIC_LIMIT) this.entries.splice(0, this.entries.length - DIAGNOSTIC_LIMIT)
    return entry
  }

  /** 浏览器使用序号增量读取，避免重复打印同一条诊断。 */
  after(sequence = 0): ChannelDiagnostic[] {
    const from = Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0
    return this.entries.filter(entry => entry.sequence > from).map(entry => ({ ...entry }))
  }

  /** 状态接口只回传最近 50 条，避免每次轮询重复传输完整消息预览。 */
  recent(limit = 50): ChannelDiagnostic[] {
    const bounded = Math.max(1, Math.min(DIAGNOSTIC_LIMIT, Math.floor(limit)))
    return this.entries.slice(-bounded).map(entry => ({ ...entry }))
  }
}

/** 错误描述和正文预览可能含有手工粘贴的令牌，输出前统一遮蔽常见格式。 */
export function redactDiagnosticText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(access[_-]?token|bot[_-]?token|context[_-]?token|api[_-]?key|password|token)(\s*[:=]\s*)[^\s,;&]+/gi, '$1$2[redacted]')
}
