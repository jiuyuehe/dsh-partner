import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { createServer } from 'node:http'
import { PartnerStore } from '../lib/store.js'
import { SkillRepository } from '../lib/skills/repository.js'
import { SkillService } from '../lib/skills/service.js'
import { loadSkill } from '../lib/skills/loader.js'
import { TaskBoardService, TaskConflictError } from '../lib/tasks/service.js'
import { nextOccurrence } from '../lib/scheduler/service.js'
import { PartnerCollaborationService } from '../lib/collaboration/service.js'
import { EphemeralExecutionService } from '../lib/execution/service.js'
import { PartnerAgentComposition } from '../lib/collaboration/composition.js'
import { CompanionService } from '../lib/companions/service.js'
import { dispatchPartnerWorkspaceApi } from '../lib/api/features/workspace-api.js'
import { registerPartnerApi } from '../lib/api.js'
import { parseMarketResponse } from '../lib/skills/markets/adapters.js'
import { builtinMarketSources } from '../lib/skills/markets/builtin.js'
import { requestRemoteText } from '../lib/skills/network.js'
import { extractSkillMarkdown } from '../lib/skills/zip.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-partner-workspace-'))
  const store = await PartnerStore.open(join(root, 'state.json'))
  return { root, store, close: () => rm(root, { recursive: true, force: true }) }
}

function request(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)])
  return Object.assign(req, { method, url, headers: { host: 'localhost', origin: 'http://localhost', 'x-dsh-partner-request': '1' } })
}

function response() {
  return { statusCode: 0, body: '', setHeader() {}, end(value) { this.body = value?.toString() ?? '' } }
}

test('migrated store exposes all bounded workspace domains', async t => {
  const item = await fixture(); t.after(item.close)
  const state = item.store.snapshot()
  assert.equal(state.schemaVersion, 14)
  for (const key of ['skills', 'skillBindings', 'tasks', 'taskActivities', 'delegations', 'companionAccessGrants', 'schedules', 'executionRuns']) assert.deepEqual(state[key], [])
  assert.deepEqual(state.skillMarketSources.map(source => source.name), ['ClawHub', 'LoopHub', 'SkillHub'])
  assert.deepEqual(state.skillMarketNetwork, {})
})

test('built-in market installs separately from companion binding', async t => {
  const item = await fixture(); t.after(item.close)
  const service = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  await service.initialize()
  const market = await service.market()
  assert.ok(market.entries.some(entry => entry.id === 'technical-research'))
  const installed = await service.installMarket('builtin', 'technical-research')
  assert.equal(installed.executionContext, 'fork')
  assert.equal(service.bindings('companion-default').length, 0)
  await service.setBinding('companion-default', installed.id, true)
  assert.deepEqual(service.bindings('companion-default').map(skill => skill.id), ['technical-research'])
})

test('nomifun-compatible market adapters normalize ClawHub, LoopHub and SkillHub rankings', () => {
  const [clawhub, loophub, skillhub] = builtinMarketSources(1)
  const claw = parseMarketResponse({ value: { page: [{ ownerHandle: 'alice', skill: { slug: 'web-audit', displayName: 'Web Audit', summary: 'Audit sites', topics: ['web'], isSuspicious: false }, latestVersion: { version: '1.2.0' } }] } }, clawhub)
  const loop = parseMarketResponse({ data: { items: [{ author: 'bob', name: 'Planner', brief: 'Plan work', category: 'productivity', security_level: 'A', download_url: 'https://dl.cocoloop.cn/bss/skills/bob-planner-2.0.1.zip' }] } }, loophub)
  const hub = parseMarketResponse({ data: { skills: [{ name: 'Research', slug: 'research', description_zh: '资料研究', version: '3.0.0', namespace: { canonicalName: '@carol/research', handle: 'carol' }, subCategories: [{ name: '检索' }] }] } }, skillhub)
  assert.deepEqual([claw.length, loop.length, hub.length], [1, 1, 1])
  assert.equal(claw[0].skillUrl, 'https://clawhub.ai/api/v1/download?slug=web-audit&version=1.2.0')
  assert.equal(loop[0].version, '2.0.1')
  assert.equal(hub[0].skillUrl, 'https://api.skillhub.cn/api/v1/download?slug=research')
  assert.ok([claw[0], loop[0], hub[0]].every(entry => entry.installKind === 'zip'))
})

