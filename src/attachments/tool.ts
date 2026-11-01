import { attachmentDeliveryMeta } from '../attachments/delivery-receipt.js'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { replyDocument, REPLY_DOCUMENT_SCHEMA, WORK_REPORT_SCHEMA } from './reply-document.js'
import { questionOrigin } from '../channels/question-origin.js'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { PartnerStore } from '../store.js'
import type { ChannelManager } from '../channels/manager.js'
import { isInternalTaskNotice, isRequirementDeliveryReceipt } from '../channels/delivery-policy.js'
import { continuationChannelOrigin } from '../scheduler/channel-origin.js'
import type { AttachmentDeliveryService } from './service.js'

export const ATTACHMENT_PROTOCOL = '交付图片或文档时，如果当前提供 partner_send_attachment，必须调用它，path 填生成工具返回的真实本地文件路径；长回复可用 document 的 name/content 直接生成文档，本轮完整工作报告可用 workReport.runIds 引用真实记录。普通 Markdown 链接仅是引用，不代表发送成功。工具会把指定文件显示在会话中，并在当前会话绑定渠道时发送真实附件；必须以工具返回的 channel 状态为准。失败用 deliveryId 重试原附件，无需重新生成。远端文件先下载到当前会话目录，不要编造 sandbox 地址。不要提交中间产物、内部核验材料或用户未要求交付的文件；按用户配置的短句接话交付完整长回复或工作报告属于已选择的交付方式。工具完成后最终回复按当前闲聊节奏接话，短句模式不再汇总文档结论，不要再次粘贴附件下载地址。若临时执行环境未提供此工具，只向负责人交回真实文件位置和结果，不得声称附件已发送。'

