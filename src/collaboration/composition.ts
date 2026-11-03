import { thoughtTool } from '../character/thought-tool.js'
import { affectionTool } from '../character/affection-tool.js'
import {workflowProtocol} from './workflow-protocols.js'
import {workExecutionTool} from '../execution/work-tool.js'
import { idleActivityFinishTool } from '../character/activity-tool.js'
import {installToolDiscovery,TOOL_DISCOVERY_PROMPT,type DiscoverableTool} from './tool-discovery.js'
import { identityTool } from '../companions/identity-tool.js'
import type { Context } from '@deepseek-ai/cordis'
import { continuationChannelOrigin } from '../scheduler/channel-origin.js'
import type { ToolDefinition, ToolRunContext, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { optionalBoolean, record, requiredText } from '../core/validation.js'
import type { Companion } from '../domain.js'
import type { CompanionCapability } from '../capabilities.js'
import type { EphemeralExecutionService } from '../execution/service.js'
import type { PartnerStore } from '../store.js'
import type { SkillService } from '../skills/service.js'
import type { McpService } from '../mcp/service.js'
import { renderEnabledSkills } from '../skills/service.js'
import type { TaskBoardService } from '../tasks/service.js'
import type { PartnerSchedulerService } from '../scheduler/service.js'
import type { PartnerCollaborationService } from './service.js'
import type { CompanionService } from '../companions/service.js'
import type { CompanionManagementService } from '../companions/management.js'
import type { CompanionKnowledgeMounts } from '../companions/knowledge-mounts.js'
import { companionManagementTool } from '../companions/management-tool.js'
import { RequirementService } from '../requirements/service.js'
import { requirementTool } from '../requirements/tool.js'
import { contractParameters, checksParameter } from '../tasks/contract.js'
import { TaskWorkflowError } from '../tasks/workflow-error.js'

type AgentCompositionContext = Context & { tools: ToolRuntime }

/** Composes partner-only tools into one agent scope. No global tool is registered. */
export class PartnerAgentComposition {
  private mcp?: McpService
  setMcpService(service: McpService): void { this.mcp = service }
  private sleepToolFactory?: (companionId: string) => ToolDefinition
  setSleepToolFactory(factory: (companionId: string) => ToolDefinition): void { this.sleepToolFactory = factory }
  private chatToolFactory?: (companionId: string) => ToolDefinition[]
  setChatToolFactory(factory: (companionId: string) => ToolDefinition[]): void { this.chatToolFactory = factory }
  private avatarToolFactory?: (companionId: string) => ToolDefinition
  setAvatarToolFactory(factory: (companionId: string) => ToolDefinition): void { this.avatarToolFactory = factory }
  private attachmentToolFactory?: (companionId: string) => ToolDefinition
  setAttachmentToolFactory(factory: (companionId: string) => ToolDefinition): void { this.attachmentToolFactory = factory }
  constructor(
    private readonly store: PartnerStore,
    private readonly skills: SkillService,
    private readonly tasks: TaskBoardService,
    private readonly collaboration: PartnerCollaborationService,
    private readonly scheduler: PartnerSchedulerService,
    private readonly executor: EphemeralExecutionService,
    private readonly companions: CompanionService,
    private readonly management?: CompanionManagementService,
    private readonly knowledgeMounts?: CompanionKnowledgeMounts,
    private readonly requirements = new RequirementService(store),
  ) {}

  async compose(ctx: AgentCompositionContext, companion: Companion): Promise<() => void> {
    const skillsEnabled = companion.capabilities.includes('skills')
    const enabledSkills = skillsEnabled ? this.skills.bindings(companion.id) : []
    const disposers: Array<() => void> = []
    const catalog:DiscoverableTool[]=[]
    const protocol=(name:string)=>workflowProtocol(name,this.store.snapshot().companions.find(c=>c.id===companion.id)??companion)
    const add=(tool:ToolDefinition,allowed=()=>true):void=>{
      const original=tool
      tool={...original,async execute(args,exec){
        if(!allowed())throw Error('能力已撤回')
        return original.execute(args,exec)
      }}
      if(companion.toolDiscovery)catalog.push({tool,allowed,protocol:()=>protocol(tool.name)})
      else disposers.push(ctx.tools.register(tool))
    }
    const register = (tool: ToolDefinition, capability: CompanionCapability): void => {
      add({ ...tool, execute: async (args, execution) => {
        // Old schemas must not authorize calls after a saved revocation.
        if (!this.store.hasCapability(companion.id, capability)) throw new Error(`伙伴的 ${capability} 能力已撤回，当前调用未执行`)
        return tool.execute(args, execution)
      } },()=>this.store.hasCapability(companion.id,capability))
    }
    try {
      add(workExecutionTool(companion.id,this.store,this.executor,ctx.tools,name=>protocol(name)))
      add(textTool({name:'partner_workflow',description:'按需读取已提供的工作工具操作流程，不执行任务、不改变权限。',parameters:actionParameters(['inspect'],{tool:{type:'string'}},['tool']),async execute(raw,exec){const input=record(raw);const name=requiredText(input.tool,'tool',120);if(!ctx.tools.get(name,exec.agent))throw Error('工具当前不可用');return protocol(name)||'此工具没有额外工作流程，请查看工具自身说明。'}}))
      if (this.sleepToolFactory) add(this.sleepToolFactory(companion.id))
      add(identityTool(companion.id, this.store))
      add(affectionTool(companion.id, this.store))
      add(thoughtTool(companion.id, this.store))
      add(idleActivityFinishTool(companion.id, this.store))
      for (const tool of this.mcp?.definitions(companion.id) ?? []) register(tool, 'mcp')
      if (this.attachmentToolFactory) add(this.attachmentToolFactory(companion.id))
      for (const tool of this.chatToolFactory?.(companion.id) ?? []) add(tool)
      if (this.avatarToolFactory) add(this.avatarToolFactory(companion.id))
      if (skillsEnabled) register(skillTool(companion, this.skills, this.executor), 'skills')
      if (companion.capabilities.includes('companions')) register(companionTool(this.companions), 'companions')
      if (companion.capabilities.includes('access')) register(accessGrantTool(companion, this.collaboration), 'access')
      if (companion.capabilities.includes('administration')) {
        if (!this.management || !this.knowledgeMounts) throw new Error('伙伴管理服务尚未就绪')
        register(companionManagementTool(companion.id, this.management, this.knowledgeMounts), 'administration')
      }
      add(taskTool(companion, this.tasks, this.collaboration))
      add(requirementTool(companion.id, this.requirements, this.tasks, () => this.collaboration.dispatchReadyTasks()))
      add(collaborationTool(companion, this.store, this.collaboration))
      if (companion.capabilities.includes('schedules')) register(scheduleTool(companion, this.scheduler, this.store), 'schedules')
      if(companion.toolDiscovery)disposers.push(installToolDiscovery(ctx.tools,companion.id,this.store,catalog))
      disposers.push(ctx.systemPrompt.section({
        name:'partner-collaboration',order:-7,
        text:[companion.toolDiscovery ? TOOL_DISCOVERY_PROMPT : '伙伴能力通过当前工具调用。工作流程可用 partner_workflow 查询，Skill 使用 partner_skill 加载；权限以实际校验为准。',
          '任务分流：用户要求实际查证、排障、寻找实现方案或重新核实旧结论时，先回应再直接调用 partner_work_execute，将调查过程留在独立工作上下文，事实结果返回后由原会话答复。不要把这种请求改答成通用知识或工具目录介绍。只问概念、仅查工具清单、普通聊天和一次轻量操作直接处理；已有看板任务或明确委派沿用原任务，不重复执行。',
          '当前目录只代表已暴露的能力，不代表所有实现方案均已调查。区分未提供入口、尚未验证和实际失败；需要调查的请求应继续检索或验证。',
          companion.idleContact?.enabled ? '自主活动已开启。你可以按自己的意图继续行动，也可以结束；如想在本轮之后再继续，可按需查询 partner_thoughts，用 plan 留下下一步意图、会话和等待时间。没有安排就按空闲频率唤起，不因回复完成自动追加一轮。真实结果、用户新消息与停止要求优先；不必每轮计划或汇报计划。' : '',
          renderEnabledSkills(companion,enabledSkills),
          `当前伙伴 id：${companion.id}。授权伙伴目录通过 partner_collaborate directory 查询；流程说明通过 partner_tools describe 或 partner_workflow inspect 按需读取。`,
        ].filter(Boolean).join('\n\n'),
      }))
    } catch (error) {
      disposeAll(disposers)
      throw error
    }
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      disposeAll(disposers)
    }
  }
}

