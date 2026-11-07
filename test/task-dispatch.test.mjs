import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerStore } from '../lib/store.js'
import { TaskBoardService } from '../lib/tasks/service.js'
import { PartnerCollaborationService } from '../lib/collaboration/service.js'
import { PartnerAgentComposition } from '../lib/collaboration/composition.js'
import { SkillService } from '../lib/skills/service.js'
import { SkillRepository } from '../lib/skills/repository.js'
import { BUILTIN_SKILLS } from '../lib/skills/builtin.js'
import { TASK_PLANNING_DOCUMENT, TASK_PLANNING_VERSION } from '../lib/skills/task-planning.js'
import { parseSkillDocument } from '../lib/skills/loader.js'
import { SessionConfigurationIndex } from '../lib/companions/session-configuration.js'
import { isPartnerDiscoveryTool, PARTNER_TOOL_ENTRIES } from '../lib/collaboration/tool-discovery.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'partner-dispatch-'))
  const store = await PartnerStore.open(join(root, 'state.json'))
  const board = new TaskBoardService(store)
  const skills = new SkillService(store, new SkillRepository(join(root, 'skills')))
  const service = new PartnerCollaborationService(store, skills, board, {})
  const calls = []
  service.setSessionExecutor({ execute: async input => { if (!input.sourceId.startsWith('review:')) calls.push(input); return {run:{id:'run-'+calls.length}, output:'真实产出'} } })
  t.after(async () => { await service.close(); await rm(root,{recursive:true,force:true}) })
  return {root,store,board,skills,service,calls}
}
const waitFor = async predicate => {
  for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10))}
  assert.fail('condition did not become true')
}
const actor={kind:'companion',companionId:'companion-default'}
const assigned={assigneeCompanionId:'companion-default',autoRun:true}

test('running an inline planning Skill never forks away from companion board tools', async t => {
  const { store, board, skills, service } = await fixture(t)
  await skills.installMarket('builtin', 'task-planning')
  await skills.setBinding('companion-default', 'task-planning', true)
  await store.update(state => { state.companions[0].capabilities = ['skills'] })
  const tools = new Map()
  const executor = { execute() { assert.fail('inline planning must stay in current scope') } }
  const composer = new PartnerAgentComposition(store, skills, board, service, {}, executor, {})
  const dispose = await composer.compose({ tools: { register(tool) { tools.set(tool.name, tool); return () => {} } }, systemPrompt: { section() { return () => {} } } }, store.snapshot().companions[0])
  t.after(dispose)
  const result = JSON.parse(await tools.get('partner_skill').execute({ action: 'run', skillId: 'task-planning', input: '重新设计，分解任务，调研可行性' }, {}))
  assert.equal(result.execution, 'apply-in-current-session')
  assert.match(result.instructions, /临时子 Agent 不会自动成为看板任务/)
  assert.match(result.instructions, /先提交调研与验证任务/)
  assert.equal(result.runId, undefined)
  assert.ok(tools.has('partner_task_board'))
})

