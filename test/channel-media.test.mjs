import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { receiveWeixinMedia } from '../lib/channels/weixin/media.js'
import { ChannelManager, answerQuestions, busyEnterMode, extractText, isAutonomousDeliveryTurn, renderQuestions } from '../lib/channels/manager.js'
import { extractOutboundAttachments, selectTaskNotificationRoute } from '../lib/agent-runtime.js'
import { CONCERN_CREATED_NOTICE, concernCreatedNoticeFromEvent } from '../lib/concern-notification.js'
import { parseTaskExecutionOutput, prepareTaskResultDelivery } from '../lib/tasks/result.js'
import { channelReplyPartsAfter, channelReplyTextAfter } from '../lib/channels/delivery-policy.js'
import { prepareChannelReply } from '../lib/channels/outbound-media.js'
import { PartnerStore } from '../lib/store.js'
import { TaskBoardService } from '../lib/tasks/service.js'
import { RequirementService } from '../lib/requirements/service.js'
import { RequirementWorker } from '../lib/requirements/worker.js'
import { assistantTextAfter } from '../lib/execution/agent-support.js'
import { AttachmentDeliveryService } from '../lib/attachments/service.js'

async function configureRequirementDelivery(channels, root) {
  const service = await AttachmentDeliveryService.open(join(root, 'attachments'))
  channels.setRequirementDelivery(service, '/partner-api')
  channels.agents.recordRequirementResult = async () => {}
  return service
}

function encrypt(value, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(value), cipher.final()])
}

test('routes completed autonomous goals without mirroring ordinary plugin notices', () => {
  const goal = { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'tool-goal', form: 'notice', summary: 'complete: finished' } } }
  const heartbeat = { type: 'user/message', data: { source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '伙伴正在进行低打扰心跳检查' } } }
  const taskReview = { type: 'user/message', data: { source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '看板任务待验收' } } }
  const taskDone = { type: 'user/message', data: { source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '看板任务已完成' } } }
  const taskBlocked = { type: 'user/message', data: { source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '看板任务受阻' } } }
  assert.equal(isAutonomousDeliveryTurn([goal]), true)
  assert.equal(isAutonomousDeliveryTurn([taskReview]), false)
  assert.equal(isAutonomousDeliveryTurn([taskDone]), false)
  assert.equal(isAutonomousDeliveryTurn([taskBlocked]), false)
  assert.equal(isAutonomousDeliveryTurn([heartbeat]), false)
  for (const internal of [taskReview, taskDone, taskBlocked]) {
    assert.equal(isAutonomousDeliveryTurn([internal, goal]), false)
    assert.equal(isAutonomousDeliveryTurn([goal], [internal, goal]), false)
    assert.equal(isAutonomousDeliveryTurn([goal], [internal, { type: 'user/message', data: { source: { kind: 'user' } } }, goal]), true)
  }
})

test('channel replies retain creation acknowledgments but omit subsequent internal review turns', () => {
  const source = summary => ({ type: 'user/message', data: { source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary } } })
  const user = { type: 'user/message', data: { source: { kind: 'user' } } }
  const text = value => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: value }] } } })
  const events = [
    { type: 'turn/start' }, user, text('已创建任务，玄枢执行、莫殇验收。'),
    { type: 'turn/start' }, source('看板任务待验收'), text('正在核验，调用 accept。'),
    { type: 'turn/start' }, source('看板任务已完成'), text('内部继续检查后续依赖。'),
  ].map((event, i) => ({ ...event, seq: i + 1 }))
  assert.equal(channelReplyTextAfter(events, 0), '已创建任务，玄枢执行、莫殇验收。')
  const directQuestion = [...events, { ...user, seq: 20 }, { ...text('你主动问进展，目前已完成。'), seq: 21 }]
  assert.equal(channelReplyTextAfter(directQuestion, 19), '你主动问进展，目前已完成。')
})

const channelUser = () => ({ type: 'user/message', data: { source: { kind: 'user' } } })
const channelAnswer = (text, extra = []) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }, ...extra] } } })
const numbered = events => events.map((event, index) => ({ ...event, seq: index + 1 }))