test('Skill market proxy settings are local and the bounded client routes HTTP requests through them', async t => {
  const item = await fixture(); t.after(item.close)
  let requestedUrl = ''
  const proxy = createServer((req, res) => { requestedUrl = req.url ?? ''; res.setHeader('content-type', 'text/plain'); res.end('proxied') })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => proxy.close(resolve)))
  const address = proxy.address()
  const proxyUrl = `http://127.0.0.1:${address.port}`
  const text = await requestRemoteText({ url: 'http://market.invalid/index.json', proxyUrl, maxBytes: 1024, timeoutMs: 2_000 })
  assert.equal(text, 'proxied')
  assert.equal(requestedUrl, 'http://market.invalid/index.json')
  const service = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  assert.deepEqual(await service.setNetworkSettings({ proxyUrl }), { proxyUrl: `${proxyUrl}/` })
  assert.deepEqual(service.networkSettings(), { proxyUrl: `${proxyUrl}/` })
  await assert.rejects(() => service.setNetworkSettings({ proxyUrl: 'socks5://127.0.0.1:1080' }), /仅支持 http/)
})

test('HTTPS proxy resets reject the current request without escaping as an uncaught socket error', async t => {
  const proxy = createServer()
  proxy.on('connect', (_req, socket) => {
    socket.on('error', () => {})
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    setImmediate(() => socket.destroy())
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => proxy.close(resolve)))
  const address = proxy.address()
  await assert.rejects(() => requestRemoteText({
    url: 'https://market.invalid/SKILL.md',
    proxyUrl: `http://127.0.0.1:${address.port}`,
    maxBytes: 1024,
    timeoutMs: 2_000,
  }))
})

test('locally authored Skill documents install through the same bounded repository', async t => {
  const item = await fixture(); t.after(item.close)
  const service = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  await service.initialize()
  const installed = await service.installLocal(`---\nname: 本地审阅\ndisplay-name: 本地审阅\ndescription: 审阅本地变更\nversion: 1.0.0\ncontext: fork\nallowed-tools:\n  - read\n  - grep\n---\n# 本地审阅\n\n检查变更并给出证据。`, 'local-review')
  assert.equal(installed.source, 'local')
  assert.equal(installed.name, '本地审阅')
  assert.equal(installed.displayName, '本地审阅')
  assert.deepEqual(installed.allowedTools, ['read', 'grep'])
})

test('Skill ZIP accepts case-insensitive SKILL.md and an unambiguous single Markdown document', () => {
  const preferred = storedZip([
    { name: 'package/README.md', body: 'Package notes' },
    { name: 'package/skill.md', body: '---\nname: 中文技能\n---\n执行技能' },
  ])
  assert.match(extractSkillMarkdown(preferred, 4096), /name: 中文技能/)
  const single = storedZip([{ name: '发布检查.md', body: '# 发布检查\n执行检查' }])
  assert.match(extractSkillMarkdown(single, 4096), /执行检查/)
  assert.throws(() => extractSkillMarkdown(storedZip([
    { name: 'README.md', body: '说明' }, { name: 'GUIDE.md', body: '指南' },
  ]), 4096), /multiple Markdown files/)
})

test('untrusted Skill cannot request inline execution and tampering is detected', async t => {
  const item = await fixture(); t.after(item.close)
  const repository = new SkillRepository(join(item.root, 'skills'))
  const document = `---\nname: guarded\ndescription: guarded test\ncontext: inline\n---\nDo the bounded work.`
  const skill = await repository.install({ id: 'guarded', document, source: 'market', sourceId: 'test', trusted: false })
  assert.equal(skill.executionContext, 'fork')
  await writeFile(join(skill.rootPath, 'SKILL.md'), `${await readFile(join(skill.rootPath, 'SKILL.md'), 'utf8')}\nchanged`)
  const loaded = await loadSkill({ id: skill.id, rootPath: skill.rootPath, source: skill.source, sourceId: 'test', trusted: false, installedAt: skill.installedAt, updatedAt: skill.updatedAt })
  assert.notEqual(loaded.checksum, skill.checksum)
})

