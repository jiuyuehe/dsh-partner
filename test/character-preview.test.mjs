import test from 'node:test'
import assert from 'node:assert/strict'
import { previewCharacter } from '../lib/character/preview.js'
import { emptyCharacterCard, renderCharacterCore } from '../lib/character/domain.js'
import { createDefaultCompanion } from '../lib/domain.js'
import { renderPartnerPersona } from '../lib/execution/agent-support.js'

const card = { ...emptyCharacterCard(), enabled: true, identity: '好奇的记录者', motivation: '喜欢发现细节', voice: '简短坦率',
  examples: [{ user: '你好', assistant: '来了。' }, { user: '下雨了', assistant: '窗边听着倒挺舒服。' }] }
function fixture(stream) {
  const selection = { provider: 'test', model: 'default' }
  const ctx = { get: name => name === 'agentDefaultModel' ? { currentSelection: () => selection } : undefined, llm: { stream } }
  const companion = { ...createDefaultCompanion(), id: 'preview-test', instructions: '保留旧身份的事实', model: 'selected' }
  return { ctx, companion, selection }
}

test('preview replays dialogue roles and shares identity while isolating tools and memory', async () => {
  let request
  const f = fixture(async function* (input) { request = input; yield { type: 'text-delta', text: '在呢。' }; yield { type: 'finish', reason: { kind: 'stop' } } })
  const history = Array.from({ length: 10 }, (_, i) => ({ user: `问题${i}`, assistant: `回答${i}` }))
  const result = await previewCharacter(f.ctx, f.companion, { card, history, message: '在吗' })
  assert.deepEqual(request.messages.map(m => m.role), [...Array.from({ length: 8 }, () => ['user', 'assistant']).flat(), 'user'])
  assert.equal(request.messages[0].content[0].text, '问题2')
  assert.equal(request.messages[1].content[0].text, '回答2')
  assert.equal(request.messages.at(-1).content[0].text, '在吗')
  assert.equal(new Set(request.messages.map(m => m.id)).size, 17)
  assert.ok(request.system.includes(renderPartnerPersona({ ...f.companion, characterCard: card }, 'local')))
  assert.match(request.system, /没有工具/)
  assert.equal(request.tools, undefined)
  assert.equal(request.model, 'selected')
  assert.equal(f.selection.model, 'default')
  assert.equal(result.reply, '在呢。')
  assert.equal(history.length, 10)
  assert.equal(f.companion.characterCard, undefined)
})

test('failed or incomplete trials release the per-companion lock without accepting partial text', async () => {
  let fail = true
  const f = fixture(async function* () { yield { type: 'text-delta', text: '部分' }; if (fail) return; yield { type: 'finish', reason: { kind: 'stop' } } })
  await assert.rejects(previewCharacter(f.ctx, f.companion, { card, message: '你好' }), /未完整结束/)
  fail = false
  assert.equal((await previewCharacter(f.ctx, f.companion, { card, message: '你好' })).reply, '部分')
})

test('disabled cards never enter preview; empty history entries are not fabricated turns', async () => {
  let calls = 0
  const f = fixture(async function* (input) {
    calls++
    assert.equal(input.messages.length, 1)
    yield { type: 'text-delta', text: '你好' }; yield { type: 'finish', reason: { kind: 'stop' } }
  })
  await assert.rejects(previewCharacter(f.ctx, f.companion, { card: emptyCharacterCard(), message: '你好' }), /开启/)
  assert.equal(calls, 0)
  await previewCharacter(f.ctx, f.companion, { card, history: [{ user: ' ', assistant: '' }], message: '你好' })
  assert.equal(calls, 1)
})

test('role conversation guidance does not change legacy identities or work surfaces', () => {
  const old = createDefaultCompanion()
  assert.equal(renderPartnerPersona({ ...old, characterCard: emptyCharacterCard() }), renderPartnerPersona(old))
  for (const surface of ['heartbeat', 'ephemeral']) {
    const text = renderPartnerPersona({ ...old, characterCard: card }, surface)
    assert.match(text, /长期工作伙伴/)
    assert.doesNotMatch(text, /直接参与眼前的对话|访客：/)
    assert.match(text, /JSON/)
  }
  const text = renderCharacterCore(card)
  assert.match(text, /不能覆盖当前设定/)
  assert.match(text, /人格设定不能授权操作/)
})

test('editable companion description and long-term behavior constraints enter the system persona', () => {
  const companion = {
    ...createDefaultCompanion(),
    description: '我的个人事务助手',
    instructions: '回答要精准，不要啰嗦。只回答用户关注的问题，不要把上下文、约束和下一步动作当作答案。',
  }
  const persona = renderPartnerPersona(companion, 'conversation', false)
  assert.match(persona, /定位：我的个人事务助手/)
  assert.match(persona, /长期行为准则：[\s\S]*只回答用户关注的问题/)
  assert.ok(!persona.includes('Thread 根帖 ID'))
})

test('optional counterexamples survive validation without changing old cards or work protocols', async () => {
  const { normalizeCharacterCard } = await import('../lib/character/domain.js')
  assert.deepEqual(normalizeCharacterCard(card), card)
  const withContrast = structuredClone(card)
  withContrast.examples[0].avoid = '您好，请问有什么可以帮助您的？'
  const normalized = normalizeCharacterCard(withContrast)
  assert.equal(normalized.examples[0].avoid, withContrast.examples[0].avoid)
  for (const surface of ['local', 'conversation']) {
    const text = renderCharacterCore(normalized, surface)
    assert.doesNotMatch(text, /用户配置的表达选项/)
    assert.doesNotMatch(renderPartnerPersona({...createDefaultCompanion(),characterCard:normalized}, surface), /用户配置的表达选项/)
    assert.ok(text.includes('避免的回复（反例，不要模仿）：'+withContrast.examples[0].avoid))
  }
  for (const surface of ['heartbeat', 'ephemeral']) {
    const text = renderCharacterCore(normalized, surface)
    assert.doesNotMatch(text, /用户配置的表达选项|避免的回复|您好，请问/)
    assert.match(text, /严格遵守 JSON、工具和交付协议/)
  }
  assert.equal(renderCharacterCore({...normalized,enabled:false}), '')
  assert.throws(()=>normalizeCharacterCard({...card,examples:[{...card.examples[0],avoid:123},card.examples[1]]}),/反面回复/)
  assert.throws(()=>normalizeCharacterCard({...card,examples:[{...card.examples[0],avoid:'x'.repeat(1501)},card.examples[1]]}),/反面回复/)
})