test('delivery receipt during a user turn does not suppress its final answer or expose receipt text', () => {
  const receipt = { type: 'user/message', data: { requirementDeliveryReceipt: 'receipt-1', source: { kind: 'plugin:@lemoncat7/dsh-partner', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '需求成果交付' }, content: [{ type: 'text', text: '系统已发送的回执内容' }] } }
  const end = { type: 'turn/end', data: { reason: { kind: 'completed' } } }
  const events = numbered([{ type: 'turn/start' }, channelUser(), channelAnswer('正在关闭', [{ type: 'tool-call', id: 'close', name: 'partner_requirements', arguments: {} }]), { type: 'tool/result' }, receipt, channelAnswer('已关闭相关看板任务，保留已有成果。'), end])
  assert.equal(channelReplyPartsAfter(events, 0).text, '已关闭相关看板任务，保留已有成果。')
  assert.equal(channelReplyPartsAfter(numbered([{ type: 'turn/start' }, channelUser(), channelAnswer('完成'), receipt, end]), 0).text, '完成')
  assert.equal(channelReplyPartsAfter(numbered([{ type: 'turn/start' }, receipt, channelAnswer('内部流程'), end]), 0).text, '')
  assert.equal(channelReplyPartsAfter(numbered([{ type: 'turn/start' }, receipt, channelAnswer('内部流程'), end]), 0, true).text, '')
})

test('channel final selection omits preambles and tool results, preserving only assistant attachment references', () => {
  const events = numbered([
    { type: 'turn/start' }, channelUser(), channelAnswer('我先查资料。'),
    channelAnswer('准备生成图片。', [{ type: 'tool-call', id: 'image-call', name: 'generate_image', arguments: {} }]),
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: '工具原始内容 /private.png' }] } } },
    channelAnswer('图片已生成：[图片](sandbox:generated/result.png)'),
    channelAnswer('最终结论：完成。'),
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ])
  const parts = channelReplyPartsAfter(events, 0)
  assert.equal(parts.text, '最终结论：完成。')
  assert.ok(parts.referenceTexts.some(text => text.includes('generated/result.png')))
  assert.equal(parts.referenceTexts.some(text => text.includes('/private.png')), false)
  assert.equal(channelReplyPartsAfter(events, 5, true).text, parts.text)
  assert.equal(channelReplyPartsAfter(events, events.at(-1).seq).text, '')
})

test('an unanswered tool call or failed turn never promotes a preamble into a final answer', () => {
  const call = channelAnswer('我马上处理', [{ type: 'tool-call', id: 'pending', name: 'read', arguments: {} }])
  const events = numbered([{ type: 'turn/start' }, channelUser(), channelAnswer('已经理解'), call])
  assert.equal(channelReplyTextAfter(events, 0), '')
  const failed = numbered([{ type: 'turn/start' }, channelUser(), channelAnswer('开始处理'), { type: 'turn/end', data: { reason: { kind: 'failed' } } }])
  assert.deepEqual(channelReplyPartsAfter(failed, 0), { text: '', referenceTexts: [] })
  assert.equal(assistantTextAfter({ session: { snapshotEvents: () => failed } }, 0), '')
  assert.equal(assistantTextAfter({ session: { snapshotEvents: () => events } }, 0), '')
})

test('board and temporary execution results contain final deliverables, not tool preambles', () => {
  const events = numbered([
    { type: 'turn/start' },
    { type: 'user/message', data: { source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '伙伴执行看板任务' } } },
    channelAnswer('我先查资料。', [{ type: 'tool-call', id: 'read', name: 'read', arguments: {} }]),
    { type: 'tool/result', data: { message: { content: [] } } },
    channelAnswer('<partner-deliverable>实际交付</partner-deliverable>'),
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ])
  assert.equal(assistantTextAfter({ session: { snapshotEvents: () => events } }, 0), '<partner-deliverable>实际交付</partner-deliverable>')
  assert.equal(channelReplyTextAfter(events, 0), '')
})