test('task board rejects stale concurrent updates and records activities', async t => {
  const item = await fixture(); t.after(item.close)
  const board = new TaskBoardService(item.store)
  const task = await board.create({ title: '实现看板', priority: 'high' }, { kind: 'user' })
  const moved = await board.update(task.id, { expectedRevision: 1, status: 'doing' }, { kind: 'companion', companionId: 'companion-default' })
  assert.equal(moved.revision, 2)
  await assert.rejects(() => board.update(task.id, { expectedRevision: 1, status: 'done' }, { kind: 'user' }), TaskConflictError)
  assert.equal(board.snapshot().activities.length, 2)
})

test('task dependencies block execution, reject cycles and unlock only after accepted completion', async t => {
  const item = await fixture(); t.after(item.close)
  const board = new TaskBoardService(item.store)
  const prerequisite = await board.create({ title: '完成基础能力' }, { kind: 'user' })
  const dependent = await board.create({ title: '推进后续工作', dependencyTaskIds: [prerequisite.id] }, { kind: 'user' })
  assert.throws(() => board.assertStartable(dependent.id), /前置任务尚未完成/)
  await assert.rejects(() => board.update(prerequisite.id, { expectedRevision: prerequisite.revision, dependencyTaskIds: [dependent.id] }, { kind: 'user' }), /循环/)
  const doing = await board.update(prerequisite.id, { expectedRevision: prerequisite.revision, status: 'doing' }, { kind: 'user' })
  const review = await board.completeExecution(doing.id, '基础能力已完成并通过测试', { kind: 'companion', companionId: 'companion-default' })
  await board.accept(review.id, { kind: 'user' })
  assert.equal(board.assertStartable(dependent.id).id, dependent.id)
})

test('task results, reviewer opinions and terminal progress notifications stay on the task', async t => {
  const item = await fixture(); t.after(item.close)
  await item.store.update(state => state.companions.push({
    ...structuredClone(state.companions[0]), id: 'companion-reviewer', name: '审阅伙伴', createdAt: 2, updatedAt: 2,
  }))
  const board = new TaskBoardService(item.store)
  const notifications = []
  board.setProgressNotifier(async (task, previousStatus) => { notifications.push({ task, previousStatus }) })
  const selfReviewed = await board.create({ title: '同一伙伴执行并验收', assigneeCompanionId: 'companion-default', reviewerCompanionId: 'companion-default' }, { kind: 'user' })
  assert.equal(selfReviewed.reviewerCompanionId, 'companion-default')
  const defaultReviewed = await board.create({ title: '创建伙伴默认验收' }, { kind: 'companion', companionId: 'companion-default' })
  assert.equal(defaultReviewed.reviewerCompanionId, 'companion-default')
  const task = await board.create({
    title: '生成可验收产出', assigneeCompanionId: 'companion-default', reviewerCompanionId: 'companion-reviewer', creatorSessionId: 'session-owner',
  }, { kind: 'companion', companionId: 'companion-default' })
  const doing = await board.update(task.id, { expectedRevision: task.revision, status: 'doing' }, { kind: 'companion', companionId: 'companion-default' })
  const review = await board.completeExecution(doing.id, '产出文件与测试证据', { kind: 'companion', companionId: 'companion-default' })
  const inspected = await board.recordReview(review.id, '建议通过：证据完整', { kind: 'companion', companionId: 'companion-reviewer' })
  const done = await board.accept(inspected.id, { kind: 'user' })
  assert.equal(done.resultSummary, '产出文件与测试证据')
  assert.equal(done.reviewSummary, '建议通过：证据完整')
  assert.equal(notifications.length, 2)
  assert.equal(notifications[0].previousStatus, 'doing')
  assert.equal(notifications[0].task.status, 'review')
  assert.equal(notifications[1].previousStatus, 'review')
  assert.equal(notifications[1].task.status, 'done')
})