function accessGrantTool(companion: Companion, collaboration: PartnerCollaborationService): ToolDefinition {
  return textTool({
    name: 'partner_access_grants',
    description: 'List or administer directed access relationships between companions. A grant means the grantee may access the target companion public identity, capabilities, task envelopes, and result summaries. Change relationships only on an explicit user request; never infer extra or reciprocal grants.',
    parameters: actionParameters(['list', 'grant', 'revoke'], {
      grantee: { type: 'string', description: 'Companion id or @name that should gain or lose access. Required for grant and revoke.' },
      target: { type: 'string', description: 'Companion id or @name the grantee should be allowed or forbidden to access. Required for grant and revoke.' },
    }),
    presentCall: args => ({ card: 'generic', title: `伙伴授权 · ${typeof (args as { action?: unknown }).action === 'string' ? (args as { action: string }).action : '操作'}` }),
    async execute(raw) {
      const input = record(raw, 'arguments')
      const action = requiredText(input.action, 'action', 20)
      if (action === 'list') {
        const directory = collaboration.directory()
        const byId = new Map(directory.map(item => [item.id, item]))
        return JSON.stringify({
          companions: directory.map(item => ({ id: item.id, name: item.name, role: item.role })),
          grants: collaboration.accessGrants().map(grant => ({
            granteeId: grant.fromCompanionId, grantee: byId.get(grant.fromCompanionId)?.name ?? grant.fromCompanionId,
            targetId: grant.toCompanionId, target: byId.get(grant.toCompanionId)?.name ?? grant.toCompanionId,
          })),
        })
      }
      const grantee = collaboration.resolveCompanion(requiredText(input.grantee, 'grantee', 160))
      const target = collaboration.resolveCompanion(requiredText(input.target, 'target', 160))
      if (grantee.id === target.id) throw new Error('伙伴不能获得访问自己的授权')
      const targets = new Set(collaboration.accessTargetIds(grantee.id))
      if (action === 'grant') targets.add(target.id)
      else if (action === 'revoke') targets.delete(target.id)
      else throw new Error('Partner access action is invalid')
      await collaboration.updateAccessTargets(grantee.id, [...targets])
      return JSON.stringify({ managedBy: companion.name, granteeId: grantee.id, grantee: grantee.name, targetId: target.id, target: target.name, authorized: action === 'grant' })
    },
  })
}