test('channel tells the user when an attachment upload fails, without regenerating the answer', async t => {
  const root = await mkdtemp(join(tmpdir(), 'partner-outbound-error-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = await PartnerStore.open(join(root, 'state.json'))
  await store.update(state => state.pairings.push({ id: 'approved', channelId: 'channel', userId: 'user', displayName: 'User', status: 'approved', createdAt: 1, updatedAt: 1 }))
  let replies = 0
  const manager = new ChannelManager({ settings: { describe: () => [{ ns: 'ui-conversation', value: { busyEnter: 'queue' } }] }, logger: { warn: () => {} } }, store, {}, {
    reply: async () => { replies++; return { text: '完成，图片如下。', attachments: [{ path: join(root, 'image.png'), name: 'image.png', kind: 'image', mediaType: 'image/png' }] } },
  }, root)
  const messages = []
  const api = { sendText: async (_user, text) => messages.push(text), sendAttachment: async () => { throw new Error('upload unavailable') } }
  const channel = { id: 'channel', companionId: 'companion-default' }
  const incoming = { message_type: 1, from_user_id: 'user', message_id: 'msg-1', item_list: [{ type: 1, text_item: { text: '画图' } }] }
  await manager.handleInbound(channel, api, incoming, new AbortController().signal)
  assert.equal(replies, 1)
  assert.equal(messages.length, 2)
  assert.match(messages[1], /image.png.*发送失败/)
  assert.match(messages[1], /无需重新生成/)
})

test('distinct user turns keep their own finals, and internal review attachments remain private', () => {
  const events = numbered([
    { type: 'turn/start' }, channelUser(), channelAnswer('第一轮过程'), channelAnswer('第一轮结论'),
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    { type: 'turn/start' }, { type: 'user/message', data: { source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '看板任务待验收' } } },
    channelAnswer('[内部核验](private.md)'),
    { type: 'turn/start' }, channelUser(), channelAnswer('第二轮结论'),
  ])
  const result = channelReplyPartsAfter(events, 0)
  assert.equal(result.text, '第一轮结论\n\n第二轮结论')
  assert.equal(result.referenceTexts.some(text => text.includes('private.md')), false)
})

test('Markdown and progress references never implicitly send files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'partner-sandbox-media-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'generated'))
  const path = join(root, 'generated', '结果 图.png')
  await writeFile(path, 'png')
  const relativeLink = '[图片](sandbox:generated/%E7%BB%93%E6%9E%9C%20%E5%9B%BE.png)'
  const reply = await prepareChannelReply({ text: `最终结论。\n${relativeLink}`, referenceTexts: [`我准备发图 ${relativeLink}`, `[重复](<sandbox:${path}>)`] }, root)
  assert.equal(reply.attachments.length, 0)
  assert.match(reply.text, /partner_send_attachment/)
  assert.doesNotMatch(reply.text, /sandbox:|准备发图/)
  const onlyProgressImage = await prepareChannelReply({ text: '最终结论', referenceTexts: [relativeLink] }, root)
  assert.equal(onlyProgressImage.text, '最终结论')
  assert.equal(onlyProgressImage.attachments.length, 0)
})