test('submitting a result notifies review even when the worker moved the task early', async t => {
  const item = await fixture(); t.after(item.close)
  const board = new TaskBoardService(item.store)
  const notifications = []
  board.setProgressNotifier(async (task, previousStatus) => { notifications.push({ task, previousStatus }) })
  const task = await board.create({ title: '提前转待验收' }, { kind: 'companion', companionId: 'companion-default' })
  const doing = await board.update(task.id, { expectedRevision: task.revision, status: 'doing' }, { kind: 'companion', companionId: 'companion-default' })
  await assert.rejects(board.update(doing.id, { expectedRevision: doing.revision, status: 'review' }, { kind: 'companion', companionId: 'companion-default' }), /submit_result/)
  const premature = doing
  assert.equal(notifications.length, 0)
  await board.completeExecution(premature.id, '现在才有可验收的真实结果', { kind: 'companion', companionId: 'companion-default' })
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0].task.resultSummary, '现在才有可验收的真实结果')
})

test('delegation returns after assignment while execution continues in the background', async t => {
  const item = await fixture(); t.after(item.close)
  const skills = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  const board = new TaskBoardService(item.store)
  const task = await board.create({ title: '异步执行任务' }, { kind: 'user' })
  let finish
  const execution = new Promise(resolve => { finish = resolve })
  const service = new PartnerCollaborationService(item.store, skills, board, {
    execute: async () => { throw new Error('delegation should use the companion session executor') },
  })
  service.setSessionExecutor({ execute: async () => { await execution; return { run: { id: 'session-run-async' }, output: '后台执行完成' } } })
  const delegated = await service.delegate({ taskId: task.id, initiatedBy: 'user', to: 'companion-default', request: '开始执行' })
  assert.equal(delegated.status, 'running')
  assert.equal(board.require(task.id).status, 'doing')
  finish()
  await waitFor(() => board.require(task.id).status === 'review')
  assert.equal(board.require(task.id).resultSummary, '后台执行完成')
})

test('orchestrator preserves output when an executing companion moves its task to review early', async t => {
  const item = await fixture(); t.after(item.close)
  const skills = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  const board = new TaskBoardService(item.store)
  const task = await board.create({ title: '提前移动状态' }, { kind: 'user' })
  const service = new PartnerCollaborationService(item.store, skills, board, {})
  service.setSessionExecutor({ execute: async () => {
    const current = board.require(task.id)
    await item.store.update(state => { state.tasks.find(t => t.id === task.id).status = 'review' }) // Legacy persisted state, no longer allowed through update.
    return { run: { id: 'session-run-early-review' }, output: '状态提前移动，但这个结果必须保留' }
  } })
  t.after(() => service.close())
  const delegation = await service.delegate({ taskId: task.id, initiatedBy: 'user', to: 'companion-default', request: '完成任务' })
  await waitFor(() => Boolean(board.require(task.id).resultSummary))
  assert.equal(board.require(task.id).status, 'review')
  assert.equal(board.require(task.id).resultSummary, '状态提前移动，但这个结果必须保留')
  await waitFor(() => item.store.snapshot().delegations.find(entry => entry.id === delegation.id)?.status === 'completed')
})

test('interrupted delegations are durably reclaimed after restart without blocking the task', async t => {
  const item = await fixture(); t.after(item.close)
  const skills = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  const board = new TaskBoardService(item.store)
  const task = await board.create({ title: '恢复中的任务' }, { kind: 'user' })
  await board.update(task.id, { expectedRevision: task.revision, status: 'doing', assigneeCompanionId: 'companion-default' }, { kind: 'user' })
  await item.store.update(state => state.delegations.push({
    id: 'delegation-interrupted', kind: 'task', taskId: task.id, initiatedBy: 'user', toCompanionId: 'companion-default',
    request: '完成中断前的工作', status: 'running', attempts: 1, createdAt: Date.now() - 60_000, startedAt: Date.now() - 50_000,
  }))
  const service = new PartnerCollaborationService(item.store, skills, board, {})
  service.setSessionExecutor({ execute: async ({ prompt }) => {
    assert.match(prompt, /中断后的第 2 次恢复执行/)
    assert.match(prompt, /避免重复写入、重复提交、重复发布/)
    return { run: { id: 'session-run-recovered' }, output: '恢复执行完成' }
  } })
  t.after(() => service.close())
  await service.start()
  await waitFor(() => item.store.snapshot().delegations.find(entry => entry.id === 'delegation-interrupted')?.status === 'completed')
  const delegation = item.store.snapshot().delegations.find(entry => entry.id === 'delegation-interrupted')
  assert.equal(delegation.status, 'completed')
  assert.equal(delegation.attempts, 2)
  assert.equal(board.require(task.id).resultSummary, '恢复执行完成')
  assert.ok(board.snapshot().activities.some(activity => activity.kind === 'recovered'))
})