function disposeAll(disposers: Array<() => void>): void {
  for (let index = disposers.length - 1; index >= 0; index -= 1) disposers[index]?.()
}

function companionTool(companions: CompanionService): ToolDefinition {
  return textTool({
    name: 'partner_companions',
    description: 'Create a new long-lived companion identity only when the user explicitly requests one. The new companion starts with no capabilities, memory, heartbeat, channel, or collaboration grants.',
    parameters: actionParameters(['create'], {
      name: { type: 'string', description: 'Companion display name.' },
      role: { type: 'string', description: 'The companion\'s durable role.' },
      description: { type: 'string', description: 'A concise identity and responsibility summary.' },
      instructions: { type: 'string', description: 'Durable behavior, boundaries, work style, and delivery expectations.' },
    }, ['name', 'role', 'description', 'instructions']),
    presentCall: () => ({ card: 'generic', title: '创建伙伴' }),
    async execute(raw) {
      const input = record(raw, 'arguments')
      if (requiredText(input.action, 'action', 20) !== 'create') throw new Error('Companion action is invalid')
      const companion = await companions.create({
        name: requiredText(input.name, 'name', 60),
        role: requiredText(input.role, 'role', 120),
        description: requiredText(input.description, 'description', 500),
        instructions: requiredText(input.instructions, 'instructions', 12_000),
      })
      return JSON.stringify({
        id: companion.id,
        name: companion.name,
        role: companion.role,
        description: companion.description,
        instructions: companion.instructions,
        capabilities: companion.capabilities,
        memoryEnabled: companion.automation.memory.enabled,
        heartbeatEnabled: companion.automation.heartbeat.enabled,
      })
    },
  })
}