test('missing, malformed and escaping sandbox references fail visibly without guessing or aborting the answer', async t => {
  const base = await mkdtemp(join(tmpdir(), 'partner-sandbox-boundary-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'workspace')
  const privateDirectory = join(base, 'private')
  await mkdir(root)
  await mkdir(privateDirectory)
  await mkdir(join(privateDirectory, 'nested'))
  await writeFile(join(privateDirectory, 'nested', 'secret.png'), 'private')
  // Windows Junction 不要求创建文件符号链接的开发者模式或管理员权限。
  await symlink(privateDirectory, join(root, 'escape'), 'junction')
  for (const reference of ['sandbox:../secret.png', 'sandbox:escape/nested/secret.png', 'sandbox:/mnt/data/missing.png', 'sandbox:%E0%A4%A.png', 'sandbox://outside/secret.png']) {
    const reply = await prepareChannelReply({ text: `结果说明 [图片](${reference})`, referenceTexts: [] }, root)
    assert.deepEqual(reply.attachments, [])
    assert.match(reply.text, /结果说明/)
    assert.match(reply.text, /未发送该附件/)
    assert.doesNotMatch(reply.text, /sandbox:/)
  }
  const fallback = await prepareChannelReply({ text: '', referenceTexts: [] }, root)
  assert.match(fallback.text, /未生成可发送的最终答复/)
  await writeFile(join(root, 'good.png'), 'png')
  const recovered = await extractOutboundAttachments('[损坏](%XX.png)\n[有效](good.png)', root)
  assert.deepEqual(recovered.map(file => file.name), ['good.png'])
})

test('renders short terminal results directly without internal review handoff', async () => {
  const base = {
    id: 'task-1', title: '调研方案', description: '', priority: 'normal', assigneeCompanionId: 'worker', createdBy: 'companion',
    creatorCompanionId: 'creator', skillIds: [], dependencyTaskIds: [], revision: 4, createdAt: 1, updatedAt: 2,
  }
  const done = await prepareTaskResultDelivery({ ...base, status: 'done', resultSummary: '结论与来源都在这里', reviewHandoff: '只给验收者', reviewSummary: '证据完整，验收通过' }, '/tmp')
  assert.match(done.text, /执行结果：\n结论与来源都在这里/)
  assert.match(done.text, /验收结论：证据完整，验收通过/)
  assert.doesNotMatch(done.text, /只给验收者/)
  const blocked = await prepareTaskResultDelivery({ ...base, status: 'blocked', resultSummary: '缺少访问权限' }, '/tmp')
  assert.match(blocked.text, /阻塞说明：\n缺少访问权限/)
})

test('child acceptance stays silent and requirement summary sends one terminal result to the creator channel', async t => {
  const root = await mkdtemp(join(tmpdir(), 'partner-channel-terminal-'))
  const store = await PartnerStore.open(join(root, 'state.json'))
  const board = new TaskBoardService(store)
  const actor = { kind: 'companion', companionId: 'companion-default' }
  await store.update(s => s.sessions.push({ id: 'route', kind: 'channel', companionId: actor.companionId,
    sessionId: 'creator-session', channelId: 'channel', userId: 'user', cwd: root, lastMessageAt: 1 }))
  const channels = new ChannelManager({}, store, {}, {}, root)
  const services = [await configureRequirementDelivery(channels, root)]
  // Windows 锁定 SQLite 文件；先排空写入、关闭连接，再删除临时目录。
  t.after(async () => { await Promise.all(services.map(service => service.freeze())); await rm(root, { recursive: true, force: true }) })
  const delivered = []
  // Mock only transport; keep routing, rendering, queue and persistent receipts real.
  channels.sendProactiveReply = async (channelId, userId, reply) => delivered.push({ channelId, userId, reply })
  board.setProgressNotifier(task => channels.notifyTaskResult(task))
  const task = await board.create({ title: '资料整理', creatorSessionId: 'creator-session' }, actor)
  const doing = await board.update(task.id, { expectedRevision: task.revision, status: 'doing' }, actor)
  await board.completeExecution(doing.id, { deliverable: '完整结论与来源', reviewHandoff: '内部核验点' }, actor)
  await board.recordReview(task.id, '证据完整', actor)
  assert.equal(delivered.length, 0)
  const done = await board.accept(task.id, actor)
  await Promise.all([channels.notifyTaskResult(done), channels.notifyTaskResult(done)])
  assert.equal(delivered.length, 0)
  const requirements = new RequirementService(store)
  const requirement = requirements.require(done.requirementId)
  const finished = await requirements.finish(requirement.id, requirement.revision, '完整结论与来源', actor)
  await Promise.all([channels.notifyRequirementResult(finished), channels.notifyRequirementResult(finished)])
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].channelId, 'channel')
  assert.equal(delivered[0].reply.text, '完整结论与来源', 'transport preserves the owner-authored answer')
  assert.match(delivered[0].reply.text, /完整结论与来源/)
  assert.doesNotMatch(delivered[0].reply.text, /内部核验点/)
  const restored = await PartnerStore.open(join(root, 'state.json'))
  const afterRestart = new ChannelManager({}, restored, {}, {}, root)
  services.push(await configureRequirementDelivery(afterRestart, root))
  afterRestart.sendProactiveReply = async () => assert.fail('must not redeliver after restart')
  await afterRestart.notifyRequirementResult(finished)
})