test('startup repairs legacy canceled delegations that reached review without saving a result', async t => {
  const item = await fixture()
  let service
  t.after(async () => { await service?.close(); await item.close() })
  const skills = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  const board = new TaskBoardService(item.store)
  const task = await board.create({ title: '修复丢失结果' }, { kind: 'user' })
  const doing = await board.update(task.id, { expectedRevision: task.revision, status: 'doing' }, { kind: 'user' })
  await item.store.update(state => { state.tasks.find(t => t.id === task.id).status = 'review' }) // Legacy persisted state, no longer allowed through update.
  await item.store.update(state => state.delegations.push({
    id: 'delegation-lost-result', kind: 'task', taskId: task.id, initiatedBy: 'user', toCompanionId: 'companion-default',
    request: '恢复丢失的结果', status: 'canceled', attempts: 2, error: '任务状态已经变为 review，忽略旧执行结果',
    createdAt: Date.now() - 30_000, completedAt: Date.now() - 10_000,
  }))
  service = new PartnerCollaborationService(item.store, skills, board, {})
  service.setSessionExecutor({ execute: async () => ({ run: { id: 'session-run-repaired' }, output: '重新恢复的完整结果' }) })
  await service.start()
  await waitFor(() => board.require(task.id).resultSummary === '重新恢复的完整结果')
  assert.equal(board.require(task.id).status, 'review')
  assert.equal(item.store.snapshot().delegations.find(entry => entry.id === 'delegation-lost-result').attempts, 3)
  assert.ok(board.snapshot().activities.some(activity => activity.message.includes('未保存执行结果')))
})

test('transient network failures stay in progress and enter the durable retry queue', async t => {
  const item = await fixture(); t.after(item.close)
  const skills = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  const board = new TaskBoardService(item.store)
  const task = await board.create({ title: '等待网络恢复' }, { kind: 'user' })
  const service = new PartnerCollaborationService(item.store, skills, board, {})
  service.setSessionExecutor({ execute: async () => { throw new TypeError('fetch failed: ECONNRESET') } })
  t.after(() => service.close())
  const delegation = await service.delegate({ taskId: task.id, initiatedBy: 'user', to: 'companion-default', request: '联网完成任务' })
  await waitFor(() => item.store.snapshot().delegations.find(entry => entry.id === delegation.id)?.status === 'queued' && board.snapshot().activities.some(activity => activity.kind === 'retrying'))
  const queued = item.store.snapshot().delegations.find(entry => entry.id === delegation.id)
  assert.equal(board.require(task.id).status, 'doing')
  assert.equal(queued.attempts, 1)
  assert.ok(queued.nextAttemptAt > Date.now())
  assert.match(queued.error, /fetch failed/)
  assert.ok(board.snapshot().activities.some(activity => activity.kind === 'retrying'))
})

test('interrupted companion review is also reclaimed instead of silently disappearing', async t => {
  const item = await fixture(); t.after(item.close)
  const skills = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  const board = new TaskBoardService(item.store)
  const task = await board.create({ title: '等待伙伴验收', reviewerCompanionId: 'companion-default' }, { kind: 'user' })
  const doing = await board.update(task.id, { expectedRevision: task.revision, status: 'doing' }, { kind: 'user' })
  await board.completeExecution(doing.id, '待核验产出', { kind: 'companion', companionId: 'companion-default' })
  await item.store.update(state => state.delegations.push({
    id: 'review-interrupted', kind: 'review', taskId: task.id, initiatedBy: 'user', toCompanionId: 'companion-default',
    request: '核验任务', status: 'running', attempts: 1, createdAt: Date.now() - 30_000,
  }))
  const service = new PartnerCollaborationService(item.store, skills, board, {})
  service.setSessionExecutor({ execute: async () => ({ run: { id: 'review-run-recovered' }, output: '建议通过：产出完整' }) })
  t.after(() => service.close())
  await service.start()
  await waitFor(() => Boolean(board.require(task.id).reviewSummary) && item.store.snapshot().delegations.find(entry => entry.id === 'review-interrupted')?.status === 'completed')
  assert.equal(board.require(task.id).reviewSummary, '建议通过：产出完整')
  assert.equal(item.store.snapshot().delegations.find(entry => entry.id === 'review-interrupted').status, 'completed')
})