function skillTool(companion: Companion, skills: SkillService, executor: EphemeralExecutionService): ToolDefinition {
  return textTool({
    name: 'partner_skill',
    description: 'List, load, or execute Skills enabled for this companion. For an actual work request that may match an authorized companion specialty, proactively apply the enabled task-planning Skill to decide assignment and decomposition, then use partner_task_board and partner_collaborate for real delegation; do not wait for the user to name the Skill or @ a companion. Read the full enabled inline Skill with load before applying it; execute fork Skills in a temporary session. Partner Skills belong to partner_skill, not the native skill tool: never call skill(name="task-planning") for this catalog. A Skill never grants tools outside current DSH permissions.',
    parameters: actionParameters(['list', 'load', 'run'], {
      skillId: { type: 'string', description: 'Installed Skill id.' },
      input: { type: 'string', description: 'Concrete task or arguments for the Skill.' },
    }),
    timeoutMs: 15 * 60_000,
    presentCall: args => ({ card: 'generic', title: `伙伴 Skill · ${typeof (args as { action?: unknown }).action === 'string' ? (args as { action: string }).action : '操作'}` }),
    async execute(raw, exec) {
      const input = record(raw, 'arguments')
      const action = requiredText(input.action, 'action', 20)
      const enabled = skills.bindings(companion.id)
      if (action === 'list') return JSON.stringify(enabled.map(skill => ({ id: skill.id, name: skill.displayName, description: skill.description, version: skill.version, context: skill.executionContext })))
      const skillId = requiredText(input.skillId, 'skillId', 120)
      if (!enabled.some(item => item.id === skillId)) throw new Error('Skill is not enabled for this companion')
      const skill = await skills.load(skillId)
      if (action === 'load') {
        if (skill.executionContext !== 'inline' || !skill.trusted) throw new Error('This Skill must run in an isolated temporary session')
        return JSON.stringify({ id: skill.id, rootPath: skill.rootPath, instructions: skill.body, allowedTools: skill.allowedTools })
      }
      if (action !== 'run') throw new Error('Skill action is invalid')
      // Inline means apply in the current companion scope. A preset-only fork
      // does not carry its partner board/requirement tools and is not delegation.
      if (skill.executionContext === 'inline' && skill.trusted) return JSON.stringify({ id: skill.id, context: 'inline', rootPath: skill.rootPath, instructions: skill.body, allowedTools: skill.allowedTools, execution: 'apply-in-current-session', notice: '请在当前伙伴会话按此 Skill 使用真实工具执行；没有创建子 Agent，也没有代替你提交看板任务。' })
      const result = await executor.execute({
        kind: 'skill', sourceId: skill.id, companion, parentSessionId: requireAgent(exec).session.id,
        prompt: requiredText(input.input, 'input', 12_000), allowedTools: skill.allowedTools, destroyAfterRun: true,
        systemInstruction: `严格按照以下 Skill 执行。Skill 的 allowed-tools 只能收缩权限；工具不可用时明确说明，不得模拟结果。本次 allowed-tools：${JSON.stringify(skill.allowedTools)}。旧操作名经 knowledge/ssh 入口调用时仍受此白名单限制；目录中的其他操作不代表已获准。资源目录：${JSON.stringify(skill.rootPath)}；相对路径基于此目录，不代表获准执行脚本。\n\n${skill.body}`,
      })
      return JSON.stringify({ runId: result.run.id, result: result.output })
    },
  })
}

