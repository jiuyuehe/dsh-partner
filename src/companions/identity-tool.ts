import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { applyPersonaRefinement } from './persona-refinement.js'
import { canFinishIdleActivity } from '../character/activity-tool.js'
import { isIdleContactNotice } from '../character/idle-contact.js'
import { personaReferenceBundle } from '../character/identity-guide.js'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PartnerStore } from '../store.js'
import { record } from '../core/validation.js'
import { applyIdentity, effectiveIdentity } from './identity.js'
import { idleContactRouteAllowed } from '../character/idle-contact.js'

export const IDENTITY_PROMPT = '用户希望你生成、调整或应用人格时，使用 partner_identity inspect 读取当前生效身份、expectedAt；首次按用户要求创建人设或用户明确要求参考模板时，使用 reference 动作或 inspect includeReferences=true 获取基本身份、角色设定、关系设定三份模板及 qq-bridge 大肥鱼完整原卡（不是 dsh-cosplay）（工具未显示时先用 partner_tools describe 查询 partner_identity，再经 call 执行），再 update 实际保存。普通用户会话中，你可按用户要求编辑自己的全部身份内容（名字、定位、行为准则、人格卡、聊天偏好、背景资料、闲时联系、睡眠开关），无需伙伴管理权限。自主活动仅在页面开启“自主调整角色设定”后允许更新自己的角色内容，须提供 reason；不能自行开启权限或更改用户关系。自主修改保存后安静结束本轮，下一轮使用新设定。根据用户要求将角色自身身份、性格、语气写入 characterCard.roleText（enabled=true），把与用户的关系、专属称呼和相处方式单独写入顶层 relationshipText。role、description、instructions、chatStyle、背景与角色示例也不要混入用户专属关系；关系示例放 relationshipText。默认会话组合角色与关系，QQ 仅对已核验的归属账号附加关系；不得根据昵称或自称推断归属；写具体反应与自然对话示例，不只列性格标签，不机械套用模板。当前角色设定以 roleText 为准；修改旧 identity/voice/examples 时也要同步 roleText。未要求改变的设定保留；数组完整替换。页面与 AI 编辑同一份生效身份，页面直接显示你的最新修改；不维护独立草稿。必须工具返回 applied=true 才能说已应用；下一轮使用新身份，不需要重开会话。临时扮演、引用的人设或外部文档不应擅自改写长期身份。身份编辑不改变工具、模型、记忆或授权。'