test('planning upgrade preserves bindings, refreshes next-turn configuration and exposes metadata and loads the installed policy on demand', async t => {
  const { store, board, skills, service } = await fixture(t)
  await skills.initialize()
  const previous = await skills.repository.install({
    id: 'task-planning', source: 'builtin', sourceId: 'builtin', trusted: true,
    document: '---\nname: task-planning\ndescription: 旧版规划\nversion: 1.2.0\ncontext: inline\n---\n旧版规划指令',
  })
  await store.update(state => {
    state.skills.push(previous)
    state.companions[0].capabilities = ['skills']
    state.companions.push({ ...structuredClone(state.companions[0]), id: 'disabled', name: '未启用规划' })
    state.sessions.push({ id: 'local', kind: 'local', channelId: '@local', userId: 'owner', companionId: 'companion-default', sessionId: 'planning-session', lastMessageAt: 1 })
  })
  await skills.setBinding('companion-default', 'task-planning', true)
  await skills.setBinding('disabled', 'task-planning', false)
  const bindings = structuredClone(store.snapshot().skillBindings)
  const index = new SessionConfigurationIndex(store)
  t.after(() => index.close())
  const before = index.forSession('planning-session').revision
  await skills.initialize()
  const loaded = await skills.load('task-planning')
  assert.equal(loaded.version, TASK_PLANNING_VERSION)
  assert.equal(loaded.description, BUILTIN_SKILLS.get('task-planning').entry.description)
  assert.equal(loaded.body, parseSkillDocument(TASK_PLANNING_DOCUMENT).body.trim())
  assert.deepEqual(store.snapshot().skillBindings, bindings)
  assert.notEqual(index.forSession('planning-session').revision, before)
  const after = index.forSession('planning-session').revision
  await skills.initialize()
  assert.equal(index.forSession('planning-session').revision, after)
  const composer = new PartnerAgentComposition(store, skills, board, service, {}, {}, {})
  for (const companion of store.snapshot().companions) {
    const sections = []
    const dispose = await composer.compose({ tools: { register: () => () => {} }, systemPrompt: { section: section => { sections.push(section); return () => {} } } }, companion)
    const occurrences = sections.map(section => section.text).join('\n').split(loaded.body).length - 1
    assert.equal(occurrences, 0)
    dispose()
  }
})

test('builtin upgrade does not replace a locally maintained planning skill', async t => {
  const { skills } = await fixture(t)
  const installed = await skills.installLocal('---\nname: task-planning\ndescription: 用户自己的分工规则\ncontext: inline\n---\n保留用户自己的策略。', 'task-planning')
  await skills.initialize()
  assert.equal((await skills.load(installed.id)).checksum, installed.checksum)
})

test('tool guidance connects requests, specialists and the planning Skill without a preflight gate', async t => {
  const { store, board, skills, service } = await fixture(t)
  await skills.installMarket('builtin', 'task-planning')
  await skills.setBinding('companion-default', 'task-planning', true)
  await store.update(state => { state.companions[0].capabilities = ['skills'] })
  const tools = new Map(), sections = []
  const composer = new PartnerAgentComposition(store, skills, board, service, {}, {}, {})
  const dispose = await composer.compose({
    tools: {
      register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) },
      guard() { assert.fail('routing guidance must not add an execution guard') },
    },
    systemPrompt: { section(value) { sections.push(value); return () => {} } },
  }, store.snapshot().companions[0])
  assert.deepEqual([...tools.keys()].sort(), ['partner_activity_finish', 'partner_affection', 'partner_code_execute', 'partner_code_status', 'partner_collaborate', 'partner_identity', 'partner_requirements', 'partner_skill', 'partner_task_board', 'partner_thoughts', 'partner_work_execute', 'partner_workflow'])
  for (const name of [...tools.keys()].filter(name => !['partner_thoughts', 'partner_affection', 'partner_identity', 'partner_activity_finish', 'partner_code_execute', 'partner_code_status', 'partner_work_execute', 'partner_workflow'].includes(name))) assert.match(tools.get(name).description, /enabled task-planning Skill/)
  assert.match(tools.get('partner_code_execute').description, /用户明确要求 Codex CLI\/Codex 子 Agent.*也使用本工具/)
  assert.match(sections.map(section => section.text).join('\n'), /失败时明确报告并停止/)
  assert.match(sections.map(section => section.text).join('\n'), /直接调用顶层 partner_code_execute/)
  assert.doesNotMatch(sections.map(section => section.text).join('\n'), /当前伙伴作用域中的 subagent_codex 是插件提供/)
  assert.match(sections.map(section => section.text).join('\n'), /用户明确要求 Codex CLI\/Codex 子 Agent 完成的其他任务.*包括写作、分析等/s)
  assert.match(tools.get('partner_task_board').description, /no explicit @ or board request/)
  assert.match(tools.get('partner_collaborate').description, /do not duplicate already-assigned work/)
  assert.equal(sections.some(section => section.name.includes('preflight')), false)
  assert.equal(parseSkillDocument(TASK_PLANNING_DOCUMENT).metadata.has('phase'), false)
  dispose()
  assert.equal(tools.size, 0)
})