function taskTool(companion: Companion, tasks: TaskBoardService, collaboration: PartnerCollaborationService): ToolDefinition {
  const confirmAssignment = (task: ReturnType<TaskBoardService['require']>) => {
    const identity = (id: string | undefined) => {
      if (!id) return null
      // A deleted companion must not make a successfully saved task look failed.
      try { return { id, name: collaboration.resolveCompanion(id).name } }
      catch { return { id, name: null } }
    }
    return {
      executor: identity(task.assigneeCompanionId),
      reviewer: identity(task.reviewerCompanionId),
      selfExecution: task.assigneeCompanionId === companion.id,
      autoRun: Boolean(task.autoRun),
      summary: `实际执行者：${task.assigneeCompanionId ?? '未指定'}；验收者：${task.reviewerCompanionId ?? '未指定'}。${task.autoRun ? '已启用自动执行，是否开始以任务状态为准；不代表已完成。' : '未启用自动执行，即使 status=ready 也不会自动执行。'}`,
    }
  }
  const resolveAssignee = (value: string): string => {
    const target = collaboration.resolveCompanion(value)
    if (target.id !== companion.id && !collaboration.canAccess(companion.id, target.id)) throw new Error(`当前伙伴未获授权访问 @${target.name}`)
    return target.id
  }
  return textTool({
    name: 'partner_task_board',
    description: 'Turn requested deliverables into actual work assigned to self or authorized specialist companions; this board is not merely a log to fill after doing everything yourself. When the request matches an authorized companion specialty, proactively apply the enabled task-planning Skill and connect the requested outcome, suitable assignee and board task before carrying out the work; no explicit @ or board request is needed. The Skill defines decomposition and exceptions. List, create, update, comment on, accept or reject tasks. Creating with assignee submits execution automatically, including dependency waiting; set autoRun=false to save without execution. Submitted/queued is not completion. Every create must include requirementId. Continued work uses the original requirement: list to find it, reopen submitted/archived scope if necessary, then append. Never create another requirement merely because a different specialist takes the next phase. dependencyTaskIds controls ordering, not ownership. Only a separate user goal warrants a new requirement. Child execution and review are internal: stage notification waits until only done/blocked tasks remain, and does not require archiving. For changed task specifications use update, not only comment; for changed whole scope use partner_requirements update. reject must state concrete missing items and corrections; accept/reject must use the revision actually reviewed. Executors receive latest scope, recent comments, rejection reasons and previous deliverables on rework. Remove permanently deletes only on explicit user request, stops execution and pauses dependents. Accepted dependencies unlock queued tasks automatically.',
    parameters: actionParameters(['list', 'create', 'update', 'submit_result', 'comment', 'accept', 'reject', 'request_replan', 'remove'], {
      resultSummary: { type: 'string', description: 'submit_result: actual deliverables, job/asset IDs where relevant, real file paths and attachment delivery IDs. Atomically saves this result and enters review; never regenerate merely to repair submission.' },
      evidence: { type: 'array', items: { type: 'object', properties: { criterion: { type: 'integer', minimum: 1 }, reference: { type: 'string' }, note: { type: 'string' } }, required: ['criterion', 'reference'] }, description: 'submit_result: evidence for each 1-based acceptance criterion.' },
      ...contractParameters, checks: checksParameter,
      reworkMode: { type: 'string', enum: ['rework', 'replan'], description: 'reject only: rework continues ordinary corrections; replan pauses for owner reassignment/splitting or missing tools. Three consecutive rejections automatically pause.' },
      taskId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' },
      requirementId: { type: 'string', description: 'REQUIRED for create. Reuse the existing requirement for continued work on the same deliverable, including later specialist phases. dependencyTaskIds does not set ownership. Missing id fails without creating anything. Query partner_requirements list; reopen a submitted/archived requirement before appending; create a requirement only for a genuinely separate user goal.' },
      status: { type: 'string', enum: ['backlog', 'ready', 'doing', 'review', 'done', 'blocked'], description: 'Do not update to review before submitting results. Prefer action=submit_result with expectedRevision, resultSummary and evidence to commit the deliverable and review status atomically. Otherwise keep doing until the final result envelope is collected. Repair missing submission from existing assets, never regenerate for a formatting error.' },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
      assignee: { type: 'string', description: 'Actual EXECUTOR companion id or @name, not the coordinator or requester. Select from authorized directory and verify real capabilities. Use your own id only when you will actually execute. Set reviewer independently according to the specified review arrangement, never reverse these roles.' }, reviewer: { type: 'string', description: 'Companion who actually accepts/rejects this deliverable. If the user or your plan designates a specialist reviewer, MUST explicitly set that companion here; mentioning them in description or making them executor of a later review task is not sufficient. Only when nobody else was designated may the omitted reviewer default to the creator. Dependencies wait for acceptance, not merely a saved result.' },
      autoRun: { type: 'boolean', description: 'Default true on create with assignee (except explicit backlog). For requested execution use true; false means SAVE ONLY, even with status=ready. Set false only for explicit planning-only/await-confirmation requests. Persist execution intent and start after dependencies are accepted. Check returned assignment before reporting who executes/reviews; queued is not completed. Legacy tasks are never auto-started.' },
      dependencyTaskIds: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Tasks that must be done before this task can start.' },
      expectedRevision: { type: 'integer', description: 'Required for update, accept, reject and request_replan. Use the revision actually reviewed; if stale, reread latest requirements and results.' }, message: { type: 'string', description: 'For request_replan: concrete missing tools, required reassignment/splitting and preserved output. This pauses/cancels the current task; stop this turn afterward. For reject: missing evidence and corrections; use reworkMode=replan for inability to execute.' },
    }),
    async execute(raw, exec) {
      const input = record(raw, 'arguments')
      const action = requiredText(input.action, 'action', 20)
      if (action === 'list') return JSON.stringify(tasks.snapshot())
      if (action === 'create') {
        const assignee = typeof input.assignee === 'string' && input.assignee.trim() ? resolveAssignee(input.assignee) : undefined
        const reviewer = typeof input.reviewer === 'string' && input.reviewer.trim() ? resolveAssignee(input.reviewer) : undefined
        const autoRun = optionalBoolean(input.autoRun, Boolean(assignee) && input.status !== 'backlog')
        const task = await tasks.create({
          ...input,
          autoRun,
          creatorSessionId: requireAgent(exec).session.id,
          ...(assignee ? { assigneeCompanionId: assignee } : {}),
          ...(reviewer ? { reviewerCompanionId: reviewer } : {}),
        }, { kind: 'companion', companionId: companion.id }, true)
        let dispatchWarning: string | undefined
        if (autoRun) {
          try { await collaboration.dispatchReadyTasks() }
          catch { dispatchWarning = '任务已保存，执行提交将在后台重试；不要重复创建任务' }
        }
        const snapshot = tasks.snapshot()
        const requirement = snapshot.requirements?.find(item => item.id === task.requirementId)
        const currentTask = snapshot.tasks.find(item => item.id === task.id)
        if (!currentTask) return JSON.stringify({ taskId: task.id, status: 'removed', message: '任务已删除，不要重复创建' })
        return JSON.stringify({ ...currentTask, execution: autoRun ? 'submitted' : 'planning-only',
          assignment: confirmAssignment(currentTask),
          ...(requirement ? { requirement: { id: requirement.id, revision: requirement.revision, controlRevision: requirement.controlRevision, status: requirement.status } } : {}),
          ...(dispatchWarning ? { dispatchWarning } : {}) })
      }
      const taskId = requiredText(input.taskId, 'taskId', 160)
      const existing = tasks.snapshot().tasks.find(task => task.id === taskId)
      if (!existing) return JSON.stringify({ taskId, status: 'removed', message: '任务已删除或不存在，停止处理旧任务，不要重建' })
      if (action === 'request_replan') {
        if (!Number.isInteger(input.expectedRevision)) throw new Error('请先 list 读取任务，并提供 expectedRevision')
        const task = await tasks.requestReplan(taskId, requiredText(input.message, 'message', 1200), { kind: 'companion', companionId: companion.id }, input.expectedRevision as number)
        return JSON.stringify({ ...task, recovery: '已暂停并取消旧执行，等待需求负责人调整；结束本轮，不要继续转派同一任务或反复重试。' })
      }
      if (action === 'remove') {
        if (existing.creatorCompanionId !== companion.id) throw new Error('只能删除自己创建的任务；删除必须有用户明确要求')
        await tasks.remove(taskId); return JSON.stringify({ taskId, removed: true })
      }
      if (action === 'comment') { await tasks.comment(taskId, requiredText(input.message, 'message', 2000), { kind: 'companion', companionId: companion.id }); return JSON.stringify({ ok: true }) }
      if (action === 'accept' || action === 'reject') {
        if (input.reworkMode !== undefined && !['rework', 'replan'].includes(String(input.reworkMode))) throw new Error('reworkMode 无效')
        if (!Number.isInteger(input.expectedRevision)) throw new Error('验收必须提供实际核验的 expectedRevision；请先查询最新任务、补充评论和交付后再决定')
        const task = tasks.require(taskId)
        if (task.reviewerCompanionId && task.reviewerCompanionId !== companion.id) throw new Error('当前伙伴不是这个任务指定的验收伙伴')
        return JSON.stringify(action === 'accept'
          ? await tasks.accept(taskId, { kind: 'companion', companionId: companion.id }, input.expectedRevision as number, input.checks)
          : await tasks.reject(taskId, requiredText(input.message, 'message', 1200), { kind: 'companion', companionId: companion.id }, input.expectedRevision as number, input.reworkMode as 'rework' | 'replan' | undefined, input.checks))
      }
      if (action === 'update') {
        const assignee = typeof input.assignee === 'string' && input.assignee.trim() ? resolveAssignee(input.assignee) : undefined
        const reviewer = typeof input.reviewer === 'string' && input.reviewer.trim() ? resolveAssignee(input.reviewer) : undefined
        const updated = await tasks.update(taskId, {
          ...input,
          ...('assignee' in input ? { assigneeCompanionId: assignee ?? '' } : {}),
          ...('reviewer' in input ? { reviewerCompanionId: reviewer ?? '' } : {}),
        }, { kind: 'companion', companionId: companion.id })
        return JSON.stringify({ ...updated, assignment: confirmAssignment(updated) })
      }
      if (action === 'submit_result') {
        if (!Number.isInteger(input.expectedRevision)) throw new Error('submit_result 必须提供当前 expectedRevision')
        return JSON.stringify(await tasks.completeExecution(taskId, { deliverable: requiredText(input.resultSummary, 'resultSummary', 12000), evidence: input.evidence }, { kind: 'companion', companionId: companion.id }, undefined, input.expectedRevision as number))
      }
      throw new Error('Task board action is invalid')
    },
  })
}

