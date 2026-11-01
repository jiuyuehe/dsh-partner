import test from 'node:test'
import assert from 'node:assert/strict'
import { PartnerAgentRuntime } from '../lib/agent-runtime.js'
import { PartnerAgentComposition } from '../lib/collaboration/composition.js'
import { PartnerStore } from '../lib/store.js'
import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeTarget } from '@deepseek-ai/dsh-scope'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { McpService, mcpToolName } from '../lib/mcp/service.js'

async function fixture(t, makeComposer) {
  const directory = await mkdtemp(join(tmpdir(), 'partner-live-grant-'))
  const root = new Context()
  const carrier = {}
  const scope = createScope(root, carrier, { parent: {} })
  const store = await PartnerStore.open(join(directory, 'state.json'))
  const companion = store.snapshot().companions[0]
  const route = { id: 'live', kind: 'local', channelId: '@local', userId: companion.id, companionId: companion.id, sessionId: 'live-session', cwd: directory, lastMessageAt: 1 }
  await store.update(state => state.sessions.push(route))
  const registered = new Map()
  const sections = new Map()
  const contexts = new Map()
  let compositions = 0
  let disposals = 0
  const agent = {
    status: 'running', session: { id: route.sessionId, header: { cwd: directory }, events: [], seq: 0 },
    ctx: scope.ctx.extend({ agent: carrier,
      tools: { register(tool) { assert.equal(registered.has(tool.name), false); registered.set(tool.name, tool); return () => registered.delete(tool.name) } },
      systemPrompt: { context(value) { contexts.set(value.name,value.text); return () => contexts.delete(value.name) }, section(value) { assert.ok(!sections.has(value.name), 'no duplicate prompt sections'); sections.set(value.name, value.text); return () => sections.delete(value.name) } },
    }),
    async whenIdle() { throw new Error('pre-step must not wait for itself') },
    async runMaintenance() { throw new Error('pre-step must not schedule maintenance') },
  }
  const composition = new PartnerAgentComposition(store, { bindings: () => [] }, {}, { directoryFor: () => [] }, {}, {}, {}, {}, {})
  const composer = makeComposer?.({ store, registered, sections }) ?? composition
  const ctx = root.extend({
    agents: { get: id => id === route.sessionId ? agent : undefined },
    workspaceRegistry: { archivedSessionIds: [], async create() { return { async attachSession() {} } } },
  })
  const runtime = new PartnerAgentRuntime(ctx, store, directory, undefined, undefined, undefined, {
    async compose(...args) { compositions++; const dispose = await composer.compose(...args); return () => { disposals++; dispose() } },
  })
  t.after(async () => { await runtime.close(); await scope.dispose(); await rm(directory, { recursive: true, force: true }) })
  const step = (turn, signal = new AbortController().signal) => ctx.waterfall(scopeTarget(carrier), 'agent/pre-step', { agent, turn, signal }, async () => 'ready')
  return { runtime, store, agent, route, companion, composition, registered, sections, contexts, step, counts: () => ({ compositions, disposals }) }
}

test('MCP grant and refreshed tool generation register on the next real pre-step, revoke denies stale tools', async t => {
  const { store, companion, composition, registered, step, counts } = await fixture(t)
  const credentials = new Map()
  let tools = [{ name: 'first', inputSchema: { type: 'object' } }]
  const mcp = new McpService(store, { read: async id => credentials.get(id), write: async (id, value) => credentials.set(id, value), delete: async id => credentials.delete(id) }, {
    async use(_id, _config, signal, work) { return work({ listTools: async () => ({ tools }), callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }, signal) }, close: async () => {},
  })
  composition.setMcpService(mcp)
  t.after(() => mcp.close())
  await mcp.save({ name: 'MCP test', config: { url: 'https://example.com/mcp' } })
  const id = mcp.catalog().servers[0].id
  await mcp.refresh(id)
  await store.update(s => { s.companions[0].capabilities = ['mcp'] })
  await step(1)
  const first = mcpToolName(id, 'first'), added = mcpToolName(id, 'added')
  assert.equal(registered.has(first), false)
  await mcp.bind(companion.id, id, true)
  await step(1)
  assert.equal(registered.has(first), false, 'running turn unchanged')
  await step(2)
  assert.equal(registered.has(first), true)
  tools = [...tools, { name: 'added', inputSchema: { type: 'object' } }]
  await mcp.refresh(id)
  await step(2)
  assert.equal(registered.has(added), false)
  await step(3)
  assert.equal(registered.has(added), true)
  const old = registered.get(first)
  await mcp.bind(companion.id, id, false)
  await assert.rejects(old.execute({}, { signal: new AbortController().signal }), /撤回/)
  await step(4)
  assert.equal(registered.has(first), false)
  assert.equal(registered.has(added), false)
  const before = counts().compositions
  await step(5)
  assert.equal(counts().compositions, before, 'unchanged turns do not recompose')
})

