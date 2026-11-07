import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PartnerStore } from '../lib/store.js'
import { partnerCodeExecutionTools, reconcileInterruptedCodeExecutions } from '../lib/execution/code-execution.js'

async function fixture(t, provider = {}) {
  const root = await mkdtemp(join(tmpdir(), 'partner-codex-run-'))
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const store = await PartnerStore.open(join(root, 'state.json'))
  const companion = store.snapshot().companions[0]
  const sessionId = 'session-code-test'
  await store.update(state => state.sessions.push({
    id: 'route-local', kind: 'local', companionId: companion.id, sessionId,
    channelId: '@local', userId: `owner:${companion.id}`, cwd: workspace, lastMessageAt: Date.now(),
  }))
  const service = {
    getProvider: provider.getProvider ?? (name => name === 'codex' ? { name } : undefined),
    startActivation: provider.startActivation ?? (async () => ({
      childId: 'codex-child-1', result: Promise.resolve({ output: [{ type: 'text', text: '已读取 README 并完成代码检查。' }], stopReason: 'completed' }), dispose: async () => {},
    })),
  }
  const agent = {
    session: { id: sessionId, header: { cwd: workspace }, snapshotEvents: () => [] },
    ctx: { get: name => name === 'subagents' ? service : undefined },
  }
  const signal = new AbortController()
  const exec = { agent, signal: signal.signal, callId: 'call-code-test' }
  const tools = partnerCodeExecutionTools(companion.id, store)
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  return { root, workspace, store, companion, sessionId, service, agent, exec, tools, signal }
}

test('partner_code_execute sends the real current workspace to the Codex activation and returns its terminal result', async t => {
  const f = await fixture(t)
  let request
  f.service.startActivation = async spec => {
    request = spec
    return { childId: 'real-child-id', result: Promise.resolve({ output: [{ type: 'text', text: 'README read; test passed.' }], stopReason: 'completed' }), dispose: async () => {} }
  }
  const [execute, status] = f.tools
  assert.equal(execute.name, 'partner_code_execute')
  assert.match(execute.description, /用户点名 Codex 并提出具体交付任务时.*能力问句/)
  assert.deepEqual(execute.parameters.required, ['task'])
  assert.equal(execute.parameters.properties.cwd, undefined)
  const output = await execute.execute({ task: 'Read README and run the unit test.', acceptanceCriteria: ['Report exact command and result'] }, f.exec)
  assert.equal(request.provider, 'codex')
  assert.equal(request.delivery, 'caller')
  assert.equal(request.request.cwd, f.workspace)
  assert.equal(request.request.parent, f.agent)
  assert.match(request.request.prompt[0].text, /Read README and run the unit test/)
  assert.match(request.request.prompt[0].text, /Report exact command and result/)
  assert.match(request.request.prompt[0].text, /Provider 当前配置的 Codex 模型/)
  assert.equal(output.status, 'completed')
  assert.equal(output.subagentId, 'real-child-id')
  assert.match(output.result, /test passed/)
  const ledger = f.store.snapshot().codeExecutionRuns
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].status, 'completed')
  assert.equal(ledger[0].subagentId, 'real-child-id')
  assert.equal(ledger[0].stopReason, 'completed')
  const queried = await status.execute({ runId: output.runId }, f.exec)
  assert.equal(queried.runs[0].runId, output.runId)
  assert.equal(queried.runs[0].outputPreview, 'README read; test passed.')
})

test('an explicitly requested Codex writing task uses the current DSH workspace without a model-supplied cwd', async t => {
  const f = await fixture(t)
  let request
  f.service.startActivation = async spec => {
    request = spec
    return { childId: 'codex-writing-child', result: Promise.resolve({ output: [{ type: 'text', text: '夏日诗作。' }], stopReason: 'completed' }), dispose: async () => {} }
  }
  const result = await f.tools[0].execute({ task: '请使用 Codex CLI 写一首关于夏天的中文诗。' }, f.exec)
  assert.equal(request.provider, 'codex')
  assert.equal(request.request.cwd, f.workspace)
  assert.equal(f.tools[0].parameters.properties.cwd, undefined)
  assert.match(request.request.prompt[0].text, /请使用 Codex CLI 写一首关于夏天的中文诗/)
  assert.equal(result.status, 'completed')
  assert.match(result.result, /夏日诗作/)
})