function collaborationTool(companion: Companion, store: PartnerStore, collaboration: PartnerCollaborationService): ToolDefinition {
  return textTool({
    name: 'partner_collaborate',
    description: 'Connect a work request with authorized companion specialties and real board delegation, not just a contact lookup. Use directory when specialty or authorization information is missing or stale; proactively match the requested deliverable to the authorized directory instead of defaulting to doing it yourself because execution tools are available. Apply the enabled task-planning Skill for assignment, decomposition and exceptions. Create assigned work through partner_task_board, or use delegate for an existing task; do not duplicate already-assigned work. Dependencies may still be pending: the durable queue starts work after accepted prerequisites. Repeated submission to the same assignee returns its pending job. Returns without waiting for execution; progress notifies the creator. Never exposes private transcripts or credentials.',
    parameters: actionParameters(['directory', 'delegate', 'status'], {
      taskId: { type: 'string' }, companion: { type: 'string', description: 'Target companion id or @name.' }, request: { type: 'string' }, delegationId: { type: 'string' },
    }),
    timeoutMs: 15 * 60_000,
    async execute(raw, exec) {
      const input = record(raw, 'arguments')
      const action = requiredText(input.action, 'action', 20)
      if (action === 'directory') return JSON.stringify(collaboration.directoryFor(companion.id))
      if (action === 'status') {
        const id = requiredText(input.delegationId, 'delegationId', 160)
        const value = store.snapshot().delegations.find(item => item.id === id && (item.fromCompanionId === companion.id || item.toCompanionId === companion.id))
        if (!value) throw new Error('Delegation does not exist')
        return JSON.stringify(value)
      }
      if (action !== 'delegate') throw new Error('Collaboration action is invalid')
      const result = await collaboration.delegate({
        taskId: requiredText(input.taskId, 'taskId', 160), initiatedBy: 'companion', fromCompanionId: companion.id,
        to: requiredText(input.companion, 'companion', 160), request: requiredText(input.request, 'request', 8000),
        parentSessionId: requireAgent(exec).session.id,
      })
      return JSON.stringify(result)
    },
  })
}