test('native browser resume installs tools before the first turn without /prepare, unchanged turns do not recompose', async t => {
  const { step, registered, counts, runtime, agent } = await fixture(t)
  assert.equal(registered.size, 0)
  assert.equal(await step(1), 'ready')
  assert.ok(registered.has('partner_task_board'))
  await step(1)
  await step(2)
  assert.deepEqual(counts(), { compositions: 1, disposals: 0 })
  await runtime.prepareAgentTurn({ session: { id: 'ordinary-session' } }, 1, new AbortController().signal)
  assert.deepEqual(counts(), { compositions: 1, disposals: 0 })
  assert.equal(agent.status, 'running')
})

test('avatar tool registers by default without a capability toggle', async t => {
  const { step, store, composition, registered } = await fixture(t)
  composition.setAvatarToolFactory(() => ({ name: 'partner_channel_avatar', parameters: { type: 'object' }, output: { schema: { type: 'string' }, render: () => [] }, execute: async () => 'updated' }))
  await step(1)
  const tool = registered.get('partner_channel_avatar')
  assert.ok(tool)
  assert.equal(await tool.execute({}, {}), 'updated')
  await store.update(state => { state.companions[0].capabilities = [] })
  await step(3)
  assert.equal(registered.has('partner_channel_avatar'), true)
})

test('activity-only writes do not recompose but peer grants and identity changes do', async t => {
  const { step, store, companion, counts } = await fixture(t)
  await step(1)
  await store.update(state => { state.sessions[0].lastMessageAt += 1; state.companions[0].updatedAt += 1 })
  await step(2)
  assert.equal(counts().compositions, 1)
  await store.update(state => {
    state.companions.push({ ...state.companions[0], id: 'peer', name: '同伴' })
    state.companionAccessGrants.push({ fromCompanionId: companion.id, toCompanionId: 'peer', createdAt: 1 })
  })
  await step(3)
  assert.equal(counts().compositions, 2)
  await store.update(state => { state.companions[1].role = '新的公开职责' })
  await step(4)
  assert.equal(counts().compositions, 3)
})

test('closing while a composition is pending cleans effects instead of installing after shutdown', async t => {
  let entered
  let release
  const began = new Promise(resolve => { entered = resolve })
  const barrier = new Promise(resolve => { release = resolve })
  let disposed = 0
  const { runtime, step, sections } = await fixture(t, () => ({ async compose() {
    entered(); await barrier; return () => { disposed++ }
  } }))
  const pending = step(1)
  await began
  const rejected = assert.rejects(pending, /已关闭/)
  const close = runtime.close()
  release()
  await rejected
  await close
  assert.equal(sections.size, 0)
  assert.equal(disposed, 1)
})

test('grant is deferred to next turn and revoke blocks an old management tool immediately', async t => {
  const { runtime, store, companion, route, agent, registered, sections, step, counts } = await fixture(t)
  await step(1)
  assert.equal(registered.has('partner_companion_manage'), false)
  await store.update(state => { state.companions[0].capabilities = ['administration']; state.companions[0].updatedAt += 1 })
  await runtime.reloadCompanion(companion.id)
  assert.equal(registered.has('partner_companion_manage'), false)
  await step(1)
  assert.equal(registered.has('partner_companion_manage'), false)
  await step(2)
  assert.ok(registered.has('partner_companion_manage'))
  assert.doesNotMatch(sections.get('partner-collaboration'), /knowledge_configure/)
  assert.match(sections.get('partner-collaboration'), /partner_workflow/)
  const oldTool = registered.get('partner_companion_manage')
  await store.update(state => { state.companions[0].capabilities = []; state.companions[0].updatedAt += 1 })
  await runtime.reloadCompanion(companion.id)
  assert.ok(registered.has('partner_companion_manage'))
  await assert.rejects(oldTool.execute({ action: 'catalog' }, {}), /已撤回/)
  await step(2)
  assert.ok(registered.has('partner_companion_manage'))
  await step(3)
  assert.equal(registered.has('partner_companion_manage'), false)
  assert.doesNotMatch(sections.get('partner-collaboration'), /knowledge_configure/)
  assert.equal(agent.session.id, route.sessionId)
  assert.equal(store.snapshot().sessions[0].sessionId, route.sessionId)
  assert.deepEqual(counts(), { compositions: 3, disposals: 2 })
})

