import { validateAgreements, type TemporaryAgreement } from './chat/agreements.js'
import { fatigueValue } from './character/fatigue.js'
import { applyIdentity } from './companions/identity.js'
import { affectionEnabled, affectionProgress } from './character/affection.js'
import { StickerLibrary } from './chat/stickers.js'
import { dispatchStickersApi } from './api/features/stickers-api.js'
import { idleContactRouteAllowed } from './character/idle-contact.js'
import { previewCharacter } from './character/preview.js'
import { randomBytes, randomUUID } from 'node:crypto'
import { conversationMemoryScope } from './memory-scope.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentPresetRegistry as AgentPresets } from '@deepseek-ai/dsh-agent-preset-registry'
import { normalizeAutomation, normalizeCompanionDraft, text, type ChannelView, type Companion } from './domain.js'
import { PartnerStore } from './store.js'
import { PartnerCredentialVault } from './credentials.js'
import { ChannelManager, requiredCompanion } from './channels/manager.js'
import { WeixinLoginManager } from './channels/weixin/login.js'
import { connectWeixin } from './channels/weixin/connect.js'
import { DirectTransport, directConfig } from './channels/direct/transport.js'
import { DirectLoginCache } from './channels/direct/login-cache.js'
import { memoryScope, PartnerAgentRuntime } from './agent-runtime.js'
import { PartnerMemoryStore } from './memory-store.js'
import { HeartbeatScheduler } from './heartbeat.js'
import { DailyReviewScheduler } from './daily-review.js'
import { PartnerConcernStore } from './concern-store.js'
import type { SkillService } from './skills/service.js'
import type { TaskBoardService } from './tasks/service.js'
import type { RequirementService } from './requirements/service.js'
import type { PartnerCollaborationService } from './collaboration/service.js'
import type { PartnerSchedulerService } from './scheduler/service.js'
import type { CompanionService } from './companions/service.js'
import { dispatchPartnerWorkspaceApi } from './api/features/workspace-api.js'
import { dispatchPendantApi } from './api/features/pendant-api.js'
import { dispatchMemoryLayersApi } from './api/features/memory-layers-api.js'
import type { AttachmentDeliveryService } from './attachments/service.js'
import { dispatchAttachmentsApi } from './api/features/attachments-api.js'
import type { PartnerInboxStore } from './notifications/store.js'
import { assertSameOrigin, httpError, mutation, readObject, sendError, sendJson } from './api/http.js'
import type { StorageCoordinator } from './storage/coordinator.js'
import type { McpService } from './mcp/service.js'
import { dispatchMcpApi } from './api/features/mcp-api.js'
import { dispatchPushApi } from './api/features/push-api.js'
import type { PushService } from './notifications/push-service.js'

export interface WebServerLike {
  register(route: { kind: 'prefix'; path: string; handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }): () => void
}
const loginCaches=new WeakMap<PartnerStore,DirectLoginCache>()
function loginCache(store:PartnerStore):DirectLoginCache {
  let cache=loginCaches.get(store)
  if(!cache){cache=new DirectLoginCache();loginCaches.set(store,cache)}
  return cache
}

interface ApiRuntime {
  sleep?: import('./character/sleep-service.js').SleepService
  stickers?: StickerLibrary
  push?: PushService
  concernExecution?: import('./concern-execution.js').ConcernExecutionDispatcher
  mcp?: McpService
  ctx: Context & { agentPresets: AgentPresets }
  store: PartnerStore
  credentials: PartnerCredentialVault
  channels: ChannelManager
  agents: PartnerAgentRuntime
  login: WeixinLoginManager
  memory: PartnerMemoryStore
  concerns: PartnerConcernStore
  heartbeat: HeartbeatScheduler
  dailyReview: DailyReviewScheduler
  skills: SkillService
  tasks: TaskBoardService
  requirements?: RequirementService
  collaboration: PartnerCollaborationService
  scheduler: PartnerSchedulerService
  companions: CompanionService
  inbox: PartnerInboxStore
  deliveries?: AttachmentDeliveryService
  storage?: StorageCoordinator
}

export function registerPartnerApi(webServer: WebServerLike, prefix: string, runtime: ApiRuntime): () => void {
  return webServer.register({
    kind: 'prefix', path: prefix,
    handler: async (req, res) => {
      let release:(()=>void)|undefined
      try {
        assertSameOrigin(req)
        if(req.method==='GET'&&new URL(req.url??'/', 'http://partner.local').pathname===`${prefix}/storage/status`) {
          if(!runtime.storage)throw httpError(503,'存储服务不可用')
          return sendJson(res,200,await runtime.storage.status())
        }
        if(runtime.storage?.running)throw httpError(503,'伙伴正在升级迁移，请稍后刷新')
        release=runtime.storage?.enterRequest()
        await dispatch(req, res, prefix, runtime)
      } catch (error) { sendError(res, error) } finally { release?.() }
    },
  })
}