function scheduleTool(companion: Companion, scheduler: PartnerSchedulerService, store: PartnerStore): ToolDefinition {
  return textTool({
    name: 'partner_schedule',
    description: 'Manage this companion\'s schedules. create is only for explicitly requested scheduled work, never change-driven watches. defer creates an idempotent one-shot continuation for an already-submitted long task: taskKey, externalTaskId, title, check and nextStep are required; delayMinutes defaults to 2, deadlineMinutes to 1440, maxAttempts to 12. Origin is captured from the current session. On wake check the existing task, never resubmit it; resolve with scheduleId, runToken, summary and outcome pending/completed/blocked; pending reschedules the same entry and ends the turn. cancel stops a continuation. No Skill is required. Never store credentials or exceed current tool approvals.',
    parameters: actionParameters(['list', 'create', 'update', 'delete', 'run', 'defer', 'resolve', 'cancel'], {
      scheduleId: { type: 'string' }, title: { type: 'string' }, prompt: { type: 'string' },
      schedule: { type: 'object', description: '{kind:"interval",minutes} or {kind:"daily",hour,minute}' },
      enabled: { type: 'boolean' }, destroySessionAfterRun: { type: 'boolean' }, overlapPolicy: { type: 'string', enum: ['skip', 'queue'] }, timeoutMinutes: { type: 'integer' },
      taskKey: { type: 'string', description: 'Stable provider/job identity; reuse for retries, never invent a new key for the same task.' },
      boardTaskId: { type: 'string', description: 'Current board task ID when waiting within board work. The server binds the running delegation, parks only this task, and resumes it after a completed receipt. Never use recurring create for board polling. Waiting is not a deliverable.' },
      externalTaskId: { type: 'string', description: 'Exact external job ID; required to resolve a waiting task early without runToken, from its original session.' }, check: { type: 'string', description: 'Read-only status check; no secrets.' }, completion: { type: 'string', description: 'This scheduled task alone is complete when this condition is verified, independent of the conversation or Goal. Defaults to verified success of this external job alone, not subsequent workflow steps.' }, nextStep: { type: 'string', description: 'Authorized steps after completed. When continuation.board is present, end the wake immediately after resolve: the BOARD resumes these steps, never execute them in the timer too. A new long job needs its own defer. Never sleep or create/modify a Goal for scheduling; do not re-poll before due.' },
      delayMinutes: { type: 'integer', minimum: 1, maximum: 1440 }, deadlineMinutes: { type: 'integer', minimum: 1, maximum: 43200 }, maxAttempts: { type: 'integer', minimum: 1, maximum: 100 },
      runToken: { type: 'string' }, outcome: { type: 'string', enum: ['pending', 'completed', 'blocked'] }, summary: { type: 'string' },
    }),
    timeoutMs: 15 * 60_000,
    async execute(raw, exec) {
      const input = record(raw, 'arguments')
      const action = requiredText(input.action, 'action', 20)
      if (action === 'list') return JSON.stringify(scheduler.list().filter(item => item.companionId === companion.id))
      if (action === 'defer') {
        const agent = requireAgent(exec)
        return JSON.stringify(await scheduler.continuations.defer(companion.id, agent.session.id, input,
          continuationChannelOrigin(store.snapshot(), companion.id, agent.session.id, agent.session.snapshotEvents())))
      }
      if (action === 'resolve') return JSON.stringify(await scheduler.continuations.resolve(companion.id, requireAgent(exec).session.id, input))
      if (action === 'create') {
        const sessionId = requireAgent(exec).session.id
        const jobs = store.snapshot().delegations.filter(d => d.kind !== 'review' && d.status === 'running' && d.toCompanionId === companion.id && d.executionSessionId === sessionId)
        if (jobs.length > 1 && input.boardTaskId === undefined) throw new Error('请填写当前 boardTaskId，临时计划必须跟随任务结束清理')
        return JSON.stringify(await scheduler.create({ ...input, ...(input.boardTaskId === undefined && jobs[0] ? { boardTaskId: jobs[0].taskId } : {}) }, companion.id))
      }
      const id = requiredText(input.scheduleId, 'scheduleId', 160)
      const owned = scheduler.list().find(item => item.id === id && item.companionId === companion.id)
      if (!owned) throw new Error('Schedule does not exist for this companion')
      if (action === 'cancel') { await scheduler.continuations.cancel(companion.id, id); return JSON.stringify({ ok: true }) }
      if (action === 'update') return JSON.stringify(await scheduler.update(id, input))
      if (action === 'delete') { await scheduler.remove(id); return JSON.stringify({ ok: true }) }
      if (action === 'run') { await scheduler.trigger(id); return JSON.stringify({ ok: true }) }
      throw new Error('Schedule action is invalid')
    },
  })
}

function textTool(definition: Omit<ToolDefinition, 'output'>): ToolDefinition {
  return {
    ...definition,
    async execute(raw, exec) {
      try { return await definition.execute(raw, exec) }
      catch (error) {
        if (error instanceof TaskWorkflowError) return JSON.stringify(error.result())
        throw error
      }
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
  }
}

function actionParameters(actions: string[], properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: 'object' as const, additionalProperties: false,
    properties: { action: { type: 'string', enum: actions }, ...properties }, required: ['action', ...required],
  }
}

function requireAgent(exec: ToolRunContext) {
  if (!exec.agent) throw new Error('Partner tool requires an active companion agent')
  return exec.agent
}
