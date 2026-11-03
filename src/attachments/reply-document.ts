import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { workExpressionEvidence } from '../chat/work-expression.js'

export const REPLY_DOCUMENT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['name', 'content'],
  properties: { name: { type: 'string', description: '不含路径的 .md 或 .txt 文件名', maxLength: 120 }, content: { type: 'string', minLength: 1, maxLength: 100000, description: '完整正文；保留结果、必要限制和依据，不是聊天摘要。' } },
}
export const WORK_REPORT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['runIds'],
  properties: { name: { type: 'string', maxLength: 120, description: '按本轮任务主题命名的 .md 文件名，例如“视频接口核验.md”，不要固定叫工作结果。' }, runIds: { type: 'array', minItems: 1, maxItems: 8, uniqueItems: true, items: { type: 'string' }, description: '当前回合 partner_work_execute 返回的真实 runId；程序原样收录事实、未知、依据和产物。' } },
}
export function replyDocument(raw: unknown, work: unknown, events: readonly SessionEvent[]): {name: string; content: string} {
  if (raw !== undefined) {
    const v = raw as {name?: unknown; content?: unknown}
    if (!v || typeof v !== 'object' || Object.keys(v).some(k => !['name', 'content'].includes(k)) || typeof v.name !== 'string' || v.name.length > 120 || !/^[^/\\\x00-\x1f<>:`]+\.(md|txt)$/i.test(v.name) || v.name.startsWith('.') || typeof v.content !== 'string' || !v.content.trim() || v.content.length > 100000) throw Error('document 需要安全的 .md/.txt 文件名和 1–100000 字完整正文')
    return {name: v.name, content: v.content}
  }
  const v = work as {runIds?: unknown; name?: unknown}
  if (!v || typeof v !== 'object' || Object.keys(v).some(k => !['runIds','name'].includes(k)) || !Array.isArray(v.runIds) || !v.runIds.length || v.runIds.length > 8 || new Set(v.runIds).size !== v.runIds.length || v.runIds.some(id => typeof id !== 'string')) throw Error('workReport 需要 1–8 个不重复的本轮 runId')
  const start = [...events].reverse().find(e => e.type === 'turn/start')?.seq ?? 0
  const source = workExpressionEvidence(events, start)
  const reports = v.runIds.map(id => {
    const report = source.reports.find(r => r.runId === id)
    if (!report) throw Error('工作记录不存在或不属于当前回合')
    return report
  })
  const fallback = String(reports[0]?.facts[0] || '任务执行记录').replace(/[\\/\x00-\x1f<>:\x60"|?*#]/g, '').trim().slice(0, 36) || '任务执行记录'
  const name = v.name ?? fallback + '.md'
  if (typeof name !== 'string' || name.length > 120 || !/^[^/\\\x00-\x1f<>:\x60]+\.md$/i.test(name) || name.startsWith('.')) throw Error('workReport.name 需要安全的 .md 文件名')
  return {name, content: '# ' + name.slice(0,-3) + '\n\n' + reports.map(r => [
    `## ${r.runId}`, `状态：${r.status}`, ...(['facts','unknowns','evidence','artifacts'] as const).map((key, i) =>
      `### ${['结果','未确认或受阻事项（本次工作范围）','依据','产物位置（不代表已发送）'][i]}\n\n` + (r[key].length ? r[key].join('\n\n') : '无记录')),
  ].join('\n\n')).join('\n\n') + '\n'}
}