test('stage reports route once before archiving; waiting/review suppresses delivery and changed results notify again', async t => {
  const root = await mkdtemp(join(tmpdir(), 'partner-channel-stage-'))
  const store = await PartnerStore.open(join(root, 'state.json')), board = new TaskBoardService(store), requirements = new RequirementService(store)
  const actor = { kind: 'companion', companionId: 'companion-default' }
  await store.update(s => s.sessions.push({ id: 'route', kind: 'channel', companionId: actor.companionId, sessionId: 'creator-session', channelId: 'channel', userId: 'user', cwd: root, lastMessageAt: 1 }))
  const req = await requirements.create({ title: '阶段交付' }, actor, 'creator-session')
  const task = await board.create({ title: '原型', requirementId: req.id }, actor)
  const channels = new ChannelManager({}, store, {}, {}, root), delivered = []
  const services = [await configureRequirementDelivery(channels, root)]
  // 先关闭 SQLite，再清理临时数据，避免 Windows 上的文件占用竞态。
  t.after(async () => { await Promise.all(services.map(service => service.freeze())); await rm(root, { recursive: true, force: true }) })
  channels.sendProactiveReply = async (_c, _u, reply) => delivered.push(reply)
  const worker = new RequirementWorker(store, requirements, { summarize: async () => '当前成果和阻塞说明', deliver: item => channels.notifyRequirementResult(item), warn() {} })
  const stateTo = async status => store.update(s => {
    s.tasks.find(t => t.id === task.id).status = status
    s.requirements[0].updatedAt = Date.now() - 30_000; s.requirements[0].revision++
  })
  for (const status of ['backlog', 'ready', 'doing', 'review']) { await stateTo(status); await worker.tick(); assert.equal(delivered.length, 0) }
  await stateTo('blocked'); await worker.tick(); await worker.tick()
  assert.equal(delivered.length, 0, 'creator/owner remediation precedes channel escalation')
  await store.update(s => { s.tasks[0].blockedRecovery = { workRevision: 1, handledBy: [actor.companionId], attempts: 1, needsUser: true, summary: '需要用户补充输入' } })
  await worker.tick()
  assert.equal(delivered.length, 1); assert.equal(delivered[0].text, '当前成果和阻塞说明')
  assert.doesNotMatch(delivered[0].text, /需求已完成|待验收/)
  assert.equal(requirements.require(req.id).status, 'planning')
  await stateTo('done'); await worker.tick(); await worker.tick(); await worker.close()
  assert.equal(delivered.length, 2)
  const restored = await PartnerStore.open(join(root, 'state.json')), resumed = new ChannelManager({}, restored, {}, {}, root)
  services.push(await configureRequirementDelivery(resumed, root))
  resumed.sendProactiveReply = async () => assert.fail('stage receipt survives restart')
  await resumed.notifyRequirementResult(requirements.require(req.id))
})

test('separates review handoff and writes long deliverables to a private Markdown file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-partner-result-')); t.after(() => rm(root, { recursive: true, force: true }))
  const parsed = parseTaskExecutionOutput('<partner-summary>\n短结论\n</partner-summary>\n<partner-deliverable>\n完整交付\n</partner-deliverable>\n<partner-review-handoff>\n请核对来源 A\n</partner-review-handoff>')
  assert.deepEqual(parsed, { summary: '短结论', deliverable: '完整交付', reviewHandoff: '请核对来源 A' })
  const legacy = parseTaskExecutionOutput('## 产出\n最终内容\n\n## 需要验收的内容\n请检查格式')
  assert.deepEqual(legacy, { deliverable: '## 产出\n最终内容', reviewHandoff: '请检查格式' })
  const long = '## 完整交付\n\n- 第一项\n  - 子项\n\n```js\n  const value = 1\n```\n\n' + '这是完整交付内容。'.repeat(300)
  const delivery = await prepareTaskResultDelivery({
    id: 'task-long-result', title: '超长调研', description: '', status: 'done', priority: 'normal', createdBy: 'companion',
    creatorCompanionId: 'creator', skillIds: [], dependencyTaskIds: [], resultAbstract: '调研已完成，详见附件。', resultSummary: long,
    reviewHandoff: '内部核验清单', revision: 2, createdAt: 1, updatedAt: 2,
  }, root)
  assert.ok(delivery.text.includes(long))
  assert.doesNotMatch(delivery.text, /结论：调研已完成，详见附件/)
  assert.match(delivery.text, /完整交付文档/)
  assert.doesNotMatch(delivery.text, /内部核验清单/)
  assert.ok(delivery.documentPath)
  const document = await readFile(delivery.documentPath, 'utf8')
  assert.match(document, /这是完整交付内容/)
  assert.doesNotMatch(document, /内部核验清单/)
  const attachments = await extractOutboundAttachments(delivery.text, root)
  assert.deepEqual(attachments.map(item => ({ name: item.name, kind: item.kind, mediaType: item.mediaType })), [{
    name: basename(delivery.documentPath), kind: 'file', mediaType: 'text/markdown',
  }])
})

