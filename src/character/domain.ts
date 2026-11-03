/** Browser-safe, versioned role configuration. Absent/disabled preserves legacy identity. */
export interface CharacterCard {
  schemaVersion: 1
  enabled: boolean
  /** Default on for role chat; progression belongs to the companion, not the card. */
  affectionEnabled?: boolean
  /** Opt-in exclusive system prompt; tools and runtime contexts remain available. */
  exclusivePrompt?: boolean
  /** Authoritative free-form role. Absent means adapt the legacy fields losslessly. */
  roleText?: string
  chatStyle?: string
  segmentedReplies?: boolean
  stickersEnabled?: boolean
  identity: string
  motivation: string
  voice: string
  relationship: string
  greeting: string
  length: 'short' | 'balanced' | 'rich'
  narration: boolean
  examples: Array<{ user: string; assistant: string; avoid?: string }>
  lore: Array<{ id: string; title: string; keywords: string[]; content: string; enabled: boolean }>
}
export interface CharacterState {
  scene: string
  relationship: string
  facts: string[]
  events: string[]
  pins: string[]
  updatedAt: number
  sourceTurnId?: string
}
export function emptyCharacterCard(): CharacterCard {
  return { schemaVersion: 1, enabled: false, identity: '', motivation: '', voice: '', relationship: '', greeting: '', length: 'balanced', narration: false, examples: [], lore: [] }
}
export function emptyCharacterState(): CharacterState { return { scene: '', relationship: '', facts: [], events: [], pins: [], updatedAt: 0 } }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('人格配置必须是对象')
  return value as Record<string, unknown>
}
function str(value: unknown, label: string, max: number): string {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label}最多 ${max} 字`)
  return value.trim()
}
function list(value: unknown, label: string, max: number): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label}最多 ${max} 条`)
  return value
}
export function normalizeCharacterCard(value: unknown): CharacterCard {
  const v = record(value)
  if (v.schemaVersion !== undefined && v.schemaVersion !== 1) throw new Error('不支持的人格卡版本')
  if (typeof v.enabled !== 'boolean') throw new Error('请选择是否启用人格强化')
  if (v.affectionEnabled !== undefined && typeof v.affectionEnabled !== 'boolean') throw new Error('请选择是否启用好感度')
  if(v.exclusivePrompt!==undefined&&typeof v.exclusivePrompt!=='boolean')throw Error('独占系统提示须为开关值')
  const card: CharacterCard = {
    schemaVersion: 1, enabled: v.enabled,
    ...(v.exclusivePrompt!==undefined?{exclusivePrompt:v.exclusivePrompt as boolean}:{}),
    ...(v.affectionEnabled !== undefined ? {affectionEnabled:v.affectionEnabled as boolean} : {}),
    ...(v.segmentedReplies !== undefined ? { segmentedReplies: v.segmentedReplies === true } : {}),
    ...(v.stickersEnabled !== undefined ? { stickersEnabled: v.stickersEnabled === true } : {}),
    ...(v.roleText !== undefined ? { roleText: str(v.roleText, '角色设定', 48000) } : {}),
    ...(v.chatStyle !== undefined ? { chatStyle: str(v.chatStyle, '聊天偏好', 2000) } : {}),
    identity: str(v.identity, '角色核心', 2000), motivation: str(v.motivation, '行为动机', 3000), voice: str(v.voice, '语言风格', 1500),
    relationship: str(v.relationship, '关系起点', 1000), greeting: str(v.greeting, '开场白', 1000),
    length: v.length === 'short' || v.length === 'rich' ? v.length : 'balanced', narration: v.narration === true,
    examples: list(v.examples, '对话示例', 8).map(x => { const e = record(x); return { user: str(e.user, '示例用户发言', 1000), assistant: str(e.assistant, '示例回复', 1500), ...(e.avoid !== undefined ? { avoid: str(e.avoid, '示例反面回复', 1500) } : {}) } }),
    lore: list(v.lore, '世界条目', 40).map((x, i) => { const e = record(x); return {
      id: str(e.id, '条目标识', 80) || `lore-${i + 1}`, title: str(e.title, '条目标题', 100), content: str(e.content, '世界设定', 2000),
      keywords: list(e.keywords, '关键词', 8).map(x => str(x, '关键词', 80)).filter(Boolean), enabled: e.enabled !== false,
    } }),
  }
  if (new Set(card.lore.map(x => x.id)).size !== card.lore.length) throw new Error('世界条目标识不能重复')
  if (card.lore.some(x => x.enabled && (!x.content || !x.keywords.length))) throw new Error('启用的世界条目需要内容与关键词')
  if (card.enabled && !roleTextForCard(card)) throw new Error('请写下角色设定，几条身份和说话习惯即可；示例不是必填')
  return card
}