async function dispatch(req: IncomingMessage, res: ServerResponse, prefix: string, runtime: ApiRuntime): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://partner.local')
  const relative = url.pathname.slice(prefix.length).replace(/^\/+|\/+$/g, '')
  const segments = relative ? relative.split('/').map(decodeURIComponent) : []
  const method = req.method ?? 'GET'
  if (runtime.push && await dispatchPushApi(req, res, segments, runtime.push)) return
  if (runtime.mcp && await dispatchMcpApi(req, res, segments, runtime.mcp)) return
  if(method==='GET'&&segments.length===2&&segments[0]==='storage'&&segments[1]==='status') {
    if(!runtime.storage)throw httpError(503,'存储服务不可用')
    return sendJson(res,200,await runtime.storage.status())
  }
  if (segments.length === 2 && segments[0] === 'storage' && segments[1] === 'migrate') {
    if(method!=='POST')throw httpError(405,'请使用升级迁移按钮提交')
    mutation(req)
    if(!runtime.storage)throw httpError(503,'存储迁移服务不可用')
    const body=await readObject(req)
    if(body.confirm!==true||body.expectedVersion!==0)throw httpError(400,'请确认备份与目录迁移，重新检查当前版本')
    runtime.storage.start(body.expectedVersion)
    return sendJson(res,202,{accepted:true})
  }
  if (segments.length === 2 && segments[0] === 'storage' && segments[1] === 'cleanup') {
    if(method!=='POST')throw httpError(405,'请使用清理确认按钮')
    mutation(req)
    if(!runtime.storage)throw httpError(503,'存储服务不可用')
    const body=await readObject(req)
    if(body.confirm!==true||body.expectedVersion!==1)throw httpError(400,'请确认已备份的旧路径清理')
    runtime.storage.startCleanup()
    return sendJson(res,202,{accepted:true})
  }
  if (segments.length === 2 && segments[0] === 'storage' && segments[1] === 'inspect') {
    if (method !== 'GET') throw httpError(405, '目前仅支持只读迁移检查，尚未开放执行迁移')
    if (!runtime.storage) throw httpError(503, '存储检查服务不可用')
    return sendJson(res, 200, await runtime.storage.inspect())
  }
  if (segments[0] === 'companions' && segments[1] && runtime.store.isCompanionRemoving(segments[1]) && !(method === 'DELETE' && segments.length === 2)) throw httpError(409, '伙伴正在删除，请稍后刷新')
  if (runtime.stickers && await dispatchStickersApi(req,res,segments,runtime.stickers,runtime.store)) return
  if (await dispatchPendantApi(req, res, segments, runtime.inbox)) return
  if (runtime.deliveries && await dispatchAttachmentsApi(req,res,segments,runtime.deliveries,runtime.store)) return
  if (method === 'GET' && segments[0] === 'health') return sendJson(res, 200, { ok: true, service: 'dsh-partner', schemaVersion: 14 })
  if (method === 'GET' && segments[0] === 'models' && segments.length === 1) {
    const providers = await Promise.all(runtime.ctx.llm.listProviders().map(async provider => ({
      id: provider.id, name: provider.name,
      models: (await runtime.ctx.llm.listModels(provider.id).catch(() => [])).map(model => ({ id: model.id, name: model.name })),
    })))
    return sendJson(res, 200, { providers, defaultSelection: runtime.ctx.agentDefaultModel.currentSelection() })
  }
  if (method === 'GET' && segments.length === 0) return sendJson(res, 200, await snapshot(runtime))
  if (await dispatchPartnerWorkspaceApi(req, res, segments, url, runtime)) return

  if (segments[0] === 'companions') {
    if (method === 'POST' && segments.length === 1) {
      mutation(req)
      const companion = await runtime.companions.create((await readObject(req)).companion)
      return sendJson(res, 201, companion)
    }
    const id = segments[1]
    if (id && method === 'PUT' && segments[2] === 'notifications' && segments.length === 3) {
      mutation(req)
      const body = await readObject(req)
      if (body.mode !== 'recent' && body.mode !== 'selected') throw httpError(400, '请选择通知方式')
      if (!Array.isArray(body.targetPairingIds) || body.targetPairingIds.length > 50 || body.targetPairingIds.some(x => typeof x !== 'string')) throw httpError(400, '通知接收人无效')
      const ids = [...new Set(body.targetPairingIds as string[])]
      if (body.mode === 'selected' && !ids.length) throw httpError(400, '请至少选择一个通知接收人')
      await runtime.store.update(state => {
        const companion = state.companions.find(c => c.id === id)
        if (!companion) throw httpError(404, '伙伴不存在')
        const targets = body.mode === 'recent' ? [] : ids.map(pairingId => {
          const pairing = state.pairings.find(p => p.id === pairingId && p.status === 'approved')
          if (!pairing || !state.channels.some(c => c.id === pairing.channelId && c.companionId === id && c.enabled)) throw httpError(400, '请选择本伙伴已启用渠道中的已授权接收人')
          return { channelId: pairing.channelId, userId: pairing.userId }
        })
        companion.notificationDelivery = { mode: body.mode as 'recent' | 'selected', targets }
        companion.updatedAt = Date.now()
      })
      return sendJson(res, 200, {ok: true})
    }
    if (id !== undefined && method === 'POST' && segments[2] === 'session' && segments.length === 3) {
      mutation(req)
      requiredCompanion(runtime.store, id)
      const route = await runtime.agents.createLocalSession(id)
      return sendJson(res, 201, { routeId: route.id, sessionId: route.sessionId })
    }
    if (id && segments[2] === 'character' && segments.length === 4) {
      const companion = requiredCompanion(runtime.store, id)
      if(segments[3]==='affection'&&method==='GET')return sendJson(res,200,{...affectionProgress(companion.affection),enabled:affectionEnabled(companion),review:companion.interactionReview?.affection})
      if (segments[3] === 'preview' && method === 'POST') {
        mutation(req)
        return sendJson(res, 200, await previewCharacter(runtime.ctx, companion, await readObject(req)))
      }
      if (segments[3] === 'state') {
        const routes = runtime.store.snapshot().sessions.filter(r => r.companionId === id)
        const scopeId = url.searchParams.get('scopeId') ?? (routes[0] ? conversationMemoryScope(routes.find(r => r.kind === 'local') ?? routes[0], routes) : '')
        const scopes = [...new Set(routes.map(r => conversationMemoryScope(r, routes)))]
        if (!scopeId || !scopes.includes(scopeId)) throw httpError(400, '请选择本伙伴的会话')
        if (method === 'GET') return sendJson(res, 200, { state: await runtime.memory.characterState(id, scopeId), scopeId, scopes })
        if (method === 'PUT') {
          mutation(req); const body = await readObject(req)
          if (typeof body.expectedAt !== 'number') throw httpError(400, '缺少相处状态版本，请刷新')
          return sendJson(res, 200, { state: await runtime.memory.saveCharacterState(id, scopeId, body.state, body.expectedAt), scopeId, scopes })
        }
      }
    }
    if (id && segments[2] === 'memory' && segments[3] === 'renewal' && segments.length === 4 && method === 'GET') {
      requiredCompanion(runtime.store, id)
      return sendJson(res, 200, { items: await runtime.memory.renewalStatus(id), status: runtime.dailyReview.renewalStatus(id) })
    }
    if (id && segments[2] === 'sleep' && segments.length === 3) {
      const c = requiredCompanion(runtime.store, id)
      if (method === 'GET') return sendJson(res, 200, { state: c.sleepState ?? {}, fatigue: fatigueValue(c), serverNow: Date.now() })
      if (method === 'POST') {
        mutation(req)
        if (!runtime.sleep) throw httpError(503, '睡眠服务未就绪')
        if ((await readObject(req)).action !== 'wake') throw httpError(400, '睡眠操作无效')
        await runtime.sleep.wake(id, '用户唤醒')
        return sendJson(res, 200, { ok: true })
      }
    }
    if (id && segments[2] === 'agreements' && segments.length === 3) {
      if(method==='GET')return sendJson(res,200,{agreements:requiredCompanion(runtime.store,id).temporaryAgreements??[]})
      if(method==='PUT'){
        mutation(req)
        const body=await readObject(req)
        if(!Array.isArray(body.agreements)||!Array.isArray(body.expectedAgreements))throw httpError(400,'需要约定列表和旧版本列表')
        validateAgreements(body.agreements)
        const saved=await runtime.store.update(state=>{
          const c=state.companions.find(c=>c.id===id);if(!c)throw httpError(404,'伙伴不存在')
          if(JSON.stringify(c.temporaryAgreements??[])!==JSON.stringify(body.expectedAgreements))throw httpError(409,'约定已变化，请刷新后重试')
          c.temporaryAgreements=structuredClone(body.agreements) as TemporaryAgreement[]
        })
        return sendJson(res,200,{agreements:saved.companions.find(c=>c.id===id)!.temporaryAgreements})
      }
    }
    if (id && method === 'PUT' && segments[2] === 'identity' && segments.length === 3) {
      mutation(req)
      const body = await readObject(req)
      const saved = await runtime.store.update(state => {
        const companion = state.companions.find(c => c.id === id)
        if (!companion) throw httpError(404, '伙伴不存在')
        applyIdentity(state, companion, body.identity, body.expectedAt, 'page')
      })
      return sendJson(res, 200, saved.companions.find(c => c.id === id))
    }
    if (id !== undefined && method === 'PUT' && segments.length === 2) {
      mutation(req)
      const draft = normalizeCompanionDraft((await readObject(req)).companion)
      const saved = await runtime.store.update(state => {
        const previous = state.companions.find(item => item.id === id)
        if (!previous) throw httpError(404, '伙伴不存在')
        const next: Companion = { ...draft, ...(previous.thoughts?{thoughts:previous.thoughts}:{}), ...(previous.interactionReview?{interactionReview:previous.interactionReview}:{}), ...(previous.personaHistory?{personaHistory:previous.personaHistory}:{}), ...(previous.temporaryAgreements?{temporaryAgreements:previous.temporaryAgreements}:{}), ...(previous.affection ? {affection:previous.affection} : {}), ...(draft.toolDiscovery===undefined&&previous.toolDiscovery!==undefined?{toolDiscovery:previous.toolDiscovery}:{}), ...(draft.relationshipText === undefined && previous.relationshipText !== undefined ? {relationshipText:previous.relationshipText} : {}), ...(previous.sleepState ? {sleepState:previous.sleepState} : {}), ...(draft.sleepPolicy === undefined && previous.sleepPolicy ? {sleepPolicy:previous.sleepPolicy} : {}), ...(draft.idleContact === undefined && previous.idleContact ? {idleContact:previous.idleContact} : {}), ...(draft.characterCard === undefined && previous.characterCard ? {characterCard: previous.characterCard} : {}), ...(previous.notificationDelivery ? {notificationDelivery: previous.notificationDelivery} : {}), automation: previous.automation, id, createdAt: previous.createdAt, updatedAt: Math.max(Date.now(), previous.updatedAt + 1) }
        if (next.idleContact?.enabled && !idleContactRouteAllowed(state, next, next.idleContact.routeId)) throw httpError(400, '请选择本伙伴可用的会话；渠道联系人须已授权')
        state.companions = state.companions.map(item => item.id === id ? next : item)
      })
      const next = saved.companions.find(item => item.id === id)!
      return sendJson(res, 200, next)
    }
    if (id !== undefined && method === 'DELETE' && segments.length === 2) {
      mutation(req)
      const removeFiles = url.searchParams.get('removeFiles')
      if (removeFiles !== null && removeFiles !== '0' && removeFiles !== '1') throw httpError(400, 'removeFiles 必须为 0 或 1')
      await runtime.companions.remove(id, {
        removeChannels: async target => {
          await runtime.push?.removeOwner(target)
          const owned = runtime.store.snapshot().channels.filter(channel => channel.companionId === target)
          for (const channel of owned) {
            await runtime.channels.stop(channel.id)
            await runtime.credentials.delete(channel.id)
          }
        },
        isBusy: target => runtime.agents.isCompanionBusy(target) || runtime.heartbeat.isRunning(target) || runtime.dailyReview.isRunning(target),
        validateDirectory: target => runtime.agents.validateCompanionDirectory(target),
        ...(removeFiles === '1' ? { removeDirectory: async (target: string) => { runtime.inbox.releaseOwner(target); await runtime.deliveries?.removeOwner(target); await runtime.agents.removeCompanionDirectory(target) } } : {}),
        detachWorkspace: target => runtime.agents.removeCompanionWorkspace(target),
        resetSessions: target => runtime.agents.resetCompanion(target),
        clearMemory: target => runtime.memory.clear(target),
        clearConcerns: target => runtime.concerns.clear(target),
      })
      return sendJson(res, 204, undefined)
    }
    if (id !== undefined && method === 'PUT' && segments[2] === 'automation' && segments.length === 3) {
      mutation(req)
      requiredCompanion(runtime.store, id)
      const automation = normalizeAutomation((await readObject(req)).automation)
      await runtime.store.update(state => {
        const target = state.companions.find(item => item.id === id)
        if (target) { target.automation = automation; target.updatedAt = Date.now() }
        state.heartbeatStates = state.heartbeatStates.filter(item => item.companionId !== id)
        if (automation.heartbeat.enabled) state.heartbeatStates.push({
          companionId: id,
          nextCheckAt: Date.now() + automation.heartbeat.intervalMinutes * 60_000,
          sentDay: localDay(Date.now()), sentCount: 0, consecutiveFailures: 0,
        })
      })
      return sendJson(res, 200, { automation })
    }
    if (id !== undefined && segments[2] === 'memory') {
      requiredCompanion(runtime.store, id)
      const memoryRoutes = runtime.store.snapshot().sessions.filter(item => item.companionId === id)
      const requestedMemoryScope = url.searchParams.get('scopeId')
      const memoryRoute = memoryRoutes.find(item => memoryScope(item.channelId, item.userId) === requestedMemoryScope)
      if (memoryRoute) url.searchParams.set('scopeId', conversationMemoryScope(memoryRoute, memoryRoutes))
      if (await dispatchMemoryLayersApi(req, res, url, segments, runtime.memory, id)) return
      if (method === 'GET' && segments.length === 3) {
        const state = runtime.store.snapshot()
        const routes = state.sessions.filter(item => item.companionId === id)
        const scopes = [...new Set(routes.map(item => conversationMemoryScope(item, routes)))]
        const scopeId = url.searchParams.get('scopeId') ?? undefined
        const [memories, reflections, profiles] = await Promise.all([
          runtime.memory.recentMemories(id, 100, scopeId), scopeId === undefined ? runtime.memory.recentReflections(id, 30) : runtime.memory.recentReflectionsForScope(id, scopeId, 30), runtime.memory.profileSnapshots(id, scopes),
        ])
        return sendJson(res, 200, {
          memories, reflections,
          profiles: profiles.map(profile => {
            const route = routes.find(item => memoryScope(item.channelId, item.userId) === profile.scopeId)
            const pairing = route && state.pairings.find(item => item.channelId === route.channelId && item.userId === route.userId)
            return { ...profile, label: route?.kind === 'local' ? '统一会话记忆' : pairing?.displayName || route?.userId || '历史联系人' }
          }),
        })
      }
      const memoryId = segments[3]
      if (method === 'PUT' && memoryId !== undefined && segments.length === 4) {
        mutation(req)
        const body = await readObject(req)
        return sendJson(res, 200, await runtime.memory.updateMemory(id, memoryId, text(body.subject, 'subject', 120), text(body.content, 'content', 800)))
      }
      if (method === 'DELETE' && memoryId !== undefined && segments.length === 4) {
        mutation(req)
        await runtime.memory.deleteMemory(id, memoryId)
        return sendJson(res, 204, undefined)
      }
    }
    if (id !== undefined && segments[2] === 'concerns') {
      requiredCompanion(runtime.store, id)
      if (method === 'GET' && segments.length === 3) return sendJson(res, 200, {...await runtime.concerns.activity(id), executions: (runtime.store.snapshot().concernExecutions ?? []).filter(r=>r.companionId===id)})
      if (method === 'POST' && segments.length === 5 && segments[4] === 'retry-execution') {
        mutation(req)
        const body = await readObject(req)
        if(body.mode==='recover') {
          if(!runtime.concernExecution)throw httpError(503,'执行恢复服务不可用')
          if(typeof body.executionId!=='string' || !body.executionId || !Number.isSafeInteger(body.expectedUpdatedAt))throw httpError(400,'缺少执行标识或状态版本')
          try {await runtime.concernExecution.recover(id,segments[3]!,body.executionId,body.expectedUpdatedAt as number)}catch(error){throw httpError(409,error instanceof Error?error.message:'恢复失败')}
          return sendJson(res,202,{ok:true,reason:'已请求恢复：先核对已有产物，再继续缺失步骤；不是从头重跑'})
        }
        await runtime.store.update(s => {
          const receipt=s.concernExecutions?.find(r=>r.id===body.executionId && r.companionId===id && r.concernId===segments[3])
          if(!receipt || !['failed','completed'].includes(receipt.status)) throw httpError(409, '执行不存在或仍在进行中')
          receipt.status='pending';receipt.updatedAt=Date.now();delete receipt.error
          if(body.checkResultOnly === true) receipt.reconcileOnly=true
          else {receipt.messageId=randomUUID();delete receipt.reconcileOnly}
        })
        return sendJson(res,200,{ok:true})
      }
      if (method === 'GET' && segments.length === 4 && segments[3] === 'archived') {
        const offset = Number(url.searchParams.get('offset') ?? 0)
        if (!Number.isSafeInteger(offset) || offset < 0) throw httpError(400, '分页参数无效')
        return sendJson(res, 200, await runtime.concerns.archived(id, offset))
      }
      if (method === 'DELETE' && segments.length === 4 && segments[3]) {
        mutation(req)
        const body = await readObject(req)
        if (!Number.isSafeInteger(body.expectedUpdatedAt)) throw httpError(400, '请刷新后重新确认删除')
        await runtime.heartbeat.removeConcern(id, segments[3], body.expectedUpdatedAt as number)
        return sendJson(res, 200, {ok: true})
      }
      if (method === 'PATCH' && segments.length === 4 && segments[3]) {
        mutation(req)
        const body = await readObject(req)
        if (!Number.isSafeInteger(body.expectedUpdatedAt)) throw httpError(400, '缺少关注版本，请刷新后重试')
        if (typeof body.reason !== 'string' || body.reason.length > 800 || typeof body.sources !== 'string' || body.sources.length > 4000) throw httpError(400, '关注说明或依据格式无效')
        const recordTarget = await runtime.agents.validateRecordingTarget(requiredCompanion(runtime.store, id), body.recordTarget)
        return sendJson(res, 200, await runtime.concerns.editExplicit(id, segments[3], {subject:text(body.subject, 'subject', 300), reason:body.reason, sources:body.sources, ...(body.executionInstructions === undefined ? {} : {executionInstructions: body.executionInstructions as string | null}), expectedUpdatedAt:body.expectedUpdatedAt as number, ...(recordTarget ? {recordTarget} : {})}))
      }
      if (method === 'POST' && segments.length === 3) {
        mutation(req)
        const body = await readObject(req)
        const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 800) : ''
        const recordTarget = await runtime.agents.validateRecordingTarget(requiredCompanion(runtime.store, id), body.recordTarget)
        return sendJson(res, 201, await runtime.concerns.createExplicit(id, '*', text(body.subject, 'subject', 300), reason, recordTarget, body.executionInstructions as string | null | undefined))
      }
      if (method === 'POST' && segments[3] !== undefined && segments[4] === 'action' && segments.length === 5) {
        mutation(req)
        const body = await readObject(req)
        const action = text(body.action, 'action', 20)
        if (body.expectedUpdatedAt !== undefined && !Number.isSafeInteger(body.expectedUpdatedAt)) throw httpError(400, '关注版本无效')
        if (action !== 'watch' && action !== 'ignore' && action !== 'prioritize' && action !== 'resolve') throw httpError(400, 'concern action is invalid')
        await runtime.concerns.act(id, segments[3], action, Date.now(), body.expectedUpdatedAt as number | undefined)
        return sendJson(res, 200, { ok: true })
      }
    }
    if (id !== undefined && method === 'GET' && segments[2] === 'concern-sources' && segments.length === 3) {
      const companion = requiredCompanion(runtime.store, id)
      const query = (url.searchParams.get('q') ?? '').trim().slice(0, 160)
      return sendJson(res, 200, { items: await runtime.agents.concernSources(companion, query) })
    }
    if (id !== undefined && method === 'GET' && segments[2] === 'recording-sources' && segments.length === 3) {
      return sendJson(res, 200, { items: await runtime.agents.recordingSources(requiredCompanion(runtime.store, id), (url.searchParams.get('q') ?? '').slice(0, 160)) })
    }
    if (id !== undefined && method === 'POST' && segments[2] === 'heartbeat' && segments[3] === 'trigger' && segments.length === 4) {
      mutation(req)
      requiredCompanion(runtime.store, id)
      const body = await readObject(req)
      const concernId = typeof body.concernId === 'string' ? body.concernId.trim().slice(0, 160) : undefined
      return sendJson(res, 202, runtime.heartbeat.startManual(id, concernId))
    }
    if (id !== undefined && method === 'GET' && segments[2] === 'heartbeat' && segments[3] === 'status' && segments.length === 4) {
      requiredCompanion(runtime.store, id)
      return sendJson(res, 200, runtime.heartbeat.manualStatus(id))
    }
    if (id !== undefined && method === 'POST' && segments[2] === 'memory' && segments[3] === 'review' && segments.length === 4) {
      mutation(req); requiredCompanion(runtime.store, id)
      return sendJson(res, 200, await runtime.dailyReview.trigger(id, true))
    }
    if (id !== undefined && method === 'GET' && segments[2] === 'memory' && segments[3] === 'graph' && segments.length === 4) {
      requiredCompanion(runtime.store, id)
      return sendJson(res, 200, await runtime.memory.relations(id))
    }
  }

  if (segments[0] === 'weixin' && segments[1] === 'login') {
    if (method === 'POST' && segments.length === 2) {
      mutation(req)
      const body = await readObject(req)
      const companionId = text(body.companionId, 'companionId', 120)
      requiredCompanion(runtime.store, companionId)
      const channelId = body.channelId === undefined ? undefined : text(body.channelId, 'channelId', 120)
      if (channelId && !runtime.store.snapshot().channels.some(c => c.id === channelId && c.companionId === companionId && (!c.platform || c.platform === 'weixin'))) throw httpError(404, '指定微信渠道不存在或不属于此伙伴')
      return sendJson(res, 201, await runtime.login.begin(companionId, channelId))
    }
    const loginId = segments[2]
    if (method === 'GET' && loginId !== undefined && segments.length === 3) {
      const login = await runtime.login.poll(loginId)
      if (login.phase !== 'confirmed') return sendJson(res, 200, { login })
      const channel = await runtime.login.complete(loginId, confirmed => connectWeixin(confirmed, runtime))
      return sendJson(res, 200, { login, channel })
    }
  }

  if (segments[0] === 'channels') {
    if(method==='GET'&&segments[1]==='status'&&segments.length===2)return sendJson(res,200,{channels:await runtime.channels.views(),pairings:runtime.store.snapshot().pairings})
    if (method === 'POST' && (segments.length === 1 || (segments.length === 2 && segments[1] === 'test'))) {
      mutation(req)
      const body = await readObject(req)
      const companionId = text(body.companionId, 'companionId', 120)
      requiredCompanion(runtime.store, companionId)
      if (runtime.store.isCompanionRemoving(companionId)) throw httpError(409, '伙伴正在删除')
      const config = directConfig(body)
      if(body.authMode!==undefined&&body.authMode!=='password'&&body.authMode!=='token')throw httpError(400,'登录方式无效')
      const login=body.authMode==='password'?await loginCache(runtime.store).acquire(companionId,config,{username:body.username,password:body.password,...(body.mfaToken?{mfaToken:body.mfaToken}:{})}):undefined
      const botToken=login?.token??text(body.botToken,'botToken',8192)
      const adapter = new DirectTransport(config, botToken)
      try {
        const identity = await adapter.validate()
        if (segments[1] === 'test') {
          return sendJson(res, 200, {ok: true, ...identity})
        }
        const baseline = config.platform === 'qq' ? {cursor:'onebot-live'} : await adapter.poll(undefined, AbortSignal.timeout(35_000))
        if (config.platform !== 'qq') await new DirectTransport(config, botToken, identity).validate()
        const now = Date.now()
        const channel = {id:createId(config.platform),companionId,platform:config.platform,accountId:identity.accountId,
          name:text(body.name, 'name', 80),enabled:false,createdAt:now,updatedAt:now,
          direct:{baseUrl:config.baseUrl,targetId:config.targetId,peerId:identity.peerId,cursor:baseline.cursor}}
        await runtime.credentials.write(channel.id,{baseUrl:config.baseUrl,botToken})
        try {
          await runtime.store.update(state=>{
            if(state.channels.some(c=>c.platform===config.platform&&c.accountId===identity.accountId&&c.direct?.baseUrl===config.baseUrl))throw httpError(409,'此机器人已配置，请先管理现有渠道，不能绑定到另一个伙伴')
            if(!state.companions.some(c=>c.id===companionId))throw httpError(409,'伙伴已不存在')
            state.channels.push(channel)
            if(identity.peerId)state.pairings.push({id:createId('pairing'),channelId:channel.id,userId:identity.peerId,displayName:identity.peerId,directTargetId:config.targetId,status:'pending',createdAt:now,updatedAt:now})
          })
        } catch(error) {await runtime.credentials.delete(channel.id);throw error}
        login?.retain()
        return sendJson(res,201,{channel})
      } finally { adapter.close() }
    }
    const id = segments[1]
    if(id&&segments[2]==='qq'&&segments.length===4) {
      if(method==='GET'&&segments[3]==='voices')return sendJson(res,200,await runtime.channels.qqVoices(id,url.searchParams.get('groupId')??''))
      if(method==='GET'&&(segments[3]==='groups'||segments[3]==='friends'||segments[3]==='faces'))return sendJson(res,200,await runtime.channels.qqDirectory(id,segments[3]))
      if(method==='POST'&&segments[3]==='connection') {
        mutation(req);const body=await readObject(req)
        if(typeof body.expectedUpdatedAt!=='number'||typeof body.testOnly!=='boolean')throw httpError(400,'连接参数无效')
        await runtime.channels.updateQqConnection(id,{baseUrl:text(body.baseUrl,'WS 地址',2000),...(body.botToken?{botToken:text(body.botToken,'WS Token',8192)}:{}),testOnly:body.testOnly,expectedUpdatedAt:body.expectedUpdatedAt})
        return sendJson(res,200,{ok:true})
      }
      if(method==='POST'&&segments[3]==='settings') {
        mutation(req);const body=await readObject(req)
        if(typeof body.expectedUpdatedAt!=='number')throw httpError(400,'缺少配置版本，请刷新重试')
        await runtime.channels.updateQq(id,body.settings,body.expectedUpdatedAt)
        return sendJson(res,200,{ok:true})
      }
      if(method==='POST'&&segments[3]==='send') {
        mutation(req);const body=await readObject(req),userId=text(body.userId,'接收人',120)
        if([body.text,body.faceId,body.customFaceId].filter(value=>value!==undefined).length!==1)throw httpError(400,'每次请选择发送文字或表情')
        const input=body.customFaceId!==undefined?{customFaceId:text(body.customFaceId,'收藏表情标识',512)}:body.faceId!==undefined?{faceId:text(body.faceId,'表情编号',6)}:{text:text(body.text,'消息',3000)}
        await runtime.channels.sendManualQq(id,userId,input)
        return sendJson(res,200,{sent:true})
      }
    }
    if (id !== undefined && method === 'POST' && segments[2] === 'enabled' && segments.length === 3) {
      mutation(req)
      const body = await readObject(req)
      if (typeof body.enabled !== 'boolean') throw httpError(400, 'enabled must be boolean')
      await runtime.channels.setEnabled(id, body.enabled)
      return sendJson(res, 200, { ok: true })
    }
    if (id !== undefined && method === 'DELETE' && segments.length === 2) {
      mutation(req)
      await runtime.channels.delete(id)
      return sendJson(res, 204, undefined)
    }
  }

  if (segments[0] === 'pairings') {
    const id = segments[1]
    if (id && method==='POST' && segments[2]==='delivery' && segments.length===3) {
      mutation(req)
      const body=await readObject(req)
      if(typeof body.contactKey!=='string'||body.contactKey.length>80)throw httpError(400,'联系人关联标识无效')
      if(body.targetPairingId!==null&&typeof body.targetPairingId!=='string')throw httpError(400,'通知目标无效')
      await runtime.store.update(state=>{
        const source=state.pairings.find(p=>p.id===id&&p.status==='approved')
        if(!source)throw httpError(404,'已授权联系人不存在')
        const companion=state.channels.find(c=>c.id===source.channelId)?.companionId
        if(body.targetPairingId!==null) {
          const target=state.pairings.find(p=>p.id===body.targetPairingId&&p.status==='approved')
          if(!target||!state.channels.some(c=>c.id===target.channelId&&c.companionId===companion))throw httpError(400,'只能选择同一伙伴的已授权通知目标')
          source.deliveryTarget={channelId:target.channelId,userId:target.userId}
        } else delete source.deliveryTarget
        if((body.contactKey as string).trim())source.contactKey=(body.contactKey as string).trim()
        else delete source.contactKey
        source.updatedAt=Date.now()
      })
      return sendJson(res,200,{ok:true})
    }
    if (id !== undefined && method === 'POST' && segments[2] === 'status' && segments.length === 3) {
      mutation(req)
      const status = text((await readObject(req)).status, 'status', 20)
      if (status !== 'approved' && status !== 'blocked') throw httpError(400, 'pairing status is invalid')
      const pairing = runtime.store.snapshot().pairings.find(item => item.id === id)
      if (pairing === undefined) throw httpError(404, '配对请求不存在')
      await runtime.store.update(state => {
        const target = state.pairings.find(item => item.id === id)
        if (target) { target.status = status; target.updatedAt = Date.now() }
      })
      return sendJson(res, 200, { ok: true })
    }
  }
  if (segments[0] === 'sessions') {
    const id = segments[1]
    if (id !== undefined && method === 'POST' && segments[2] === 'prepare' && segments.length === 3) {
      mutation(req)
      const route = await runtime.agents.prepareSession(id)
      return sendJson(res, 200, { sessionId: route.sessionId })
    }
    if (id !== undefined && method === 'POST' && segments[2] === 'renew' && segments.length === 3) {
      mutation(req)
      const route = await runtime.agents.renewSession(id)
      await runtime.agents.prepareSession(route.id)
      return sendJson(res, 201, { routeId: route.id, sessionId: route.sessionId })
    }
  }
  throw httpError(404, 'Partner API route was not found')
}

async function snapshot(runtime: ApiRuntime): Promise<{
  pushChannels: import('./notifications/push-domain.js').PushChannelView[]
  companions: Companion[]; channels: ChannelView[]; pairings: ReturnType<PartnerStore['snapshot']>['pairings']; sessions: ReturnType<PartnerStore['snapshot']>['sessions']; heartbeatStates: ReturnType<PartnerStore['snapshot']>['heartbeatStates']; presets: { id: string; name: string; broken?: string }[]
}> {
  const state = runtime.store.snapshot()
  const presets = await runtime.ctx.agentPresets.list().then(items => items.map(item => ({
    id: item.id,
    name: item.name ?? item.id,
    ...(item.broken ? { broken: item.broken } : {}),
  }))).catch(() => [])
  const sessions = state.sessions.map(item => ({ ...item, archived: runtime.agents.isArchived(item) }))
  return { companions: state.companions, channels: await runtime.channels.views(), pushChannels: runtime.push?.views() ?? [], pairings: state.pairings, sessions, heartbeatStates: state.heartbeatStates, presets }
}

function localDay(now: number): string { const date = new Date(now); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
function createId(prefix: string): string { return `${prefix}-${randomBytes(10).toString('hex')}` }
