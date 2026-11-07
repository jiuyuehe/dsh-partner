import { createChannelActivities } from './channels/activity-defaults.js'
import { ThoughtService } from './character/thoughts.js'
import { InteractionReviewService } from './character/interaction-review.js'
import { agreementTool } from './chat/agreements.js'
import {qqReplyTool} from './channels/qq/reply-tool.js'
import {qqActionTools} from './channels/qq/actions.js'
import { SleepService } from './character/sleep-service.js'
import {ConcernExecutionDispatcher} from './concern-execution.js'
import type { Context } from '@deepseek-ai/cordis'
import { conversationMemoryScope } from './memory-scope.js'
import {PersonaService} from './persona/service.js'
import { dirname, join, resolve } from 'node:path'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { AgentPresetRegistry as AgentPresets } from '@deepseek-ai/dsh-agent-preset-registry'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { Config as ConfigSchema, resolveConfig, type Config as PartnerConfig } from './config.js'
import { PartnerStore } from './store.js'
import { PartnerCredentialVault } from './credentials.js'
import { McpCredentials } from './mcp/credentials.js'
import { McpService } from './mcp/service.js'
import { PartnerAgentRuntime, partnerCwd } from './agent-runtime.js'
import { ChannelManager } from './channels/manager.js'
import { ChannelAvatarService } from './channels/avatar-tool.js'
import { WeixinLoginManager } from './channels/weixin/login.js'
import { registerPartnerApi, type ConnectionAccessLike, type WebServerLike } from './api.js'
import { HeartbeatScheduler } from './heartbeat.js'
import { PartnerMemoryStore } from './memory-store.js'
import { MemoryReflectionService } from './memory-reflection.js'
import { MemoryWorker } from './memory-worker.js'
import { DailyReviewScheduler } from './daily-review.js'
import { PartnerConcernStore, type LegacyConcernSeed } from './concern-store.js'
import { registerPartnerConcernTool } from './concern-tool.js'
import { SkillRepository } from './skills/repository.js'
import { SkillService } from './skills/service.js'
import { TaskBoardService } from './tasks/service.js'
import { createTaskProgressNotifier } from './tasks/progress-notifier.js'
import { BlockedTaskRecovery } from './tasks/blocked-recovery.js'
import { RequirementService } from './requirements/service.js'
import { requirementProgressKey } from './requirements/progress.js'
import { RequirementWorker, requirementSummaryPrompt } from './requirements/worker.js'
import { EphemeralExecutionService } from './execution/service.js'
import { PartnerCollaborationService } from './collaboration/service.js'
import { PartnerSchedulerService } from './scheduler/service.js'
import { PartnerAgentComposition } from './collaboration/composition.js'
import { createSshTaskResolver } from './collaboration/ssh-task-access.js'
import { CompanionService } from './companions/service.js'
import { CompanionManagementService } from './companions/management.js'
import { CompanionKnowledgeMounts } from './companions/knowledge-mounts.js'
import { PartnerInboxStore } from './notifications/store.js'
import { PartnerNoticeService } from './notifications/service.js'
import { PushService } from './notifications/push-service.js'
import { PushCredentials } from './notifications/push-credentials.js'
import { PushObserver } from './notifications/push-observer.js'
import { AttachmentDeliveryService } from './attachments/service.js'
import { openSharedAttachmentStorage } from './attachments/shared-storage.js'
import { StickerLibrary } from './chat/stickers.js'
import { StickerAdapters } from './chat/sticker-adapter.js'
import { qqStickerAdapter } from './channels/qq/sticker-adapter.js'
import type { QqFace } from './channels/qq/catalog.js'
import { chatTools } from './chat/tools.js'
import { attachmentTool } from './attachments/tool.js'
import { StorageCoordinator } from './storage/coordinator.js'
import { storageLayout, TARGET_STORAGE_VERSION } from './storage/layout.js'
import { syncStorageNotice } from './storage/notice.js'
import { readStorageConfig } from './storage/bootstrap.js'
import { SplitStatePersistence } from './storage/split-state.js'
import { acquireStorageLease } from './storage/lease.js'
import { DurableInbox } from './inbox/durable-inbox.js'
import { partnerCodeExecutionTools, reconcileInterruptedCodeExecutions } from './execution/code-execution.js'

export const Config = ConfigSchema
export type Config = PartnerConfig
export * from './domain.js'
export const name = 'dsh-partner'
export const inject = ['credentials', 'attachments', 'agents', 'agentDefaultModel', 'agentPresets', 'settings', 'systemPrompt', 'tools', 'workspaceRegistry', 'llm']