test('unified tool discovery routes Codex work through the plugin gateway, without shadowing the host tool', async t => {
  const { store, board, skills, service } = await fixture(t)
  const sessionId = 'codex-discovery-routing'
  await store.update(state => {
    state.companions[0].toolDiscovery = true
    state.sessions.push({ id: 'codex-discovery-route', kind: 'local', companionId: 'companion-default', sessionId, channelId: '@local', userId: 'owner' })
  })
  const companion = store.snapshot().companions[0]
  const registered = new Map(), sections = [], routed = [], sessionEvents = []
  const globalCodexTool = {
    name: 'subagent_codex', description: '原始全局后台 Codex 工具',
    parameters: { type: 'object', properties: { description: { type: 'string' }, prompt: { type: 'string' }, cwd: { type: 'string' } }, required: ['prompt'] },
    output: { schema: { type: 'object' }, render: () => [] },
    async execute() { assert.fail('伙伴 Codex 委派不得调用 DSH 宿主后台工具') },
  }
  const runtime = {
    register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name) },
    get(name, scope) { return registered.get(name) ?? (scope === undefined && name === 'subagent_codex' ? globalCodexTool : undefined) },
    async execute(request) {
      const tool = registered.get(request.name)
      if (!tool) throw new Error(`unknown tool ${request.name}`)
      const value = await tool.execute(request.arguments, { agent: request.agent, signal: request.signal, callId: request.callId, rootCallId: request.rootCallId })
      return { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }
    },
  }
  const agent = { session: { id: sessionId, snapshotEvents: () => [], append(type, data) { sessionEvents.push({ type, data }) } }, ctx: { tools: runtime } }
  const composer = new PartnerAgentComposition(store, skills, board, service, {}, {}, {})
  composer.setCodeExecutionToolFactory(() => [{
    name: 'partner_code_execute', description: 'Codex 执行器', parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
    output: { schema: { type: 'object' }, render: () => [] }, timeoutMs: 10_000,
    async execute(args) { routed.push(args); return { provider: 'codex', status: 'completed', result: '夏日诗作已返回' } },
  }, {
    name: 'partner_code_status', description: 'Codex 状态', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [] }, async execute() { return { runs: [] } },
  }])
  const dispose = await composer.compose({ tools: runtime, systemPrompt: { section(value) { sections.push(value); return () => {} } } }, companion)
  t.after(dispose)

  // 统一入口模式只向模型公开 partner_tools；宿主工具保留宿主自己的顶层入口。
  assert.equal(registered.has('partner_code_execute'), true, 'internal code tool remains registered for gateway execution')
  assert.equal(registered.has('partner_tools'), true)
  assert.equal(registered.has('subagent_codex'), false, 'the plugin never registers a colliding host tool name')
  assert.equal(runtime.get('subagent_codex'), globalCodexTool, 'the host tool remains intact in the global view')
  const visibleTopLevel = [...registered.values()].filter(tool => PARTNER_TOOL_ENTRIES.includes(tool.name) || !isPartnerDiscoveryTool(store, companion.id, tool.name))
  assert.equal(visibleTopLevel.some(tool => tool.name === 'partner_code_execute'), false, 'internal code tool is removed from the model-facing top-level list')
  assert.equal(visibleTopLevel.some(tool => tool.name === 'subagent_codex'), false, 'the host tool is not added to the partner plugin top-level list')
  const listed = await registered.get('partner_tools').execute({ action: 'list', category: 'work', query: 'partner_code_execute' }, {
    agent, signal: new AbortController().signal, callId: 'list-code-tool',
  })
  assert.ok(listed.tools.some(tool => tool.name === 'partner_code_execute'))
  const task = { task: '请用 Codex 写一首夏日诗。', acceptanceCriteria: ['由 Codex 返回最终诗作'] }
  const dispatched = await registered.get('partner_tools').execute({
    action: 'call', name: 'partner_code_execute', argumentsJson: JSON.stringify(task),
  }, { agent, signal: new AbortController().signal, callId: 'invoke-code-tool', rootCallId: 'invoke-code-tool', token: {}, deferContext() {}, concludeTurn() {} })
  assert.deepEqual(routed, [task], 'the partner gateway passes the structured arguments to its own Codex provider tool')
  assert.equal(dispatched.dispatch.isError, false)
  assert.match(dispatched.dispatch.content[0].text, /夏日诗作已返回/)
  assert.ok(sessionEvents.some(event => event.type === 'tool/ptc-dispatch-start' && event.data.name === 'partner_code_execute'))
  const prompt = sections.map(section => section.text).join('\n')
  assert.match(prompt, /统一工具入口：通过顶层 partner_tools 直接执行 action=call，name=partner_code_execute/)
  assert.match(prompt, /不要调用 DSH 宿主的 subagent_codex、job_output 或 job_list/)
  assert.match(prompt, /需要查询运行记录时也通过 partner_tools action=call 调用 partner_code_status/)
})