test('a channel Codex task trusts its persisted route cwd over a broken DSH session header', async t => {
  const f = await fixture(t)
  const now = Date.now()
  await f.store.update(state => {
    Object.assign(state.sessions[0], {
      kind: 'channel', channelId: 'mm-channel', userId: 'mm-user',
      inboxConversationKey: 'mattermost:dm:mm-target', inboxPlatform: 'mattermost',
      inboxAccountId: 'mm-account', inboxConversationType: 'dm', inboxConversationId: 'mm-target',
      inboundMessageIds: ['mm-post-1'],
    })
    state.channels.push({
      id: 'mm-channel', platform: 'mattermost', companionId: f.companion.id, accountId: 'mm-account',
      name: 'MM test', enabled: true, createdAt: now, updatedAt: now,
      direct: { baseUrl: 'http://127.0.0.1', targetId: 'mm-target', peerId: 'bot' },
    })
    state.pairings.push({
      id: 'pair-mm', channelId: 'mm-channel', userId: 'mm-user', displayName: 'Tester',
      status: 'approved', directTargetId: 'mm-target', createdAt: now, updatedAt: now,
    })
  })
  f.agent.session.header.cwd = join(f.root, 'tpartners', 'missing-session')
  f.agent.session.snapshotEvents = () => [{ type: 'user/message', data: { id: 'mm-post-1', source: { kind: 'user' } } }]
  let request
  f.service.startActivation = async spec => {
    request = spec
    return { childId: 'codex-channel-child', result: Promise.resolve({ output: [{ type: 'text', text: '完成。' }], stopReason: 'completed' }), dispose: async () => {} }
  }
  const result = await f.tools[0].execute({ task: '请用 Codex 完成当前 Mattermost 任务。' }, f.exec)
  assert.equal(request.request.cwd, f.workspace)
  assert.equal(result.status, 'completed')
})

test('missing subagents service/provider fails explicitly and never starts a DSH fallback', async t => {
  const f = await fixture(t)
  f.agent.ctx.get = () => undefined
  await assert.rejects(f.tools[0].execute({ task: 'Inspect the source files' }, f.exec), /Codex Provider unavailable.*no DSH Agent fallback/)
  assert.equal(f.store.snapshot().codeExecutionRuns[0].status, 'provider_missing')
  assert.equal(await f.tools[1].execute({}, f.exec).then(x => x.runs[0].status), 'provider_missing')

  const second = await fixture(t)
  second.service.getProvider = () => undefined
  await assert.rejects(second.tools[0].execute({ task: 'Inspect the source files' }, second.exec), /Codex Provider unavailable/)
  assert.equal(second.store.snapshot().codeExecutionRuns[0].status, 'provider_missing')
})

test('authentication and provider initialization failures are durable and explicit', async t => {
  const auth = await fixture(t, { startActivation: async () => { throw new Error('Codex login required: unauthorized') } })
  await assert.rejects(auth.tools[0].execute({ task: 'Read README' }, auth.exec), /Codex execution auth_failed/)
  assert.equal(auth.store.snapshot().codeExecutionRuns[0].status, 'auth_failed')

  const startup = await fixture(t, { startActivation: async () => { throw new Error('Product subagent failure (product: Codex; stage: initialize; category: unknown)') } })
  await assert.rejects(startup.tools[0].execute({ task: 'Read README' }, startup.exec), /Codex execution startup_failed/)
  assert.equal(startup.store.snapshot().codeExecutionRuns[0].status, 'startup_failed')
  assert.match(startup.store.snapshot().codeExecutionRuns[0].diagnostic, /initialize/)
})