test('task notifications preserve their original channel and prefer another channel over local fallback', () => {
  const routes = [
    { id: 'local', kind: 'local', sessionId: 'session-local', channelId: '@local', userId: 'owner', companionId: 'companion-default', lastMessageAt: 300 },
    { id: 'old-channel', kind: 'channel', sessionId: 'session-old', channelId: 'weixin-1', userId: 'user', companionId: 'companion-default', lastMessageAt: 100 },
    { id: 'new-channel', kind: 'channel', sessionId: 'session-new', channelId: 'weixin-1', userId: 'user', companionId: 'companion-default', lastMessageAt: 200 },
  ]
  assert.equal(selectTaskNotificationRoute(routes, 'session-old', () => false)?.id, 'old-channel')
  assert.equal(selectTaskNotificationRoute(routes, 'missing', () => false)?.id, 'new-channel')
  assert.equal(selectTaskNotificationRoute(routes, 'session-old', route => route.id === 'old-channel')?.id, 'new-channel')
})

test('recognizes automatic concern creation notices for the current channel', () => {
  const event = {
    type: 'user/message', seq: 12, time: 100,
    data: {
      content: [{ type: 'text', text: '伙伴刚刚自动新增了 1 条关注' }],
      source: { kind: 'plugin', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: CONCERN_CREATED_NOTICE },
    },
  }
  assert.equal(concernCreatedNoticeFromEvent(event), '伙伴刚刚自动新增了 1 条关注')
  assert.equal(concernCreatedNoticeFromEvent({ ...event, data: { ...event.data, source: { ...event.data.source, summary: '其他通知' } } }), undefined)
})

async function withFetch(handler, run) {
  const previous = globalThis.fetch
  globalThis.fetch = handler
  try { await run() } finally { globalThis.fetch = previous }
}

test('downloads and decrypts WeChat images with a raw base64 AES key', async () => {
  const key = randomBytes(16)
  const image = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('test-image')])
  const encrypted = encrypt(image, key)
  await withFetch(async url => {
    assert.match(String(url), /^https:\/\/novac2c\.cdn\.weixin\.qq\.com\/c2c\/download/)
    return new Response(encrypted, { status: 200, headers: { 'content-length': String(encrypted.length) } })
  }, async () => {
    const attachment = await receiveWeixinMedia({
      type: 2,
      image_item: { media: { encrypt_query_param: 'image-token', aes_key: key.toString('base64') } },
    })
    assert.equal(attachment?.kind, 'image')
    assert.equal(attachment?.name, '微信图片.png')
    assert.equal(attachment?.mediaType, 'image/png')
    assert.deepEqual(Buffer.from(attachment?.data ?? []), image)
  })
})