test('one authorized specialist deliverable dispatches without artificial decomposition and hides disabled capabilities', async t => {
  const { store, board, skills, service, calls } = await fixture(t)
  await skills.initialize()
  await skills.installMarket('builtin', 'technical-research')
  await store.update(state => {
    state.companions.push({ ...structuredClone(state.companions[0]), id: 'researcher', name: '资料专家', role: '技术调研', description: '整理可追溯资料', capabilities: ['skills'] })
    state.companions.push({ ...structuredClone(state.companions[0]), id: 'private', name: '未授权专家' })
  })
  await skills.setBinding('researcher', 'technical-research', true)
  await service.replaceAccessTargets('companion-default', ['researcher'])
  assert.deepEqual(service.directoryFor('companion-default').map(item => item.id), ['researcher'])
  assert.equal(service.directoryFor('companion-default')[0].enabledSkills.length, 1)
  const tools = []
  const composer = new PartnerAgentComposition(store, skills, board, service, {}, {}, {})
  const dispose = await composer.compose({ tools: { register: tool => { tools.push(tool); return () => {} } }, systemPrompt: { section: () => () => {} } }, store.snapshot().companions[0])
  t.after(dispose)
  const tool = tools.find(tool => tool.name === 'partner_task_board')
  const exec = { agent: { session: { id: 'creator-session' } } }
  await assert.rejects(tool.execute({ action: 'create', title: '越权分工', assignee: 'private' }, exec), /未获授权/)
  assert.equal(store.snapshot().tasks.length, 0)
  const requirement = JSON.parse(await tools.find(t => t.name === 'partner_requirements').execute({ action: 'create', title: '资料交付' }, exec))
  const task = JSON.parse(await tool.execute({ action: 'create', requirementId: requirement.id, title: '整理资料', description: '按现有来源整理资料，交付附出处的文档，不扩大研究范围。', assignee: 'researcher' }, exec))
  assert.equal(task.execution, 'submitted')
  assert.deepEqual(task.assignment.executor, { id: 'researcher', name: '资料专家' })
  assert.equal(task.assignment.reviewer.id, 'companion-default')
  assert.equal(task.assignment.selfExecution, false)
  assert.equal(task.assignment.autoRun, true)
  await waitFor(() => board.require(task.id).status === 'review')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].companion.id, 'researcher')
  assert.equal(store.snapshot().tasks.length, 1)
  assert.equal(board.require(task.id).reviewerCompanionId, 'companion-default')
  const planned = JSON.parse(await tool.execute({ action: 'create', requirementId: requirement.id, title: '显式分工只保存', status: 'ready', assignee: 'companion-default', reviewer: 'researcher', autoRun: false }, exec))
  assert.equal(planned.assignment.executor.id, 'companion-default')
  assert.equal(planned.assignment.reviewer.id, 'researcher')
  assert.equal(planned.assignment.selfExecution, true)
  assert.equal(planned.assignment.autoRun, false)
  assert.match(planned.assignment.summary, /即使 status=ready 也不会自动执行/)
  await service.dispatchReadyTasks()
  assert.equal(calls.length, 1)
  const updated = JSON.parse(await tool.execute({ action: 'update', taskId: planned.id, expectedRevision: planned.revision, assignee: 'researcher', reviewer: 'companion-default' }, exec))
  assert.equal(updated.assignment.executor.id, 'researcher')
  assert.equal(updated.assignment.reviewer.id, 'companion-default')
  assert.equal(updated.assignment.autoRun, false)
  assert.equal(board.require(planned.id).assigneeCompanionId, 'researcher')
  await store.update(state => { state.companions.find(item => item.id === 'researcher').capabilities = [] })
  assert.deepEqual(service.directoryFor('companion-default')[0].enabledSkills, [])
  assert.equal(skills.bindings('researcher').length, 1, 'retain saved selection while the skills capability is disabled')
})

