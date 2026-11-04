import { asMemoryScopeId } from './ids.js'
import type { ConversationRoute, MemorySharingMode } from './domain.js'
import type { MemoryScopeId } from './ids.js'

function encode(value: string): string {
  if (!value || value !== value.trim()) throw new Error('Memory scope identity must be a non-empty stable ID')
  return encodeURIComponent(value)
}

/** Memory sharing is explicit and independent of Session identity. */
export function memoryScopeForRoute(route: ConversationRoute, mode: MemorySharingMode = 'isolated'): MemoryScopeId {
  if (mode === 'isolated') return asMemoryScopeId(`ms:v1:conversation:${encode(route.conversationKey)}`)
  if (mode === 'companion') return asMemoryScopeId(`ms:v1:companion:${encode(route.companionId)}`)
  const channelId = route.channelId ?? route.externalConversationId
  return asMemoryScopeId([
    'ms:v1:channel',
    route.platform,
    route.accountId,
    route.channelConfigId,
    channelId,
  ].map(encode).join(':'))
}