test('stale execution runs are reconciled so companions do not remain busy forever', async t => {
  const item = await fixture(); t.after(item.close)
  await item.store.update(state => state.executionRuns.push({
    id: 'run-interrupted', kind: 'schedule', ownerCompanionId: 'companion-default', sessionId: 'session-interrupted',
    sourceId: 'schedule-test', status: 'running', destroyAfterRun: true, startedAt: Date.now() - 10_000, toolNames: [],
  }))
  const executor = new EphemeralExecutionService({}, item.store, item.root)
  assert.equal(await executor.reconcileInterruptedRuns(), 1)
  const run = item.store.snapshot().executionRuns[0]
  assert.equal(run.status, 'failed')
  assert.match(run.error, /restarted/)
})

test('cross-partner delegation uses directed grants while user delegation bypasses partner grants', async t => {
  const item = await fixture()
  await item.store.update(state => state.companions.push({
    ...structuredClone(state.companions[0]), id: 'companion-reviewer', name: '审阅伙伴', createdAt: 2, updatedAt: 2,
  }))
  const skills = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  const board = new TaskBoardService(item.store)
  const task = await board.create({ title: '权限边界测试' }, { kind: 'user' })
  const service = new PartnerCollaborationService(item.store, skills, board, { execute: async () => ({ run: { id: 'run-1' }, output: '完成' }) })
  t.after(async () => { await service.close(); await item.close() })
  await assert.rejects(() => service.delegate({
    taskId: task.id, initiatedBy: 'companion', fromCompanionId: 'companion-default', to: 'companion-reviewer', request: '执行任务',
  }), /未获授权/)
  assert.equal(item.store.snapshot().delegations.length, 0)
  await service.replaceAccessTargets('companion-default', ['companion-reviewer'])
  assert.equal(service.canAccess('companion-default', 'companion-reviewer'), true)
  assert.equal(service.canAccess('companion-reviewer', 'companion-default'), false)
  assert.deepEqual(service.directoryFor('companion-default').map(entry => entry.id), ['companion-reviewer'])
  const delegated = await service.delegate({ taskId: task.id, initiatedBy: 'companion', fromCompanionId: 'companion-default', to: 'companion-reviewer', request: '执行任务' })
  assert.equal(delegated.initiatedBy, 'companion')

  const userTask = await board.create({ title: '用户直接委派' }, { kind: 'user' })
  const userDelegation = await service.delegate({ taskId: userTask.id, initiatedBy: 'user', to: 'companion-default', request: '用户执行' })
  assert.equal(userDelegation.initiatedBy, 'user')
  assert.equal(userDelegation.fromCompanionId, undefined)
})