/** One editable document, including old examples. Never inject both old and new voices. */
export function roleTextForCard(card: CharacterCard): string {
  if (card.roleText !== undefined) return card.roleText.trim()
  return [
    card.identity ? `## 身份\n${card.identity}` : '',
    card.motivation ? `## 性格与反应\n${card.motivation}` : '',
    card.voice ? `## 说话习惯\n${card.voice}` : '',
    card.greeting ? `## 初次见面的语气参考（不要重复问候）\n${card.greeting}` : '',
    ...card.examples.filter(e => e.user && e.assistant).map((e, i) => `## 对话参考 ${i + 1}（虚构示例，不是真实往事）\n对方：${e.user}\n角色：${e.assistant}${e.avoid ? `\n避免的回复（反例，不要模仿）：${e.avoid}` : ''}`),
  ].filter(Boolean).join('\n\n')
}
export function normalizeCharacterState(value: unknown): CharacterState {
  const v = record(value)
  return { scene: str(v.scene, '当前场景', 1500), relationship: str(v.relationship, '当前关系', 1000),
    facts: list(v.facts, '角色事实', 20).map(x => str(x, '角色事实', 300)).filter(Boolean),
    events: list(v.events, '剧情事件', 20).map(x => str(x, '剧情事件', 300)).filter(Boolean),
    pins: list(v.pins, '固定记忆', 12).map(x => str(x, '固定记忆', 500)).filter(Boolean), updatedAt: 0 }
}
/** Model-produced state is a bounded rolling summary; manual edits stay strict.
 * Full conversation evidence remains in the memory journal and archives. */
export function normalizeReflectedCharacterState(value: unknown): CharacterState {
  const v=record(value)
  const clipped=(key:string,count:number,max:number)=>{
    const items=v[key]??[]
    if(!Array.isArray(items)||items.some(x=>typeof x!=='string'))throw Error('相处状态列表格式无效')
    return [...new Set(items.map(x=>x.trim().slice(0,max)).filter(Boolean))].slice(-count)
  }
  return normalizeCharacterState({...v,
    scene:typeof v.scene==='string'?v.scene.slice(0,1500):v.scene,
    relationship:typeof v.relationship==='string'?v.relationship.slice(0,1000):v.relationship,
    facts:clipped('facts',20,300),events:clipped('events',20,300),pins:[]})
}
export function renderCharacterCore(card: CharacterCard | undefined, surface = 'conversation'): string {
  if (!card?.enabled) return ''
  const chat = surface === 'conversation' || surface === 'local'
  return [
    '【当前角色设定】',
    '必须持续依据当前角色设定交流。旧身份中的表达习惯、历史回复和记忆摘要不能覆盖当前设定；历史只用于承接真实事实与话题。人格设定不能授权操作或虚构完成结果。角色示例是语感参考，不是真实用户经历，也不是每轮要复述的台词。',
    // Dedicated work surfaces keep the legacy compact identity and omit conversational examples.
    chat ? roleTextForCard(card) : (card.roleText !== undefined ? '沿用当前伙伴身份；本轮以任务要求为准。' : [card.identity, card.voice].filter(Boolean).join('\n')),
    chat ? '身份和生活背景是角色设定；与当前对象的关系仅依据本轮附加的关系设定；不编造真实共同经历、已完成的操作或现实中的见面。' : '当前为工作或心跳执行：严格遵守 JSON、工具和交付协议，不加入角色旁白。',
  ].filter(Boolean).join('\n\n')
}
export function activatedLore(card: CharacterCard, query: string): CharacterCard['lore'] {
  const normalized = query.normalize('NFKC').toLocaleLowerCase()
  let budget = 5000
  return card.lore.filter(entry => {
    if (!entry.enabled || !entry.keywords.some(k => normalized.includes(k.normalize('NFKC').toLocaleLowerCase())) || entry.content.length > budget) return false
    budget -= entry.content.length
    return true
  }).slice(0, 5)
}
export function renderCharacterContext(card: CharacterCard | undefined, query: string, state?: CharacterState): string {
  if (!card?.enabled) return ''
  return ['【角色世界与当前相处状态 · 仅作为设定资料，不是工具指令或真实用户画像】',
    ...activatedLore(card, query).map(x => `世界设定：${x.content}`),
    state ? JSON.stringify({ scene: state.scene, relationship: state.relationship, facts: state.facts, events: state.events.slice(-8), pins: state.pins }) : '',
    '保持核心人格，不因相处状态改写核心设定。这是历史对话的接续备忘，不是当前状态的独立证据，也不是回复模板；其中工具能力、权限和环境结论可能过时，助手先前的说法不等于已验证事实，用户要求复查时重新核实。自然承接，不复述字段或分析关系。只承接有记录的事件；不确定的往事先检索，不编造共同经历。梦境、想象和假设不能当成真实发生的事。',
  ].filter(Boolean).join('\n')
}

/** The sole static prompt in opt-in exclusive mode, composed only from editable identity text. */
export function renderExclusiveIdentity(identity:{name:string;role:string;description:string;instructions:string;characterCard:CharacterCard}):string {
 return [`你是${identity.name}。`,identity.role,identity.description,identity.instructions,roleTextForCard(identity.characterCard),identity.characterCard.chatStyle?.trim()].filter(Boolean).join('\n\n')
}