export function attachmentTool(companionId: string, store: PartnerStore, service: AttachmentDeliveryService, ctx: Context, channels: ChannelManager, prefix: string): ToolDefinition {
  return {
    name: 'partner_send_attachment', description: '明确交付一个图片或文档到当前伙伴会话及其绑定渠道。path、deliveryId、document、workReport 四选一；document 直接把完整正文生成为 Markdown/文本附件，workReport 按本轮真实 runId 原样生成完整工作报告；path 提交当前会话目录内真实文件（64 MB 内），deliveryId 重试已保存附件。不是文件检索工具，不自动下载 URL，不跨伙伴读取文件。内部看板执行/验收仅展示在会话，不向渠道逐项发送。',
    parameters: { type:'object', properties:{document:REPLY_DOCUMENT_SCHEMA,workReport:WORK_REPORT_SCHEMA,path:{type:'string'},deliveryId:{type:'string',description:'失败回执中的 ID；已成功的同一交付不会重复发送'}}, additionalProperties:false },
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:String(value)}],presentationMeta:(_args,value)=>attachmentDeliveryMeta(value)},
    presentCall:()=>({card:'generic',title:'交付图片或文档'}),
    async execute(raw, exec) {
      const input = raw as {path?:unknown;deliveryId?:unknown;document?:unknown;workReport?:unknown}
      if (!input || typeof input !== 'object' || ['path','deliveryId','document','workReport'].filter(k => (input as Record<string,unknown>)[k] !== undefined).length !== 1 || (input.path !== undefined && typeof input.path !== 'string') || (input.deliveryId !== undefined && typeof input.deliveryId !== 'string')) throw new Error('path、deliveryId、document、workReport 必须且只能提供一个')
      const agent = exec.agent
      if (!agent) throw new Error('附件交付需要当前伙伴会话')
      const sessionId = agent.session.id
      return service.serial(sessionId, async () => {
        exec.signal.throwIfAborted()
        const state=store.snapshot(), route=state.sessions.find(s=>s.sessionId===sessionId&&s.companionId===companionId)
        if (!route || !state.companions.some(c=>c.id===companionId) || store.isCompanionRemoving(companionId)) throw new Error('当前会话不属于有效伙伴，不能交付附件')
        const events=agent.session.snapshotEvents()
        const origin=[...events].reverse().find(e=>e.type==='user/message' && !isRequirementDeliveryReceipt(e) && (e.data.source.kind==='user'||isInternalTaskNotice(e)))
        if (origin?.type === 'user/message' && isInternalTaskNotice(origin) && 'summary' in origin.data.source && origin.data.source.summary === '伙伴汇总需求') throw new Error('需求汇报请用 partner_requirements prepare_delivery 提交总结和正式附件 ID 清单；不要再次单独发送附件')
        const source = continuationChannelOrigin(state, companionId, sessionId, events)
        const channel = !!source
        const cwd=route.cwd??agent.session.header.cwd
        if(!cwd)throw new Error('当前会话缺少工作目录')
        let documentCwd: string | undefined
        let documentPath: string | undefined
        let item
        try {
          if (input.document !== undefined || input.workReport !== undefined) {
            if (input.workReport !== undefined) {
              const start = [...events].reverse().find(e => e.type === 'turn/start')?.seq ?? 0
              const audience = questionOrigin(sessionId, events, state.sessions)
              for (const event of events.filter(e => e.seq > start && e.type === 'user/message' && e.data.source.kind === 'user')) {
                if (questionOrigin(sessionId, events.filter(e => e.seq <= event.seq), state.sessions)?.id !== audience?.id) throw Error('不能跨回复对象导出工作报告')
              }
            }
            const document = replyDocument(input.document, input.workReport, events)
            documentCwd = await mkdtemp(join(tmpdir(), 'partner-reply-document-'))
            await writeFile(join(documentCwd, document.name), document.content, {mode: 0o600})
            documentPath = join(documentCwd, document.name)
          }
          item = typeof input.deliveryId === 'string' ? service.get(input.deliveryId) : await service.serial('prepare',()=>service.prepare({companionId,sessionId,turn:origin?.seq??agent.session.seq,cwd:documentCwd??cwd,path:documentPath??input.path as string,channel,...(source?{channelRouteId:source.id}:{})},exec.signal))
        } finally { if (documentCwd) await rm(documentCwd, {recursive:true,force:true}) }

        if (!item || item.companionId!==companionId || item.sessionId!==sessionId) throw new Error('附件交付不存在或不属于当前伙伴会话')
        // Only the live task executor may register deliverables, never a reviewer.
        if (origin && isInternalTaskNotice(origin) && state.delegations?.some(d => d.status === 'running' && (d.kind ?? 'task') === 'task' && d.toCompanionId === companionId && d.executionSessionId === sessionId)) {
          await store.update(state => {
            const runs = state.delegations.filter(d => d.status === 'running' && (d.kind ?? 'task') === 'task' && d.toCompanionId === companionId && d.executionSessionId === sessionId)
            if (runs.length !== 1) return
            const task = state.tasks.find(t => t.id === runs[0]!.taskId && t.assigneeCompanionId === companionId && t.status === 'doing')
            if (!task) return
            task.resultAttachmentIds = [...new Set([...(task.resultAttachmentIds ?? []), item!.id])]
          })
        }
        if (!channel && item.channel!=='none') throw new Error('当前执行不能向原渠道重发附件，请回到直接对话重试')
        if (channel && item.channel==='none' && typeof input.deliveryId==='string') throw new Error('这份附件原本仅供会话查看。若要正式发送到渠道，请使用 path 明确提交原文件')
        if(channel&&item.channelRouteId!==source?.id)throw new Error('附件原始投递渠道与当前来源不一致，请回到原渠道重试；旧版未记录目标的附件请用 path 重新提交')
        const url=`${prefix.replace(/\/$/,'')}/attachments/${item.id}`
        const escaped=item.name.replace(/[\[\]\\]/g,'_')
        const content: ContentBlock[]=[{type:'text',text:`[下载附件：${escaped}](${url})`}]
        if(item.kind==='image') {
          const ref=await ctx.attachments.saveImage({data:await service.bytes(item),mediaType:item.mediaType as ImageMediaType,name:item.name})
          content.push({type:'image',attachment:ref})
        }
        if (input.document !== undefined || input.workReport !== undefined) {
          exec.signal.throwIfAborted()
          const current = store.snapshot(), currentEvents = agent.session.snapshotEvents()
          const latestUser = (es: typeof events) => [...es].reverse().find(e => e.type === 'user/message' && e.data.source.kind === 'user')?.seq
          if (store.isCompanionRemoving(companionId) || !current.companions.some(c => c.id === companionId) ||
            continuationChannelOrigin(current, companionId, sessionId, currentEvents)?.id !== source?.id || latestUser(currentEvents) !== latestUser(events)) throw Error('回复来源已变化，文档已保存但未向旧来源发送')
        }
        let error: string | undefined
        try { item=await service.deliver(item,file=>channels.sendExplicitAttachment(sessionId,file,exec.signal,item!.channelRouteId)) }
        catch (cause) { error=cause instanceof Error?cause.message:String(cause) }
        const status=item.channel==='sent'?'渠道附件已发送':item.channel==='none'?'仅交付到当前会话':`渠道发送未完成，请用 deliveryId 重试：${item.id}`
        content.push({type:'text',text:status})
        exec.deferContext(createUserMessage({source:{kind:'plugin:@lemoncat7/dsh-partner',plugin:'@lemoncat7/dsh-partner',form:'notice',summary:'伙伴附件交付'},content}))
        return JSON.stringify({deliveryId:item.id,name:item.name,conversation:'attachment_recorded',channel:item.channel,...(source?{originRouteId:source.id}:{}),...(input.workReport!==undefined?{reportRunIds:(input.workReport as {runIds:string[]}).runIds}:{}),...(error?{error,retry:{deliveryId:item.id}}:{})})
      })
    },
  }
}