test('composition failure blocks the turn, cleans partial sections and retries without duplicates', async t => {
  let fail = true
  const { step, sections, counts } = await fixture(t, () => ({ async compose() { if (fail) throw new Error('compose failed'); return () => {} } }))
  await assert.rejects(step(1), /compose failed/)
  assert.equal(sections.size, 0)
  fail = false
  await step(1)
  assert.equal(sections.size, 2)
  assert.deepEqual(counts(), { compositions: 2, disposals: 0 })
})

test('all opt-in partner tools reject calls from the old schema after revocation', async t => {
  const { store, step, registered } = await fixture(t)
  await store.update(state => { state.companions[0].capabilities = ['skills', 'companions', 'access', 'administration', 'schedules'] })
  await step(1)
  const names = ['partner_skill', 'partner_companions', 'partner_access_grants', 'partner_companion_manage', 'partner_schedule']
  const tools = names.map(name => { assert.ok(registered.has(name)); return registered.get(name) })
  await store.update(state => { state.companions[0].capabilities = [] })
  for (const tool of tools) await assert.rejects(tool.execute({}, {}), /已撤回/)
  await step(2)
  for (const name of names) assert.equal(registered.has(name), false)
  assert.ok(registered.has('partner_task_board'), 'shared board is not gated by an unrelated capability')
})

test('save during asynchronous composition is not marked as already applied', async t => {
  let release
  let began
  const entered = new Promise(resolve => { began = resolve })
  const barrier = new Promise(resolve => { release = resolve })
  let first = true
  const seen = []
  const { step, store } = await fixture(t, () => ({ async compose(ctx, companion) {
    seen.push(companion.instructions)
    if (first) { first = false; began(); await barrier }
    return () => {}
  } }))
  const running = step(1)
  await entered
  await store.update(state => { state.companions[0].instructions = 'new identity' })
  release()
  await running
  assert.notEqual(seen[0], 'new identity')
  await step(1)
  assert.equal(seen.length, 1)
  await step(2)
  assert.equal(seen[1], 'new identity')
})

test('cancellation cleans new effects and does not mark the failed turn prepared', async t => {
  const controller = new AbortController()
  let disposed = 0
  let first = true
  const { step, sections } = await fixture(t, () => ({ async compose() {
    if (first) { first = false; controller.abort(new Error('cancelled')) }
    return () => { disposed++ }
  } }))
  await assert.rejects(step(1, controller.signal), /cancelled/)
  assert.equal(disposed, 1)
  assert.equal(sections.size, 0)
  await step(1)
  assert.equal(sections.size, 2)
})

test('role chat preserves the registered tool set across enable, edit and disable', async t => {
  const { step, store, registered, agent, sections, contexts } = await fixture(t)
  agent.session.deriveMessages = () => []
  agent.session.snapshotEvents = () => []
  await step(1)
  const tools = [...registered.keys()].sort()
  await store.update(state => { state.companions[0].characterCard = { schemaVersion:1,enabled:true,roleText:'坦率的同行者',identity:'',motivation:'',voice:'',relationship:'',greeting:'',length:'short',narration:false,examples:[],lore:[] } })
  await step(2)
  assert.deepEqual([...registered.keys()].sort(), tools)
  assert.doesNotMatch(sections.get('partner-identity'), /用户配置的表达选项/)
  assert.match(contexts.get('partner-conversation-memory'), /用户配置的表达选项/)
  assert.doesNotMatch(contexts.get('partner-conversation-memory'), /本轮聊天提醒|坦率的同行者/)
  await store.update(state => { state.companions[0].characterCard.roleText = '喜欢冷笑话的同行者'; state.companions[0].characterCard.length = 'rich' })
  await step(3)
  assert.match(sections.get('partner-identity'), /喜欢冷笑话/)
  assert.match(contexts.get('partner-conversation-memory'), /篇幅偏好：愿意展开聊/)
  assert.doesNotMatch(contexts.get('partner-conversation-memory'), /篇幅偏好：简短/)
  assert.deepEqual([...registered.keys()].sort(), tools)
  await store.update(state => { state.companions[0].characterCard.enabled = false })
  await step(4)
  assert.deepEqual([...registered.keys()].sort(), tools)
  assert.doesNotMatch(sections.get('partner-identity'), /用户配置的表达选项/)
  assert.equal(contexts.has('partner-conversation-memory'), false)
})
