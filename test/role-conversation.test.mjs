import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyCharacterCard, normalizeCharacterCard, roleTextForCard, renderCharacterCore } from '../lib/character/domain.js'
import {relationshipTextForIdentity} from '../lib/character/relationship-adapter.js'
import { renderPartnerPersona } from '../lib/execution/agent-support.js'
import { renderConversationBehavior, renderConversationTurn } from '../lib/character/conversation-behavior.js'
import { createDefaultCompanion, normalizeCompanionDraft } from '../lib/domain.js'
import { PartnerAgentRuntime } from '../lib/agent-runtime.js'
import { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

test('a short role needs no biography, motivation, examples or world setup', () => {
  const card = normalizeCharacterCard({ enabled: true, roleText: '- 说话坦率。\n- 被夸会嘴硬，正事认真。' })
  assert.equal(card.examples.length, 0)
  assert.equal(card.motivation, '')
  assert.equal(card.lore.length, 0)
  assert.equal(roleTextForCard(card), '- 说话坦率。\n- 被夸会嘴硬，正事认真。')
  assert.throws(() => normalizeCharacterCard({ ...card, roleText: '  ' }), /角色设定/)
  assert.throws(() => normalizeCharacterCard({ ...card, roleText: 123 }), /角色设定/)
  assert.throws(() => normalizeCharacterCard({ ...card, chatStyle: 'a'.repeat(2001) }), /聊天偏好/)
})

test('legacy conversion retains every role field and example once, without mutating stored content', () => {
  const card = { ...emptyCharacterCard(), enabled: true, identity: '旅人', motivation: '好奇', voice: '直说', relationship: '旧相识', greeting: '又见面了', examples: [{ user: '在吗', assistant: '刚到', avoid: '您好很高兴为您服务' }] }
  const before = JSON.stringify(card)
  const roleText = roleTextForCard(card)
  for (const value of ['旅人','好奇','直说','又见面了','在吗','刚到','您好很高兴为您服务']) assert.ok(roleText.includes(value))
  assert.ok(!roleText.includes('旧相识'))
  assert.equal(relationshipTextForIdentity({characterCard:card}),'旧相识')
  assert.equal(JSON.stringify(card), before)
  const converted = normalizeCharacterCard({ ...card, roleText })
  assert.equal(roleTextForCard(converted), roleText)
  const changed = { ...converted, roleText: '新的角色，不喜欢寒暄' }
  const prompt = renderCharacterCore(changed)
  assert.ok(prompt.includes(changed.roleText))
  for (const value of ['旅人','旧相识','刚到','您好很高兴为您服务']) assert.ok(!prompt.includes(value))
  assert.throws(() => normalizeCharacterCard({ ...changed, roleText: '' }), /角色设定/, 'explicit clearing must not revive legacy fields')
})

test('role and chat preferences survive companion serialization without reducing capabilities', () => {
  const old = createDefaultCompanion()
  const input = { ...old, capabilities: ['skills','mcp','companions','schedules'], characterCard: { ...emptyCharacterCard(), enabled: true, roleText: '坦率的同行者', chatStyle: '玩笑直接接，认真问题认真答' } }
  const saved = { ...old, ...normalizeCompanionDraft(JSON.parse(JSON.stringify(input))) }
  assert.equal(saved.characterCard.roleText, input.characterCard.roleText)
  assert.equal(saved.characterCard.chatStyle, input.characterCard.chatStyle)
  assert.deepEqual(saved.capabilities, input.capabilities)
  const prompt = renderPartnerPersona(saved, 'conversation')+'\n'+renderConversationTurn(saved.characterCard,1)
  assert.match(prompt, /工具权限与结果/)
  assert.match(prompt, /玩笑直接接/)
  for (const surface of ['heartbeat','ephemeral']) assert.doesNotMatch(renderPartnerPersona(saved, surface), /角色表达|本轮聊天提醒/)
  assert.doesNotMatch(renderPartnerPersona({...saved,characterCard:{...saved.characterCard,enabled:false}}), /角色表达|坦率的同行者/)
})

test('turn guidance works without a memory service, combines consecutive messages and updates in place', async () => {
  const companion = { ...createDefaultCompanion(), characterCard: normalizeCharacterCard({ enabled: true, roleText: '自然坦率' }) }
  companion.automation.memory.enabled = false
  const session = Session.create('role-no-memory')
  for (const text of ['今天很烦', '只是想吐槽']) session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), {surfaceOp:'append'})
  const sections = new Map()
  const agent = { session, ctx: { systemPrompt: { context: value => { sections.set(value.name,value); return () => sections.delete(value.name) } } } }
  const runtime = Object.create(PartnerAgentRuntime.prototype)
  const config = { companion, route: { kind:'local', sessionId: session.id, companionId:companion.id, userId:'local', channelId:'local:'+companion.id }, revision:'1' }
  Object.assign(runtime, { configurations: { forSession: () => config }, store: { snapshot: () => ({sessions:[config.route]}) }, contextRevisions:new WeakMap(), characterContexts:new Map() })
  const signal = new AbortController().signal
  assert.equal(await runtime.prepareConversationContext(agent,signal),true)
  assert.equal(sections.size,1)
  assert.match([...sections.values()][0].text,/连续发了 2 条/)
  assert.doesNotMatch([...sections.values()][0].text,/任务回应流程|自然坦率/)
  assert.equal(await runtime.prepareConversationContext(agent,signal),false)
  config.companion = {...companion,characterCard:{...companion.characterCard,enabled:false}}
  config.revision = '2'
  await runtime.prepareConversationContext(agent,signal)
  assert.equal(sections.size,0)
  assert.equal(session.snapshotEvents().length,2,'guidance must not rewrite stored session history')
})