test('partner collaboration keeps capabilities while loading inline Skill bodies on demand', async t => {
  const item = await fixture(); t.after(item.close)
  const skills = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  await skills.initialize()
  const planning = await skills.installMarket('builtin', 'task-planning')
  await skills.setBinding('companion-default', planning.id, true)
  const board = new TaskBoardService(item.store)
  const collaboration = new PartnerCollaborationService(item.store, skills, board, {})
  await item.store.update(state => state.companions.push({ ...structuredClone(state.companions[0]), id: 'companion-reviewer', name: '审阅伙伴' }))
  const companions = new CompanionService(item.store)
  companions.setSessionProvisioner(async companionId => {
    await item.store.update(state => state.sessions.push({
      id: `route-${companionId}`, kind: 'local', channelId: '@local', userId: `owner:${companionId}`,
      companionId, sessionId: `session-${companionId}`, lastMessageAt: 1,
    }))
  })
  const composition = new PartnerAgentComposition(item.store, skills, board, collaboration, {}, {}, companions)
  const compose = async companion => {
    const tools = []
    const sections = []
    await composition.compose({
      tools: { register: tool => tools.push(tool) },
      systemPrompt: { section: section => sections.push(section) },
    }, companion)
    return { tools, sections }
  }
  const companion = item.store.snapshot().companions[0]
  const defaultComposition = await compose(companion)
  const defaultNames = defaultComposition.tools.map(tool => tool.name)
  assert.ok(defaultNames.includes('partner_task_board'))
  assert.ok(defaultNames.includes('partner_collaborate'))
  assert.equal(defaultNames.includes('partner_skill'), false)
  assert.equal(defaultNames.includes('partner_companions'), false)
  assert.equal(defaultNames.includes('partner_schedule'), false)
  assert.equal(defaultComposition.sections.some(section => section.name === 'partner-inline-skills'), false)
  await item.store.update(state => { state.companions[0].capabilities = ['skills', 'companions', 'schedules', 'access'] })
  const authorizedComposition = await compose(item.store.snapshot().companions[0])
  const authorizedTools = authorizedComposition.tools
  const authorizedNames = authorizedTools.map(tool => tool.name)
  assert.ok(authorizedNames.includes('partner_skill'))
  assert.ok(authorizedNames.includes('partner_companions'))
  assert.ok(authorizedNames.includes('partner_schedule'))
  assert.ok(authorizedNames.includes('partner_access_grants'))
  const inlineSkills = authorizedComposition.sections.find(section => section.name === 'partner-inline-skills')
  assert.equal(inlineSkills,undefined)
  const summary=authorizedComposition.sections.find(section=>section.name==='partner-collaboration').text
  assert.match(summary,/task-planning/)
  assert.match(summary,/按需加载/)
  assert.doesNotMatch(summary,/多来源收集 \+ 真实性核验 \+ 结论整理|看板状态协议|expectedRevision/)
  const loaded=JSON.parse(await authorizedTools.find(t=>t.name==='partner_skill').execute({action:'load',skillId:planning.id},{}))
  assert.match(loaded.instructions,/多来源收集 \+ 真实性核验 \+ 结论整理/)
  const created = JSON.parse(await authorizedTools.find(tool => tool.name === 'partner_companions').execute({
    action: 'create', name: '资料伙伴', role: '资料研究', description: '负责持续研究与核验', instructions: '引用证据，明确不确定性。',
  }, {}))
  assert.equal(created.name, '资料伙伴')
  assert.deepEqual(created.capabilities, [])
  assert.equal(created.memoryEnabled, false)
  assert.equal(item.store.snapshot().sessions.some(session => session.companionId === created.id), true)
  const accessTool = authorizedTools.find(tool => tool.name === 'partner_access_grants')
  const grant = JSON.parse(await accessTool.execute({ action: 'grant', grantee: '@资料伙伴', target: '@审阅伙伴' }, {}))
  assert.equal(grant.authorized, true)
  assert.equal(grant.managedBy, companion.name)
  assert.equal(collaboration.canAccess(created.id, 'companion-reviewer'), true)
  const access = JSON.parse(await accessTool.execute({ action: 'list' }, {}))
  assert.equal(access.grants.some(item => item.granteeId === created.id && item.targetId === 'companion-reviewer'), true)
  await accessTool.execute({ action: 'revoke', grantee: created.id, target: 'companion-reviewer' }, {})
  assert.equal(collaboration.canAccess(created.id, 'companion-reviewer'), false)
  assert.deepEqual(collaboration.directoryFor(companion.id), [])
})

test('companion creation is atomic and starts with identity-only permissions', async t => {
  const item = await fixture(); t.after(item.close)
  const service = new CompanionService(item.store)
  service.setSessionProvisioner(async companionId => {
    await item.store.update(state => state.sessions.push({
      id: `route-${companionId}`, kind: 'local', channelId: '@local', userId: `owner:${companionId}`,
      companionId, sessionId: `session-${companionId}`, lastMessageAt: 1,
    }))
  })
  const created = await service.create({
    name: ' 架构伙伴 ', role: '架构审阅', description: '负责边界与稳定性', instructions: '先核验事实，再给结论。',
    capabilities: ['knowledge', 'companions'],
  })
  assert.equal(created.name, '架构伙伴')
  assert.equal(created.role, '架构审阅')
  assert.equal(created.instructions, '先核验事实，再给结论。')
  assert.deepEqual(created.capabilities, [])
  assert.equal(created.automation.memory.enabled, false)
  assert.equal(created.automation.memory.dailyReviewEnabled, false)
  assert.equal(created.automation.heartbeat.enabled, false)
  assert.equal(item.store.snapshot().sessions.some(session => session.companionId === created.id), true)

  const failing = new CompanionService(item.store)
  failing.setSessionProvisioner(async companionId => {
    await item.store.update(state => state.sessions.push({
      id: `route-${companionId}`, kind: 'local', channelId: '@local', userId: `owner:${companionId}`,
      companionId, sessionId: `session-${companionId}`, lastMessageAt: 1,
    }))
    throw new Error('session failed')
  })
  const before = item.store.snapshot().companions.length
  const sessionsBefore = item.store.snapshot().sessions.length
  await assert.rejects(() => failing.create({ name: '失败伙伴', role: '测试', description: '', instructions: '' }), /session failed/)
  assert.equal(item.store.snapshot().companions.length, before)
  assert.equal(item.store.snapshot().sessions.length, sessionsBefore)
})