test('assigned create tool submits automatically, reports the Skill protocol, and honors planning-only', async t=>{
  const {store,board,skills,service,calls}=await fixture(t)
  await skills.initialize();await skills.installMarket('builtin','task-planning');await skills.setBinding('companion-default','task-planning',true)
  await store.update(s=>{s.companions[0].capabilities=['skills']})
  const tools=[],sections=[]
  const composition=new PartnerAgentComposition(store,skills,board,service,{},{},{})
  await composition.compose({tools:{register:tool=>{tools.push(tool);return()=>{}}},systemPrompt:{section:section=>{sections.push(section);return()=>{}}}},store.snapshot().companions[0])
  assert.match(sections.map(s=>s.text).join('\n'),/主动应用/)
  assert.match(sections.map(s=>s.text).join('\n'),/无需用户补充触发词/)
  const tool=tools.find(t=>t.name==='partner_task_board'),exec={agent:{session:{id:'creator-session'}}}
  const requirement=JSON.parse(await tools.find(t=>t.name==='partner_requirements').execute({action:'create',title:'分阶段交付'},exec))
  const planned=JSON.parse(await tool.execute({action:'create',requirementId:requirement.id,title:'先规划',assignee:'companion-default',autoRun:false},exec))
  assert.equal(planned.execution,'planning-only');assert.equal(planned.status,'backlog')
  const work=JSON.parse(await tool.execute({action:'create',requirementId:requirement.id,title:'交付任务',assignee:'companion-default'},exec))
  assert.equal(work.execution,'submitted');assert.equal(work.autoRun,true)
  await waitFor(()=>board.require(work.id).status==='review')
  assert.equal(calls.length,1);assert.equal(board.require(planned.id).status,'backlog')
})