type RuntimeContext = Context & {
  credentials: CredentialProvider
  agentDefaultModel: AgentDefaultModelConfig
  workspaceRegistry: WorkspaceRegistry
  agentPresets: AgentPresets
  tools: ToolRuntime
  webServer?: WebServerLike
  connection?: ConnectionAccessLike
  inject?(services: string[], callback: (ctx: RuntimeContext) => void): unknown
}

export function apply(context: Context, config: PartnerConfig): void {
  const ctx = context as RuntimeContext
  const resolved = resolveConfig(config)
  ctx.effect(async () => {
    const releaseStorageLease=await acquireStorageLease(resolved.statePath)
    try {
    const storageConfig = await readStorageConfig(resolved.statePath,resolved.defaultCwd,resolved.storageVersion ?? 0)
    const layout = storageLayout(resolve(resolved.statePath),resolve(resolved.defaultCwd))
    const migrated = storageConfig.storageVersion === 1
    const privateRoot = migrated ? layout.privateRoot : undefined
    const store = migrated ? await PartnerStore.openSplit(new SplitStatePersistence(layout.publicRoot,layout.privateRoot)) : await PartnerStore.open(resolved.statePath)
    const interruptedCodeRuns = await reconcileInterruptedCodeExecutions(store)
    if (interruptedCodeRuns > 0) ctx.logger.info(`dsh-partner: reconciled ${interruptedCodeRuns} interrupted Codex run(s)`)
    const storage = new StorageCoordinator(resolved.statePath,resolved.defaultCwd,storageConfig.storageVersion,{
      snapshot:()=>store.snapshot(),
      busy:()=>store.snapshot().companions.some(c=>agents.isCompanionBusy(c.id)||heartbeat.isRunning(c.id)||dailyReview.isRunning(c.id))||store.snapshot().executionRuns.some(run=>run.status==='running'||run.status==='queued'),
      quiesce:async()=>{await closeRuntime(false);await memory.freeze();await concerns.freeze();await store.freeze();notices.close();inbox.close();await deliveries.freeze()},
      restart:()=>ctx.fiber.restart(),report:error=>ctx.logger.warn(`存储迁移后重载失败：${String(error)}`),
    })
    const inbox = migrated ? await PartnerInboxStore.openPartitioned(join(layout.publicRoot,'indexes','inbox.sqlite'),layout.privateRoot) : await PartnerInboxStore.open(join(dirname(resolved.statePath), 'partner-inbox.sqlite'))
    const durableInbox = await DurableInbox.open(join(dirname(resolved.statePath), 'partner-channel-inbox.sqlite'))
    ctx.effect(() => () => durableInbox.close(), 'dsh-partner.channel-inbox')
    const notices = new PartnerNoticeService(store, inbox, error => ctx.logger.warn(`dsh-partner inbox: ${error instanceof Error ? error.message : String(error)}`))
    ctx.effect(() => () => { notices.close(); inbox.close() }, 'dsh-partner.inbox')
    syncStorageNotice(inbox, storageConfig.storageVersion, TARGET_STORAGE_VERSION)
    const credentials = new PartnerCredentialVault(ctx.credentials)
    const push = new PushService(store, new PushCredentials(ctx.credentials), message => ctx.logger.warn(`dsh-partner push: ${message}`))
    const pushObserver = new PushObserver(store, push, () => ctx.logger.warn('dsh-partner: 推送通知入队失败，请检查通知队列'))
    ctx.effect(() => async () => { await pushObserver.close(); await push.close() }, 'dsh-partner.push')
    const memory = new PartnerMemoryStore(resolved.defaultCwd, resolved.timeZone,privateRoot)
    const concerns = new PartnerConcernStore(resolved.defaultCwd,privateRoot)
    for (const companion of store.snapshot().companions) {
      const migrated = await memory.migrateLegacy(companion.id)
      if (migrated > 0) ctx.logger.info(`dsh-partner: migrated ${migrated} legacy memory records for ${companion.id}`)
      const routes = store.snapshot().sessions.filter(route => route.companionId === companion.id)
      const primary = routes.find(route => route.kind === 'local')
      if (primary) await memory.mergeScopes(companion.id, conversationMemoryScope(primary, routes),
        routes.filter(route => route.sessionId === primary.sessionId).map(route => `${route.channelId}:${route.userId}`), true)
      if (primary && companion.automation.memory.enabled) await memory.scheduleProfileRepair(companion.id, conversationMemoryScope(primary, routes))
      const legacyRows = await memory.legacyHeartbeatFocuses(companion.id)
      const seeds: LegacyConcernSeed[] = [
        ...legacyTopics(companion.automation.heartbeat.legacyFocus).map(subject => ({
          scopeId: '*', subject, reason: '用户在旧版心跳中明确要求留意', confidence: 1, origin: 'explicit' as const,
        })),
        ...legacyRows.map(item => ({ ...item, origin: 'implicit' as const })),
      ]
      await concerns.migrateLegacy(companion.id, seeds)
      await memory.dropLegacyHeartbeatFocuses(companion.id)
    }
    if (store.snapshot().companions.some(item => item.automation.heartbeat.legacyFocus)) await store.update(state => {
      for (const companion of state.companions) delete companion.automation.heartbeat.legacyFocus
    })
    const reflection = new MemoryReflectionService(ctx, memory, concerns, new InteractionReviewService(store), new ThoughtService(store))
    const persona = new PersonaService(ctx, memory)
    const skills = new SkillService(store, new SkillRepository(migrated?join(layout.publicRoot,'skills'):join(resolved.defaultCwd, 'partner-system', 'skills')))
    await skills.initialize()
    const tasks = new TaskBoardService(store)
    ctx.provide('dshPartnerSshTaskAccess', createSshTaskResolver(store))
    const requirements = new RequirementService(store)
    const executor = new EphemeralExecutionService(ctx, store, resolved.defaultCwd)
    const interruptedRuns = await executor.reconcileInterruptedRuns()
    if (interruptedRuns > 0) ctx.logger.info(`dsh-partner: reconciled ${interruptedRuns} interrupted execution run(s)`)
    const collaboration = new PartnerCollaborationService(store, skills, tasks, executor)
    const scheduler = new PartnerSchedulerService(store, executor, resolved.timeZone)
    const companions = new CompanionService(store)
    const management: CompanionManagementService = new CompanionManagementService(store, {
      catalog: async () => ({
        presets: (await ctx.agentPresets.list()).map(item => ({ id: item.id, name: item.name ?? item.id, ...(item.broken ? { broken: item.broken } : {}) })),
        providers: await Promise.all(ctx.llm.listProviders().map(async item => ({ id: item.id, models: (await ctx.llm.listModels(item.id).catch(() => [])).map(model => ({ id: model.id, name: model.name })) }))),
      }),
      isBusy: (id): boolean => agents.isCompanionBusy(id),
      reload: async id => {
        await agents.reloadCompanion(id)
      },
    })
    const knowledgeMounts = new CompanionKnowledgeMounts(store, management, () => ctx.get('dshKnowledgeMountManagement'), id => partnerCwd(resolved.defaultCwd, id))
    const composer = new PartnerAgentComposition(store, skills, tasks, collaboration, scheduler, executor, companions, management, knowledgeMounts, requirements)
    composer.setCodeExecutionToolFactory(id => partnerCodeExecutionTools(id, store, {
      report: message => ctx.logger.info(`dsh-partner ${message}`),
    }))
    const mcp = new McpService(store, new McpCredentials(ctx.credentials))
    composer.setMcpService(mcp)
    executor.setMcpTools(id => mcp.definitions(id))
    const channelActivities=createChannelActivities((provider,error)=>ctx.logger.warn(`dsh-partner activity provider ${provider}: ${String(error)}`))
    ctx.provide('dshPartnerChannelActivities',channelActivities)
    const agents = new PartnerAgentRuntime(ctx, store, resolved.defaultCwd, memory, reflection, concerns, composer,channelActivities)
    const sleep = new SleepService(ctx, store, memory, { busy: (id, exceptSessionId) => agents.companionActivity(id).some(a => a.kind !== 'memory' && a.kind !== 'observation' && (!exceptSessionId || a.sessionId !== exceptSessionId)), archived: id => ctx.workspaceRegistry.archivedSessionIds.includes(id as import('@deepseek-ai/dsh-session').SessionId) })
    agents.setSleepService(sleep)
    composer.setSleepToolFactory(id => sleep.tool(id))
    const channels = new ChannelManager(ctx, store, credentials, agents, resolved.defaultCwd, durableInbox)
    scheduler.continuations.configure({
      execute: (entry, _companion, signal) => agents.wakeSchedule(entry, signal),
      notify: entry => channels.notifyContinuation(entry),
    })
    const avatars = new ChannelAvatarService(store, credentials)
    composer.setAvatarToolFactory(id => avatars.tool(id))
    const memoryWorker = new MemoryWorker({
      companions: () => store.snapshot().companions,
      removing: id => store.isCompanionRemoving(id),
      process: async companion => {
        try {
          return await reflection.processPending(companion, async (scopeId, created) => {
            if (!await agents.recordConcernCreatedNotice(companion, scopeId, created)) throw new Error('关注通知未送达，稍后重试')
          })
        } finally {
          const routes = store.snapshot().sessions.filter(route => route.companionId === companion.id)
          const primary = routes.find(route => route.kind === 'local')
          if (primary && !store.isCompanionRemoving(companion.id)) await persona.process(companion, conversationMemoryScope(primary, routes))
        }
      },
      warn: message => ctx.logger.warn(`dsh-partner: ${message}`),
    })
    const deliveries = migrated ? await openSharedAttachmentStorage(layout.publicRoot,layout.privateRoot) : await AttachmentDeliveryService.openGrouped(join(dirname(resolved.statePath), 'attachment-deliveries'))
    ctx.effect(() => () => deliveries.close(), 'dsh-partner.attachments')
    const stickers = new StickerLibrary(layout.privateRoot)
    const stickerAdapters=new StickerAdapters(stickers)
    const qqCatalogs=new Map<string,{at:number;faces:Promise<QqFace[]>}>()
    stickerAdapters.register('qq',channel=>qqStickerAdapter(channel,stickerAdapters.fallback,async()=>{
      const key=channel.id+':'+channel.updatedAt,cached=qqCatalogs.get(key)
      if(cached&&Date.now()-cached.at<300000)return cached.faces
      const faces=channels.qqDirectory(channel.id,'stickers').then(value=>(value as {faces:QqFace[]}).faces)
      qqCatalogs.set(key,{at:Date.now(),faces});if(qqCatalogs.size>100)qqCatalogs.delete(qqCatalogs.keys().next().value!)
      try{return await faces}catch(error){qqCatalogs.delete(key);throw error}
    }))
    composer.setChatToolFactory(id => [agreementTool(id,store),...chatTools(id, store, stickers, deliveries, ctx, resolved.apiPrefix,stickerAdapters),...qqActionTools(id,store,(...args)=>channels.qqActionCall(...args),channelId=>{for(const key of qqCatalogs.keys())if(key.startsWith(channelId+':'))qqCatalogs.delete(key)}),qqReplyTool(id,store,(...args)=>channels.qqActionCall(...args))])
    composer.setAttachmentToolFactory(id => attachmentTool(id, store, deliveries, ctx, channels, resolved.apiPrefix))
    channels.setRequirementDelivery(deliveries, resolved.apiPrefix)
    const requirementWorker = new RequirementWorker(store, requirements, {
      summarize: async (item, children, signal, stage) => {
        const companion = store.snapshot().companions.find(c => c.id === item.ownerCompanionId)
        if (!companion) throw new Error('需求负责人不存在，请在需求中重新选择')
        await agents.executeTask({ sourceId: `requirement:${item.id}`, companion, prompt: requirementSummaryPrompt(item, children, stage), signal })
        const draft = requirements.require(item.id).deliveryDraft
        if (!draft || draft.progressKey !== requirementProgressKey(store.snapshot(), item)) throw new Error('负责人尚未提交有效交付清单，将重试整理；未发送渠道')
        return draft.summary
      },
      deliver: item => channels.notifyRequirementResult(item), warn: message => ctx.logger.warn(message),
      isBusy: id => agents.isCompanionBusy(id),
    })
    const blockedRecovery = new BlockedTaskRecovery(store, {
      execute: async (owner, task, prompt, signal) => {
        const companion = store.snapshot().companions.find(c => c.id === owner)
        if (!companion) throw new Error('协调伙伴不存在')
        return (await agents.executeTask({ sourceId: `blocked:${task.id}`, companion, prompt, signal })).output
      },
      isBusy: id => agents.isCompanionBusy(id), warn: message => ctx.logger.warn(message),
    })
    agents.setQuestionAnswerer((agentCtx, route) => channels.attachQuestionAnswerer(agentCtx, route))
    collaboration.setAccessChangeNotifier(id => agents.reloadCompanion(id))
    companions.setSessionProvisioner(id => agents.ensureLocalSessionRecord(id))
    for (const companion of store.snapshot().companions) await agents.ensureLocalSessionRecord(companion.id)
    collaboration.setSessionExecutor({ execute: input => agents.executeTask(input) })
    const disposeConcernTool = registerPartnerConcernTool(ctx, store, concerns)
    tasks.setProgressNotifier(createTaskProgressNotifier(
      async () => { /* Child task delivery is internal; requirements own channel completion. */ },
      (task, previousStatus) => agents.notifyTaskProgress(task, previousStatus),
      message => ctx.logger.warn(message),
    ))
    // Recovery can finish immediately; wire result delivery before claiming work.
    await collaboration.start()
    const disposeSessionObserver = ctx.on('session/event', (session, event) => {
      notices.observeSession(session, event)
      try { pushObserver.observeSession(session, event) } catch { ctx.logger.warn('dsh-partner: 推送事件处理失败') }
      void agents.observeSessionEvent(session, event).catch(error => ctx.logger.warn(`dsh-partner memory reflection failed: ${error instanceof Error ? error.message : String(error)}`))
      void channels.observeAutonomousResult(session, event).catch(error => ctx.logger.warn(`dsh-partner autonomous delivery failed: ${error instanceof Error ? error.message : String(error)}`))
    })
    const heartbeat = new HeartbeatScheduler(ctx, store, agents, channels, concerns, resolved.timeZone)
    const concernExecution = new ConcernExecutionDispatcher(store, concerns, agents)
    heartbeat.setExecutionDispatcher(id => concernExecution.dispatch(id))
    const dailyReview = new DailyReviewScheduler(ctx, store, memory, reflection, agents, resolved.timeZone)
    const login = new WeixinLoginManager()
    let disposeApi: (() => void) | undefined
    let closing:Promise<void>|undefined
    const mountApi = (runtime: RuntimeContext): (() => void) | undefined => {
      if (!resolved.exposeWeb) return undefined
      const webServer = runtime.webServer ?? runtime.get('webServer') as WebServerLike | undefined
      if (webServer === undefined) throw new Error('dsh-partner exposeWeb requires webServer')
      const connection = runtime.connection ?? runtime.get('connection') as ConnectionAccessLike | undefined
      if (connection === undefined) throw new Error('dsh-partner exposeWeb requires connection')
      const dispose = registerPartnerApi(webServer, resolved.apiPrefix, { ctx, store, credentials, channels, agents, login, memory, concerns, heartbeat, concernExecution, dailyReview, skills, tasks, requirements, collaboration, scheduler, companions, inbox, deliveries, storage, mcp, push, stickers, sleep, connection })
      disposeApi = dispose
      return dispose
    }
    if (resolved.exposeWeb && ctx.inject !== undefined) ctx.inject(['connection', 'webServer'], runtime => {
      runtime.effect(() => {
        const dispose = mountApi(runtime)
        // DSH 的服务注入 effect 持有路由生命周期，启动日志可确认 API 前缀已注册。
        ctx.logger.info(`dsh-partner: 浏览器管理 API 已注册，前缀 ${resolved.apiPrefix}`)
        return () => {
          dispose?.()
          if (disposeApi === dispose) disposeApi = undefined
        }
      }, 'dsh-partner.web-api')
    })
    else if (resolved.exposeWeb && ctx.webServer !== undefined && ctx.connection !== undefined) mountApi(ctx)
    else if (resolved.exposeWeb) ctx.logger.warn('dsh-partner: webServer or connection is unavailable; companion management is disabled')
    await agents.reconcileQqSessions()
    if (resolved.autoStartChannels) await channels.startEnabled()
    await push.start()
    sleep.start()
    heartbeat.start()
    dailyReview.start()
    memoryWorker.start()
    scheduler.start()
    requirementWorker.start()
    blockedRecovery.start()
    ctx.logger.info(`dsh-partner: ready with ${store.snapshot().companions.length} companion(s)`)
    function closeRuntime(removeApi=true):Promise<void> {
      if(removeApi)disposeApi?.()
      return closing ??= (async()=>{
      collaboration.beginShutdown()
      requirementWorker.beginShutdown()
      blockedRecovery.beginShutdown()
      disposeSessionObserver()
      await pushObserver.close()
      await push.close()
      disposeConcernTool()
      await sleep.close()
      reflection.close()
      persona.close()
      await Promise.all([memoryWorker.close(),scheduler.close(),heartbeat.close(),dailyReview.close(),channels.close()])
      durableInbox.close()
      await agents.close()
      await mcp.close()
      await executor.close()
      await collaboration.close()
      await requirementWorker.close()
      await blockedRecovery.close()
      })()
    }
    return async () => {try{await closeRuntime()}finally{releaseStorageLease()}}
    }catch(error){releaseStorageLease();throw error}
  }, 'dsh-partner.runtime')
}

function legacyTopics(value: string | undefined): string[] {
  if (!value) return []
  const seen = new Set<string>()
  return value.split(/[\r\n;；]+/).map(item => item.replace(/\s+/g, ' ').trim()).filter(item => {
    const key = item.toLocaleLowerCase().replace(/\s+/g, '')
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}