test('Skill binding commits without tearing down an executing agent', async t => {
  const item = await fixture(); t.after(item.close)
  const skills = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  await skills.initialize()
  const installed = await skills.installMarket('builtin', 'technical-research')
  let observed = false
  const handled = await dispatchPartnerWorkspaceApi(
    request('PUT', '/', { enabled: true }), response(), ['companions', 'companion-default', 'skills', installed.id], new URL('http://localhost/'),
    {
      store: item.store, skills, tasks: {}, collaboration: {}, scheduler: {},
      agents: { async reloadCompanion() { observed = skills.bindings('companion-default').some(skill => skill.id === installed.id) } },
    },
  )
  assert.equal(handled, true)
  assert.equal(observed, false)
  assert.ok(skills.bindings('companion-default').some(skill => skill.id === installed.id))
})

test('capability API saves while a companion is running, without reload or automation loss', async t => {
  const item = await fixture(); t.after(item.close)
  let handler
  registerPartnerApi({ register(route) { handler = route.handler; return () => {} } }, '/partner', {
    connection: { requestRejection: () => undefined },
    store: item.store,
    agents: { isCompanionBusy() { return true }, async reloadCompanion() { throw new Error('must not reload during save') } },
  })
  const before = item.store.snapshot().companions[0]
  const res = response()
  await handler(request('PUT', '/partner/companions/' + before.id, { companion: { ...before, capabilities: ['administration', 'skills'] } }), res)
  assert.equal(res.statusCode, 200)
  const saved = JSON.parse(res.body)
  assert.deepEqual(saved.capabilities, ['administration', 'skills'])
  assert.deepEqual(saved.automation, before.automation)
  assert.ok(saved.updatedAt > before.updatedAt)
  assert.equal(item.store.hasCapability(before.id, 'administration'), true)
})

test('companion access API commits directed grants before reloading the source companion', async t => {
  const item = await fixture(); t.after(item.close)
  await item.store.update(state => state.companions.push({ ...structuredClone(state.companions[0]), id: 'companion-reviewer', name: '审阅伙伴' }))
  const skills = new SkillService(item.store, new SkillRepository(join(item.root, 'skills')))
  const collaboration = new PartnerCollaborationService(item.store, skills, new TaskBoardService(item.store), {})
  let observed = false
  collaboration.setAccessChangeNotifier(async id => { observed = id === 'companion-default' && collaboration.canAccess(id, 'companion-reviewer') })
  const res = response()
  const handled = await dispatchPartnerWorkspaceApi(request('PUT', '/', { targetIds: ['companion-reviewer'] }), res, ['companions', 'companion-default', 'access'], new URL('http://localhost/'), {
    store: item.store, skills, tasks: {}, collaboration, scheduler: {},
    agents: { async reloadCompanion() {} },
  })
  assert.equal(handled, true)
  assert.equal(observed, true)
})

test('daily schedule calculation follows the configured time zone', () => {
  const now = Date.UTC(2026, 8, 2, 0, 0, 20)
  const next = nextOccurrence({ kind: 'daily', hour: 9, minute: 5 }, now, 'Asia/Shanghai')
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(next)
  assert.equal(parts, '09:05')
  assert.ok(next > now)
})

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function storedZip(entries) {
  const localParts = []
  const centralParts = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const body = Buffer.from(entry.body)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(name.length, 26)
    localParts.push(local, name, body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(localOffset, 42)
    centralParts.push(central, name)
    localOffset += local.length + name.length + body.length
  }
  const directory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localParts, directory, end])
}