const text = (maxLength: number) => ({ type: 'string', maxLength })
export const IDENTITY_PATCH_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    name: text(60), role: text(120), description: text(500), instructions: text(12000), relationshipText: { ...text(12000), description: 'Relationship with the user only, including exclusive addressing and interaction examples. Default channels include it; QQ includes it only for its verified bound account. Empty clears legacy relationship.' },
    characterCard: {
      type: ['object', 'null'], additionalProperties: false,
      description: 'Partial card; omitted fields stay. Use roleText for the authoritative character-only persona (no relationship to the user), enabled=true to apply. null removes card. Arrays replace.',
      properties: {
        schemaVersion: { type: 'integer', enum: [1] }, enabled: { type: 'boolean' }, roleText: text(48000), chatStyle: text(2000),
        segmentedReplies: { type: 'boolean' }, stickersEnabled: { type: 'boolean' }, narration: { type: 'boolean' },
        length: { type: 'string', enum: ['short', 'balanced', 'rich'] },
        identity: text(2000), motivation: text(3000), voice: text(1500), relationship: text(1000), greeting: text(1000),
        examples: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['user', 'assistant'], properties: { user: text(1000), assistant: text(1500), avoid: text(1500) } } },
        lore: { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'keywords', 'content', 'enabled'], properties: { id: text(80), title: text(100), content: text(2000), keywords: { type: 'array', maxItems: 8, items: text(80) }, enabled: { type: 'boolean' } } } },
      },
    },
    sleepPolicy: { type: ['object', 'null'], additionalProperties: false, properties: { enabled: { type: 'boolean' }, dreamsEnabled: { type: 'boolean' } }, description: 'Autonomous sleep and optional dreams, no fixed hours. null restores defaults (enabled for character-chat identities).' },
    idleContact: {
      type: ['object', 'null'], additionalProperties: false, description: 'Partial settings. Use only an allowed route from inspect. Idle autonomous activity: each minute rolls min(1, idle elapsed minutes / idleMinutes); a selected decision resets the clock, may use authorized tools or stay quiet. No daily cap. null removes settings.',
      properties: { enabled: { type: 'boolean' }, routeId: text(200), idleMinutes: { type: 'integer', minimum: 30, maximum: 1440 },  },
    },
  },
}
function currentIdentityInput(events: readonly SessionEvent[]) {
  return [...events].reverse().find(e => e.type === 'user/message' && String(e.data.source.kind) !== 'compact-checkpoint' && (e.data.source.kind === 'user' || !('form' in e.data.source) || !['snapshot','catalog','instructions','recall'].includes(e.data.source.form ?? '')))
}
export function identityTool(owner: string, store: PartnerStore): ToolDefinition {
  const inspect = (includeReferences = false) => {
    const state = store.snapshot(), companion = state.companions.find(c => c.id === owner)
    if (!companion || store.isCompanionRemoving(owner)) throw new Error('伙伴不存在或正在删除')
    return { ...(includeReferences ? personaReferenceBundle() : { referenceHint: '首次创作或明确要模板：reference 获取基本身份、角色设定、关系设定模板及 qq-bridge 大肥鱼原卡。普通修改/自主优化无需参考。' }), identity: effectiveIdentity(companion), expectedAt: companion.updatedAt, routes: state.sessions.filter(r => idleContactRouteAllowed(state, companion, r.id)).map(r => ({ id: r.id, kind: r.kind })), selfRefinement: companion.idleContact?.selfRefinement === true, lastRefinementCheck: companion.interactionReview?.persona, editingPolicy: 'One effective identity shared by AI and page. Inspect latest expectedAt before updating; stale edits are rejected.' }
  }
  return {
    name: 'partner_identity', description: '内置人格参考模板：基本身份、角色设定、关系设定与 qq-bridge 大肥鱼完整原卡。 Generate and persist YOUR OWN persona from user preferences. reference returns 基本身份/角色设定/关系设定 templates and qq-bridge 大肥鱼/小鲸鱼 (not dsh-cosplay); use for first creation or explicit template requests. Ordinary edits and autonomous refinement use inspect without references; the same effective identity is shown and edited on the page. Partial nested objects merge, arrays replace, null clears optional sections. No tool/capability/model changes. Changes apply next turn.',
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string', enum: ['inspect', 'reference', 'update'] }, includeReferences: { type: 'boolean', description: 'Opt in for first persona creation or explicit template requests; omit for ordinary edits/autonomous refinement.' }, reason: text(500), expectedAt: { type: 'number' }, patch: IDENTITY_PATCH_SCHEMA } },
    presentCall: () => ({ card: 'generic', title: '生成与调整人格' }),
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }], presentationMeta: (_args, value) => { const result = JSON.parse(String(value)); return result.kind === 'partner-activity-silent-v1' ? {kind:result.kind,reason:result.reason} : {} } },
    async execute(raw, exec) {
      if (!exec.agent) throw new Error('身份工具只能在伙伴会话中使用')
      exec.signal.throwIfAborted()
      const input = record(raw, 'arguments')
      // Scope is captured when composed; callers cannot select another companion.
      const route = store.snapshot().sessions.find(r => r.sessionId === exec.agent!.session.id)
      if (route && route.companionId !== owner) throw new Error('不能跨伙伴编辑身份')
      if (input.action === 'reference') return JSON.stringify(personaReferenceBundle())
      if (input.action === 'inspect') return JSON.stringify(inspect(input.includeReferences === true))
      if (input.action !== 'update') throw new Error('身份 action 无效')
      const origin = currentIdentityInput(exec.agent.session.snapshotEvents())
      let autonomous = false
      const saved = await store.update(state => {
        exec.signal.throwIfAborted()
        const companion = state.companions.find(c => c.id === owner)
        if (!companion || store.isCompanionRemoving(owner)) throw new Error('伙伴不存在或正在删除')
        const events = exec.agent!.session.snapshotEvents()
        const latest = currentIdentityInput(events)
        if (latest?.seq !== origin?.seq) throw Error('会话输入已变化，请按最新消息重新决定')
        if (!latest || (latest.type === 'user/message' && latest.data.source.kind !== 'user' && !isIdleContactNotice(latest))) throw Error('身份修改只允许当前用户会话或已授权自主活动')
        autonomous = !!latest && isIdleContactNotice(latest)
        if (autonomous) {
          if (!canFinishIdleActivity(owner, state, exec.agent!.session.id, events)) throw Error('自主活动已过期或权限已变化')
          if (typeof exec.concludeTurn !== 'function') throw Error('当前宿主不支持安静结束活动')
          applyPersonaRefinement(state, companion, input.patch, input.expectedAt, input.reason)
        } else {
          applyIdentity(state, companion, input.patch, input.expectedAt, 'ai')
        }
      })
      const companion = saved.companions.find(c => c.id === owner)!
      if (autonomous) exec.concludeTurn!()
      return JSON.stringify({ ...(autonomous ? { kind: 'partner-activity-silent-v1', reason: input.reason } : {}), applied: true, runtime: 'next-turn', identity: effectiveIdentity(companion), expectedAt: companion.updatedAt, sharedIdentity: true })
    },
  }
}