test('stopReason and empty output distinguish abnormal exit from valid completion', async t => {
  const abnormal = await fixture(t, { startActivation: async () => ({
    childId: 'child-error', result: Promise.resolve({ output: [{ type: 'text', text: 'partial output' }], stopReason: 'error', diagnostic: 'process exited unexpectedly' }), dispose: async () => {},
  }) })
  await assert.rejects(abnormal.tools[0].execute({ task: 'Run one test' }, abnormal.exec), /Codex execution process_failed/)
  assert.equal(abnormal.store.snapshot().codeExecutionRuns[0].stopReason, 'error')

  const empty = await fixture(t, { startActivation: async () => ({
    childId: 'child-empty', result: Promise.resolve({ output: [], stopReason: 'completed' }), dispose: async () => {},
  }) })
  await assert.rejects(empty.tools[0].execute({ task: 'Read README' }, empty.exec), /Codex execution invalid_result/)
  assert.equal(empty.store.snapshot().codeExecutionRuns[0].status, 'invalid_result')
})

test('cancellation and timeout abort the DSH activation and dispose its resources', async t => {
  let canceledDisposed = false
  let signalStarted
  const started = new Promise(resolve => { signalStarted = resolve })
  const canceled = await fixture(t, { startActivation: async spec => {
    signalStarted(spec.signal)
    return { childId: 'child-cancel', result: new Promise(() => {}), dispose: async () => { canceledDisposed = true } }
  } })
  const canceledRun = canceled.tools[0].execute({ task: 'Create a temporary file' }, canceled.exec)
  await started
  canceled.signal.abort(new Error('user canceled'))
  await assert.rejects(canceledRun, /Codex execution canceled/)
  assert.equal(canceledDisposed, true)
  assert.equal(canceled.store.snapshot().codeExecutionRuns[0].status, 'canceled')

  let timeoutDisposed = false
  let timeoutSignal
  const timeout = await fixture(t, { startActivation: async spec => {
    timeoutSignal = spec.signal
    return { childId: 'child-timeout', result: new Promise(() => {}), dispose: async () => { timeoutDisposed = true } }
  } })
  await assert.rejects(timeout.tools[0].execute({ task: 'Sleep until timeout', timeoutSeconds: 1 }, timeout.exec), /Codex execution timeout/)
  assert.equal(timeoutSignal.aborted, true)
  assert.equal(timeoutDisposed, true)
  assert.equal(timeout.store.snapshot().codeExecutionRuns[0].status, 'timeout')
})

test('cleanup failure and restart recovery never leave a run marked completed or running', async t => {
  const cleanup = await fixture(t, { startActivation: async () => ({
    childId: 'child-cleanup', result: Promise.resolve({ output: [{ type: 'text', text: 'changed file' }], stopReason: 'completed' }), dispose: async () => { throw new Error('dispose failed') },
  }) })
  await assert.rejects(cleanup.tools[0].execute({ task: 'Edit a file' }, cleanup.exec), /Codex execution cleanup_failed/)
  assert.equal(cleanup.store.snapshot().codeExecutionRuns[0].status, 'cleanup_failed')

  await cleanup.store.update(state => state.codeExecutionRuns.push({
    runId: 'run-interrupted', provider: 'codex', subagentId: 'child-active', companionId: cleanup.companion.id,
    parentSessionId: cleanup.sessionId, workspace: cleanup.workspace, task: 'waiting', status: 'running', startedAt: 1, updatedAt: 2,
  }))
  assert.equal(await reconcileInterruptedCodeExecutions(cleanup.store, 50), 1)
  const recovered = cleanup.store.snapshot().codeExecutionRuns.find(run => run.runId === 'run-interrupted')
  assert.equal(recovered.status, 'interrupted')
  assert.equal(recovered.finishedAt, 50)
  assert.match(recovered.diagnostic, /automatic re-execution was not attempted/)
})