test('continuation requires explicit ownership and never manufactures a requirement from dependencies', async t => {
  const { store, board, skills, service, calls } = await fixture(t)
  const tools = [], exec = { agent: { session: { id: 'creator-session' } } }
  const composition = new PartnerAgentComposition(store, skills, board, service, {}, {}, {})
  const dispose = await composition.compose({ tools: { register: tool => { tools.push(tool); return () => {} } }, systemPrompt: { section: () => () => {} } }, store.snapshot().companions[0])
  t.after(dispose)
  const taskTool = tools.find(t => t.name === 'partner_task_board'), requirementTool = tools.find(t => t.name === 'partner_requirements')
  await assert.rejects(taskTool.execute({ action: 'create', title: '缺少需求', assignee: 'companion-default' }, exec), /必须提供 requirementId/)
  assert.equal(store.snapshot().tasks.length, 0); assert.equal((store.snapshot().requirements ?? []).length, 0); assert.equal(calls.length, 0)
  const req = JSON.parse(await requirementTool.execute({ action: 'create', title: '同一交付目标' }, exec))
  const first = JSON.parse(await taskTool.execute({ action: 'create', requirementId: req.id, title: '产品原型', assignee: 'companion-default' }, exec))
  assert.equal(first.requirement.id, req.id)
  assert.ok(first.requirement.revision > req.revision)
  assert.equal(first.requirement.controlRevision, req.revision)
  await waitFor(() => board.require(first.id).status === 'review')
  await board.accept(first.id, actor)
  const accepted = board.require(first.id)
  await assert.rejects(taskTool.execute({ action: 'create', title: '继续视觉', assignee: 'companion-default', dependencyTaskIds: [first.id] }, exec), error => error.message.includes(req.id))
  assert.equal(store.snapshot().tasks.length, 1); assert.equal(store.snapshot().requirements.length, 1); assert.equal(calls.length, 1)
  const current = () => store.snapshot().requirements.find(r => r.id === req.id)
  const submitted = JSON.parse(await requirementTool.execute({ action: 'submit', requirementId: req.id, expectedRevision: req.revision }, exec))
  assert.equal(submitted.status, 'active', 'original create revision survives execution and acceptance')
  const conflict = JSON.parse(await taskTool.execute({ action: 'create', requirementId: req.id, title: '继续视觉', autoRun: false }, exec))
  assert.equal(conflict.code, 'REQUIREMENT_NOT_PLANNING')
  assert.equal(conflict.retryable, false)
  assert.equal(conflict.current.ownerCompanionId, 'companion-default')
  assert.match(conflict.recovery, /request_replan/)
  await requirementTool.execute({ action: 'reopen', requirementId: req.id, expectedRevision: current().revision, description: '保留产品原型，追加视觉阶段' }, exec)
  const second = JSON.parse(await taskTool.execute({ action: 'create', requirementId: req.id, title: '继续视觉', assignee: 'companion-default', dependencyTaskIds: [first.id] }, exec))
  await waitFor(() => board.require(second.id).status === 'review')
  assert.equal(store.snapshot().requirements.length, 1); assert.equal(calls.length, 2)
  assert.equal(second.requirementId, first.requirementId); assert.deepEqual(board.require(first.id), accepted)
  assert.match(calls[1].prompt, /保留产品原型，追加视觉阶段/)
})

test('four dependent tasks are submitted once and advance only after all prerequisites pass review',async t=>{
  const {board,service,calls,store}=await fixture(t)
  const a=await board.create({title:'收集',...assigned},actor)
  const b=await board.create({title:'核验',...assigned,dependencyTaskIds:[a.id]},actor)
  const c=await board.create({title:'另一路收集',...assigned},actor)
  const d=await board.create({title:'汇总',...assigned,dependencyTaskIds:[b.id,c.id]},actor)
  await service.dispatchReadyTasks()
  await waitFor(()=>board.require(a.id).status==='review'&&board.require(c.id).status==='review')
  assert.equal(calls.length,2);assert.equal(board.require(b.id).status,'ready');assert.equal(board.require(d.id).status,'ready')
  assert.equal(store.snapshot().delegations.filter(d=>d.kind!=='review').length,4)
  await service.dispatchReadyTasks();await waitFor(()=>service.active.size===0);assert.equal(calls.length,2)
  await board.accept(a.id,actor);await service.dispatchReadyTasks()
  await waitFor(()=>board.require(b.id).status==='review')
  // Review status is persisted before the executor finishes its final bookkeeping.
  // Manual acceptance must wait for that in-flight update, as it does for task A above.
  await waitFor(()=>service.active.size===0)
  await board.accept(b.id,actor);await service.dispatchReadyTasks();assert.equal(calls.length,3)
  await board.accept(c.id,actor);await service.dispatchReadyTasks()
  await waitFor(()=>board.require(d.id).status==='review');assert.equal(calls.length,4)
  assert.match(calls[3].prompt,/已验收前置任务的公开产出/)
  assert.match(calls[3].prompt,/真实产出/)
  assert.equal(store.snapshot().delegations.filter(d=>d.kind!=='review').length,4)
})

test('explicit delegation accepts pending dependencies, repeated submissions share one job, and revocation stops it',async t=>{
  const {board,service,calls,store}=await fixture(t)
  await store.update(s=>s.companions.push({...structuredClone(s.companions[0]),id:'worker',name:'执行者'}))
  await service.replaceAccessTargets('companion-default',['worker'])
  const parent=await board.create({title:'前置'},{kind:'user'})
  const work=await board.create({title:'后续',dependencyTaskIds:[parent.id]},actor)
  const input={taskId:work.id,initiatedBy:'companion',fromCompanionId:'companion-default',to:'worker',request:'实际执行'}
  const jobs=await Promise.all([service.delegate(input),service.delegate(input)])
  assert.equal(jobs[0].id,jobs[1].id);assert.equal(jobs[0].status,'queued');assert.equal(calls.length,0)
  await service.replaceAccessTargets('companion-default',[]);await service.dispatchReadyTasks()
  assert.equal(calls.length,0);assert.equal(board.require(work.id).status,'blocked')
  assert.match(store.snapshot().delegations[0].error,/授权已撤回/)
})

