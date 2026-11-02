import type { Companion, PartnerState } from '../domain.js'
import { record } from '../core/validation.js'
import { applyIdentity, type CompanionIdentity } from './identity.js'

export interface PersonaRevision {
  at: number
  reason: string
  before: Partial<CompanionIdentity>
  after: Partial<CompanionIdentity>
}
const fields = ['name', 'role', 'description', 'instructions', 'characterCard']
const cardFields = ['roleText', 'chatStyle', 'identity', 'motivation', 'voice', 'greeting', 'examples', 'lore']
/** Only self-description, never policy, user relationship or delivery settings. */
export function applyPersonaRefinement(state: PartnerState, companion: Companion, raw: unknown, expectedAt: unknown, reason: unknown): void {
  if (!companion.idleContact?.enabled || !companion.idleContact.selfRefinement) throw Error('自主调整角色设定未开启')
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw Error('请简短记录自主调整的原因（最多 500 字）')
  const patch = record(raw, 'patch')
  for (const key of Object.keys(patch)) if (!fields.includes(key)) throw Error(`自主调整不能修改 ${key}`)
  if (patch.characterCard !== undefined) {
    const card = record(patch.characterCard, 'characterCard')
    if (!companion.characterCard?.enabled) throw Error('请先在页面启用角色设定')
    for (const key of Object.keys(card)) if (!cardFields.includes(key)) throw Error(`自主调整不能修改 characterCard.${key}`)
  }
  const before: Record<string, unknown> = {}, after: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'characterCard') {
      const previous: Record<string, unknown> = {}, changes: Record<string, unknown> = {}
      for (const [field, next] of Object.entries(record(value, key))) {
        const old = (companion.characterCard as unknown as Record<string, unknown>)[field]
        if (JSON.stringify(old) === JSON.stringify(next)) continue
        previous[field] = old ?? (['examples', 'lore'].includes(field) ? [] : '')
        changes[field] = next
      }
      if (Object.keys(changes).length) { before[key] = previous; after[key] = changes }
    } else if (companion[key as keyof Companion] !== value) {
      before[key] = companion[key as keyof Companion]; after[key] = value
    }
  }
  if (!Object.keys(after).length) throw Error('设定没有变化，无需重复保存')
  applyIdentity(state, companion, after, expectedAt, 'ai')
  companion.personaHistory = [...(companion.personaHistory ?? []), { at: companion.updatedAt, reason: reason.trim(), before, after }].slice(-12)
}