test('downloads and decrypts WeChat files with a base64-encoded hex AES key', async () => {
  const key = randomBytes(16)
  const file = Buffer.from('partner document')
  const encrypted = encrypt(file, key)
  await withFetch(async () => new Response(encrypted, { status: 200 }), async () => {
    const attachment = await receiveWeixinMedia({
      type: 4,
      file_item: {
        file_name: '../工作说明.md',
        content_type: 'text/markdown',
        media: { full_url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?id=1', aes_key: Buffer.from(key.toString('hex')).toString('base64') },
      },
    })
    assert.equal(attachment?.kind, 'file')
    assert.equal(attachment?.name, '_工作说明.md')
    assert.equal(attachment?.mediaType, 'text/markdown')
    assert.deepEqual(Buffer.from(attachment?.data ?? []), file)
  })
})

test('rejects media URLs outside trusted WeChat domains before fetching', async () => {
  let called = false
  await withFetch(async () => { called = true; return new Response() }, async () => {
    await assert.rejects(
      receiveWeixinMedia({ type: 4, file_item: { media: { full_url: 'https://example.com/private.pdf' } } }),
      /下载地址不可信/,
    )
  })
  assert.equal(called, false)
})

test('extracts text and voice transcripts without media placeholder text', () => {
  assert.equal(extractText([
    { type: 1, text_item: { text: ' 文字消息 ' } },
    { type: 2, image_item: {} },
    { type: 3, voice_item: { text: '语音转写' } },
    { type: 4, file_item: { file_name: '资料.pdf' } },
  ]), '文字消息\n\n语音转写')
})

test('only exposes supported real files inside the companion workspace', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-partner-media-'))
  const root = join(base, 'partner')
  const outside = join(base, 'outside')
  try {
    await mkdir(root)
    const image = join(root, '结果图.png')
    const document = join(root, '报告.pdf')
    const unsupported = join(root, '程序.exe')
    const escaped = join(root, 'escape', 'escape.pdf')
    await mkdir(outside)
    await writeFile(image, 'png')
    await writeFile(document, 'pdf')
    await writeFile(unsupported, 'exe')
    await writeFile(join(outside, 'escape.pdf'), 'outside')
    // Junction 仍会让 realpath 越出伙伴工作区，验证附件路径边界判断。
    await symlink(outside, join(root, 'escape'), 'junction')
    const result = await extractOutboundAttachments([
      `[图片](${image})`,
      `[报告](<${document}>)`,
      '`结果图.png`',
      unsupported,
      outside,
      escaped,
    ].join('\n'), root)
    assert.deepEqual(result.map(item => ({ name: item.name, kind: item.kind })), [
      { name: '结果图.png', kind: 'image' },
      { name: '报告.pdf', kind: 'file' },
    ])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('resolves a generated relative attachment named in inline code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-partner-relative-media-'))
  try {
    await writeFile(join(root, 'AI资讯汇总.pptx'), 'presentation')
    const result = await extractOutboundAttachments('做好了：`AI资讯汇总.pptx`', root)
    assert.equal(result.length, 1)
    assert.equal(result[0]?.name, 'AI资讯汇总.pptx')
    assert.equal(result[0]?.kind, 'file')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('renders and parses DSH questions for a text-only channel', () => {
  const questions = [{
    id: 'mode', header: '运行方式', question: '选择执行方式',
    options: [{ label: '继续', description: '执行当前方案' }, { label: '取消' }],
  }, {
    id: 'targets', question: '选择目标', multiSelect: true,
    options: [{ label: '图片' }, { label: '文档' }, { label: '消息' }],
  }]
  assert.match(renderQuestions(questions), /1\. 继续 — 执行当前方案/)
  assert.match(renderQuestions(questions), /分号分隔/)
  assert.deepEqual(answerQuestions(questions, '1；1,3'), { answers: [
    { id: 'mode', selected: ['继续'] },
    { id: 'targets', selected: ['图片', '消息'] },
  ] })
  assert.deepEqual(answerQuestions([questions[0]], '换一种方式'), { answers: [
    { id: 'mode', selected: [], custom: '换一种方式' },
  ] })
})

test('adopts the global busy-enter preference with a queue-safe fallback', () => {
  assert.equal(busyEnterMode({ describe: () => [{ ns: 'ui-conversation', value: { busyEnter: 'steer' } }] }), 'steer')
  assert.equal(busyEnterMode({ describe: () => [{ ns: 'ui-conversation', value: { busyEnter: 'queue' } }] }), 'queue')
  assert.equal(busyEnterMode({ describe: () => [] }), 'queue')
})