test('durable execution intent survives restart, without starting legacy ready tasks',async t=>{
  const {root,board,service}=await fixture(t)
  const legacy=await board.create({title:'旧任务',status:'ready',assigneeCompanionId:'companion-default'},{kind:'user'})
  const work=await board.create({title:'提交后立即重启',...assigned},actor)
  await service.close()
  const restored=await PartnerStore.open(join(root,'state.json')), tasks=new TaskBoardService(restored)
  const second=new PartnerCollaborationService(restored,{},tasks,{execute:async()=>({run:{id:'restored'},output:'重启后执行'})})
  t.after(()=>second.close())
  await second.start();await waitFor(()=>tasks.require(work.id).status==='review')
  assert.equal(tasks.require(legacy.id).status,'ready')
})

test('direct submissions obey the shared concurrency limit',async t=>{
  const {board,service,store}=await fixture(t)
  let release;const pending=new Promise(resolve=>{release=resolve});let running=0,peak=0
  service.setSessionExecutor({execute:async()=>{running++;peak=Math.max(peak,running);await pending;running--;return{run:{id:'bounded'},output:'完成'}}})
  try {
  const tasks=[];for(let i=0;i<5;i++)tasks.push(await board.create({title:'并行 '+i},{kind:'user'}))
  await Promise.all(tasks.map(task=>service.delegate({taskId:task.id,initiatedBy:'user',to:'companion-default',request:'执行'})))
  assert.equal(peak,3);assert.equal(store.snapshot().delegations.filter(d=>d.status==='queued').length,2)
  release();await waitFor(()=>running===0);await waitFor(()=>store.snapshot().delegations.filter(d=>d.status==='running').length===0)
  await service.dispatchReadyTasks();await waitFor(()=>tasks.every(t=>board.require(t.id).status==='review'))
  assert.ok(peak<=3)
  } finally { release() }
})

test('switching submitted work to planning-only cancels waiting execution without affecting other tasks',async t=>{
  const {board,service,calls,store}=await fixture(t)
  const parent=await board.create({title:'前置'},{kind:'user'})
  const child=await board.create({title:'暂不执行',...assigned,dependencyTaskIds:[parent.id]},actor)
  await service.dispatchReadyTasks()
  const current=board.require(child.id)
  await board.update(child.id,{expectedRevision:current.revision,autoRun:false},actor)
  assert.equal(store.snapshot().delegations[0].status,'canceled')
  const p=await board.update(parent.id,{expectedRevision:1,status:'doing'},{kind:'user'})
  await board.completeExecution(p.id,'产出',actor);await board.accept(p.id,actor)
  await service.dispatchReadyTasks();assert.equal(calls.length,0)
  assert.equal(board.require(child.id).status,'ready')
})

test('removing the assignee while queued prevents dispatch to the old companion',async t=>{
  const {board,service,calls,store}=await fixture(t)
  const parent=await board.create({title:'前置'},{kind:'user'})
  const child=await board.create({title:'取消负责人',...assigned,dependencyTaskIds:[parent.id]},actor)
  await service.dispatchReadyTasks()
  await board.update(child.id,{expectedRevision:board.require(child.id).revision,assigneeCompanionId:''},actor)
  const p=await board.update(parent.id,{expectedRevision:1,status:'doing'},{kind:'user'})
  await board.completeExecution(p.id,'产出',actor);await board.accept(p.id,actor)
  await service.dispatchReadyTasks()
  assert.equal(calls.length,0);assert.equal(store.snapshot().delegations[0].status,'canceled')
})