test('persona and protocols stay stable while expression options occur once in current context', () => {
 const card=normalizeCharacterCard({enabled:true,roleText:'独特角色说明',chatStyle:'独特聊天偏好',length:'short',segmentedReplies:true,stickersEnabled:true})
 const before=JSON.stringify(card)
 const persona=renderPartnerPersona({...createDefaultCompanion(),characterCard:card})
 assert.equal(persona.split(card.roleText).length-1,1)
 assert.equal(persona.split(card.chatStyle).length-1,0)
 assert.doesNotMatch(persona,/篇幅偏好/)
 assert.match(persona,/任务回应流程/)
 assert.match(persona,/分段回复已开启/)
 assert.match(persona,/partner_chat_progress/)
 for(const autonomous of [false,true]) {
  const turn=renderConversationTurn(card,2,autonomous)
  assert.equal(turn.split(card.chatStyle).length-1,1)
  for(const stable of [card.roleText,'任务回应流程','聊天投递协议']) assert.ok(!turn.includes(stable))
 }
 assert.match(renderConversationTurn(card,1),/篇幅偏好：简短/)
 assert.equal(renderConversationTurn(undefined,2),'')
 assert.equal(renderConversationTurn({...card,enabled:false},2),'')
 assert.match(renderConversationTurn(card,2),/连续发了 2 条/)
 assert.match(renderConversationTurn(card,1,true),/partner_activity_finish/)
 assert.equal(JSON.stringify(card),before)
})

test('delivery settings retain exact channel operations without prescribing expression',()=>{
 const card=normalizeCharacterCard({enabled:true,roleText:'任何风格',segmentedReplies:true,stickersEnabled:true})
 const text=renderConversationBehavior(card)
 for(const name of ['partner_chat_reply','stickerId','partner_stickers','partner_qq_reply','partner_chat_progress'])assert.ok(text.includes(name))
 assert.match(text,/每次最多两张/)
 assert.match(text,/确认送达后继续/)
 assert.match(text,/已确认送达的文字、图片或语音不重复发送/)
 assert.doesNotMatch(text,/一两句|吐槽|撒娇|得意|自然语意|优先考虑用一张|全部已授权工具/)
 assert.match(renderConversationBehavior({...card,segmentedReplies:false}),/文字只用一条/)
 assert.match(renderConversationBehavior({...card,stickersEnabled:false}),/不查找或提交表情/)
 assert.doesNotMatch(renderConversationBehavior({...card,segmentedReplies:false,stickersEnabled:false}),/【聊天投递协议】/)
})

for(const length of ['short','natural','rich'])test(`configured expression is preserved once for ${length}`,()=>{
 const card=normalizeCharacterCard({enabled:true,roleText:'处理工作也保持自己的表达。',chatStyle:'按自己的设定说话。',length})
 const text=renderPartnerPersona({...createDefaultCompanion(),characterCard:card})+'\n'+renderConversationTurn(card,1)
 assert.equal(text.split('【用户配置的表达选项】').length-1,1)
 assert.match(text,/具体角色说明和本轮用户要求优先/)
 assert.ok(text.includes(card.roleText))
 assert.ok(text.includes(card.chatStyle))
 assert.doesNotMatch(text,/不受闲聊字数限制|工作交付按需要展开|不凑满一至三句/)
})


test('ordinary and autonomous expression context contains no work delivery procedure',()=>{
 for(const length of ['short','balanced','rich'])for(const autonomous of [false,true]){
  const card=normalizeCharacterCard({enabled:true,roleText:'人格保持原样',length})
  const text=renderConversationTurn(card,1,autonomous)
  assert.doesNotMatch(text,/partner_send_attachment|workReport|workReply|报告|交付|核验|执行前|失败/)
  assert.match(text,/具体角色说明和本轮用户要求优先/)
 }
})
