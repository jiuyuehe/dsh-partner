import { sleepPolicy as resolvedSleepPolicy, type SleepPolicy } from '../character/sleep.js'
import { normalizeCompanionDraft, type Companion, type PartnerState } from '../domain.js'
import { emptyCharacterCard, type CharacterCard } from '../character/domain.js'
import { DEFAULT_IDLE_CONTACT, idleContactRouteAllowed, type IdleContactPolicy } from '../character/idle-contact.js'
import { record } from '../core/validation.js'

/** One authoritative identity, shared by page editing and AI updates. */
export interface CompanionIdentity {
  name: string
  role: string
  description: string
  instructions: string
  relationshipText?: string
  characterCard?: CharacterCard
  idleContact?: IdleContactPolicy
  sleepPolicy?: SleepPolicy
}
export const IDENTITY_FIELDS = ['name', 'role', 'description', 'instructions', 'relationshipText', 'characterCard', 'idleContact', 'sleepPolicy'] as const
export function effectiveIdentity(value: CompanionIdentity): CompanionIdentity {
  const { name, role, description, instructions, relationshipText, characterCard, idleContact, sleepPolicy } = value
  return structuredClone({ name, role, description, instructions, ...(relationshipText !== undefined ? { relationshipText } : {}), ...(characterCard ? { characterCard } : {}), ...(idleContact ? { idleContact } : {}), ...(sleepPolicy ? { sleepPolicy } : {}) })
}
export function pageIdentity(value: CompanionIdentity & { identityDraft?: CompanionIdentity }): CompanionIdentity {
  return effectiveIdentity(value)
}
/** Selected scalars replace; nested objects merge one level; arrays replace. null clears optional sections. */
export function patchIdentity(previous: CompanionIdentity, raw: unknown): CompanionIdentity {
  const patch = record(raw, 'identity')
  if (!Object.keys(patch).length) throw new Error('请至少填写一项身份内容')
  for (const key of Object.keys(patch)) if (!(IDENTITY_FIELDS as readonly string[]).includes(key)) throw new Error(`身份不支持修改 ${key}`)
  const next = { ...effectiveIdentity(previous), ...patch }
  for (const key of ['characterCard', 'idleContact', 'sleepPolicy'] as const) {
    if (patch[key] === null) delete next[key]
    else if (patch[key] !== undefined) next[key] = { ...(previous[key] ?? (key === 'characterCard' ? emptyCharacterCard() : key === 'idleContact' ? DEFAULT_IDLE_CONTACT : resolvedSleepPolicy(previous))), ...record(patch[key], key) } as never
  }
  return effectiveIdentity(normalizeCompanionDraft(next))
}
export function applyIdentity(state: PartnerState, companion: Companion, raw: unknown, expectedAt: unknown, source: 'page' | 'ai'): void {
  if (typeof expectedAt !== 'number' || companion.updatedAt !== expectedAt) throw new Error('身份已变化，请刷新并读取最新版本后重试；本次未保存')
  if (source === 'page') {
    const input = record(raw, 'identity')
    for (const key of ['name', 'role', 'description', 'instructions']) if (typeof input[key] !== 'string') throw new Error('请提交完整身份内容')
  }
  if (source === 'ai') {
    const patch = record(raw, 'identity')
    if (patch.idleContact !== undefined) {
      const policy = patch.idleContact === null ? undefined : record(patch.idleContact, 'idleContact')
      if (policy && 'selfRefinement' in policy) throw new Error('自主调整权限只能在页面设置')
      if (!policy && companion.idleContact?.selfRefinement) throw new Error('不能通过清空活动设置修改自主调整权限')
    }
  }
  const next = patchIdentity(source === 'page' ? { name: '', role: '', description: '', instructions: '' } : companion, raw)
  if (next.idleContact?.enabled && !idleContactRouteAllowed(state, companion, next.idleContact.routeId)) throw new Error('请选择本伙伴可用的会话；渠道联系人须已授权')
  delete companion.identityDraft
  for (const key of IDENTITY_FIELDS) delete (companion as unknown as Record<string, unknown>)[key]
  Object.assign(companion, next)
  companion.updatedAt = Math.max(Date.now(), companion.updatedAt + 1)
}
