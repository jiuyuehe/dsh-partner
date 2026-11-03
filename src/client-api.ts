import { createSnapshotCache } from './snapshot-cache.js'
export const PARTNER_API = '/partner-local/v1'

export type { CompanionCapability as Capability } from './capabilities.js'
import type { CompanionCapability as Capability } from './capabilities.js'
export interface AutomationView {
  memory: { enabled: boolean; retentionDays: number; provider?: string; model?: string; rollingContextEnabled?: boolean; rollingContextTurns?: number; rollingContextMaxChars?: number; contextRenewalEnabled?: boolean; contextRenewalHour?: number; dailyReviewEnabled: boolean; dailyReviewHour: number }
  heartbeat: { enabled: boolean; intervalMinutes: number; quietStartHour: number; quietEndHour: number; dailyLimit: number }
}
export interface CompanionView {
  activityJournal?: import('./character/activity-journal.js').ActivityJournalEntry[]
  activityPlan?: import('./character/activity-plan.js').ActivityPlan
  thoughts?: import('./character/thoughts.js').CompanionThought[]
  interactionReview?: import('./character/interaction-review.js').InteractionReviewState
  personaHistory?: import('./companions/persona-refinement.js').PersonaRevision[]
  affection?: import('./character/affection.js').AffectionState
  toolDiscovery?: boolean
  sleepPolicy?: import('./character/sleep.js').SleepPolicy
  sleepState?: import('./character/sleep.js').SleepState
  relationshipText?: string
  /** Legacy archive, never used as the editor source. */
  identityDraft?: import('./companions/identity.js').CompanionIdentity
  idleContact?: import('./character/idle-contact.js').IdleContactPolicy
  characterCard?: import('./character/domain.js').CharacterCard
  notificationDelivery?: { mode: 'recent' | 'selected'; targets: {channelId: string; userId: string}[] }
  id: string; name: string; role: string; description: string; instructions: string
  presetId?: string; provider?: string; model?: string; capabilities: Capability[]
  createdAt: number; updatedAt: number
  automation: AutomationView
}
export interface ChannelView {
  qq?: import('./channels/qq/settings.js').QqSettings
  qqActivity?: import('./channels/qq/actions.js').QqActionReceipt[]
  platform?: 'weixin' | 'matrix' | 'mattermost' | 'qq'
  direct?: { baseUrl: string; targetId: string; peerId: string }
  id: string; companionId: string; accountId: string; name: string; enabled: boolean
  createdAt: number; updatedAt: number; runtimeStatus: 'stopped' | 'starting' | 'running' | 'error'
  activity?: {kind:string;label:string;sessionId?:string}[]
  groupDecision?: {at:number;groupId:string;reason:string}
  idleDelivery?: string
  lastError?: string; credentialConfigured: boolean
}
export interface PairingView {
  directTargetId?: string
  pairingCode?: string
  contactKey?: string
  deliveryTarget?: {channelId: string; userId: string}
  id: string; channelId: string; userId: string; displayName: string
  status: 'pending' | 'approved' | 'blocked'; createdAt: number; updatedAt: number
}
export interface ChannelSessionView {
  id: string; kind: 'local' | 'channel'; channelId: string; userId: string; companionId: string; sessionId: string; cwd?: string; lastMessageAt: number; archived: boolean
}
export interface HeartbeatStateView {
  companionId: string; lastCheckedAt?: number; lastSentAt?: number; nextCheckAt: number
  sentDay: string; sentCount: number; consecutiveFailures: number; lastError?: string; lastOutcome?: 'success' | 'partial' | 'blocked'
}
export type MemoryKindView = 'profile' | 'preference' | 'task' | 'event' | 'relationship' | 'emotion'
export interface MemoryEvidenceView { turnId: string; at: number; excerpt: string }
export interface MemoryView { id: string; scopeId: string; kind: MemoryKindView; subject: string; content: string; status: 'active' | 'completed' | 'superseded' | 'expired'; confidence: number; importance: number; updatedAt: number; locked?: boolean; evidence: MemoryEvidenceView[] }
export interface UserProfileSnapshotView { persona?: import('./persona/types.js').PersonaView; scopeId: string; label: string; version: string; updatedAt?: number; entries: MemoryView[]; preferences?: MemoryView[]; evidenceCount: number; lockedCount: number }
export interface MemoryRelationView { id: string; scopeId: string; sourceMemoryId: string; targetMemoryId: string; kind: 'supports' | 'depends_on' | 'about' | 'conflicts_with' | 'follows'; label: string; confidence: number; updatedAt: number }
export interface MemoryGraphView { memories: MemoryView[]; relations: MemoryRelationView[] }
export interface DailyReflectionView { scopeId: string; date: string; summary: string; events: string[]; openTasks: string[]; completedTasks: string[]; learnings: string[]; updatedAt: number; turnCount: number }
export interface ConcernView {
  executionInstructions?: string
  control?: import('./concern-attention.js').ConcernControl
  adjustments?: import('./concern-attention.js').ConcernAdjustment[]
  recordingPending?: boolean
  recordTarget?: ConcernRecordTargetView
  id: string; subject: string; reason: string; origin: 'explicit' | 'implicit'; state: 'active' | 'watching' | 'snoozed' | 'resolved' | 'archived'
  priority: number; confidence: number; score: number; watchKind: 'auto' | 'knowledge' | 'workspace' | 'web'; updatedAt: number; nextCheckAt: number; lastCheckedAt?: number
  resources: Array<{ kind: 'file' | 'knowledge' | 'note'; locator: string; label: string }>
}
export interface ConcernRecordTargetView { kind: 'file' | 'note'; locator: string; label: string }
export interface ConcernObservationView {
  id: string; concernId: string; event: string; evidence: string; source: string; interruptScore: number
  decision: 'drop' | 'remember' | 'defer' | 'feed' | 'notify'; notificationRuleEffect: 'auto' | 'notify' | 'suppress'
  notificationRuleReason: string; decisionReason: string; createdAt: number; mentionedAt?: number
}
export interface ConcernExecutionView {id:string;concernId:string;status:'pending'|'running'|'completed'|'failed';updatedAt:number;createdAt:number;error?:string;recoveryFromMessageId?:string}
export interface ConcernActivityView { concerns: ConcernView[]; observations: ConcernObservationView[]; executions?:ConcernExecutionView[] }
export interface ConcernSourceView { kind: 'file' | 'knowledge' | 'note'; label: string; detail: string; token: string }
export interface PresetView { id: string; name: string; broken?: string }
export interface ModelCatalogView { providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>; defaultSelection: { provider: string; model: string } }
export interface PartnerSnapshot {
  pushChannels?: import('./notifications/push-domain.js').PushChannelView[]
  companions: CompanionView[]; channels: ChannelView[]; pairings: PairingView[]; sessions: ChannelSessionView[]; heartbeatStates: HeartbeatStateView[]; presets: PresetView[]
}
export interface LoginView {
  id: string; companionId: string; phase: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error'
  qrContent?: string; accountId?: string; baseUrl?: string; error?: string; expiresAt: number
}

export interface SkillView {
  id: string; name: string; displayName: string; description: string; version: string
  source: 'builtin' | 'market' | 'local'; sourceId?: string; executionContext: 'inline' | 'fork'; trusted: boolean; updatedAt: number
}
export interface SkillBindingView { companionId: string; skillId: string; enabled: boolean }
export interface SkillMarketSourceView { id: string; name: string; kind: 'dsh-index' | 'clawhub' | 'loophub' | 'skillhub'; indexUrl: string; enabled: boolean; trusted: boolean; builtin?: boolean }
export interface MarketSkillView { id: string; name: string; description: string; version: string; tags: string[]; sourceId: string }
export interface SkillCatalogView { installed: SkillView[]; bindings: SkillBindingView[]; sources: SkillMarketSourceView[] }
export interface SkillMarketView { sources: SkillMarketSourceView[]; entries: MarketSkillView[]; errors: Array<{ sourceId: string; error: string }> }
export interface SkillMarketNetworkView { proxyUrl?: string }
export interface SkillMarketNetworkTestView { ok: true; latencyMs: number; sourceCount: number; entryCount: number }

export type BoardTaskStatusView = 'backlog' | 'ready' | 'doing' | 'review' | 'done' | 'blocked'
export interface BoardTaskView {
  acceptanceCriteria?: string[]; resourceKeys?: string[]
  evidence?: import('./tasks/contract.js').TaskEvidence[]; reviewChecks?: import('./tasks/contract.js').TaskReviewCheck[]
  previousAttempt?: { reviewChecks?: import('./tasks/contract.js').TaskReviewCheck[] }
  scheduling?: import('./tasks/scheduling.js').TaskScheduling
  requirementId?: string
  autoRun?: boolean
  id: string; title: string; description: string; status: BoardTaskStatusView; priority: 'low' | 'normal' | 'high' | 'urgent'
  assigneeCompanionId?: string; reviewerCompanionId?: string; createdBy: 'user' | 'companion' | 'schedule'; revision: number; createdAt: number; updatedAt: number; completedAt?: number
  skillIds: string[]; dependencyTaskIds: string[]; resultAbstract?: string; resultSummary?: string; reviewHandoff?: string; reviewSummary?: string; dueAt?: number
}
export interface TaskActivityView { id: string; taskId: string; actor: 'user' | 'companion' | 'schedule' | 'system'; actorCompanionId?: string; kind: string; message: string; at: number }
export type { BoardRequirement as RequirementView } from './requirements/domain.js'
export interface TaskBoardView { tasks: BoardTaskView[]; activities: TaskActivityView[]; requirements?: import('./requirements/domain.js').BoardRequirement[] }
export interface PartnerDirectoryEntryView { id: string; name: string; role: string; description: string; capabilities: string[]; enabledSkills: Array<{ id: string; name: string }>; availability: 'available' | 'busy' | 'offline' }
export interface PartnerDelegationView {
  id: string; kind?: 'task' | 'review'; taskId: string; toCompanionId: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled'
  attempts?: number; nextAttemptAt?: number; lastAttemptAt?: number; error?: string; createdAt: number
}
export interface CompanionAccessView { targetIds: string[]; companions: PartnerDirectoryEntryView[] }

export type ScheduledTaskView = import('./scheduler/domain.js').ScheduledPartnerTask
export interface ExecutionRunView { id: string; kind: 'work' | 'schedule' | 'delegation' | 'review' | 'skill' | 'observation'; ownerCompanionId: string; sessionId: string; sourceId: string; status: string; destroyAfterRun: boolean; startedAt: number; completedAt?: number; outputSummary?: string; error?: string }

export async function api<T>(path = '', init: RequestInit = {}): Promise<T> {
  const method = init.method ?? 'GET'
  if (method !== 'GET') partnerSnapshotCache.invalidate()
  const response = await fetch(`${PARTNER_API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-DSH-Partner-Request': '1' }),
      ...init.headers,
    },
  })
  if (method !== 'GET' || response.status === 401 || response.status === 403) partnerSnapshotCache.invalidate()
  if (response.status === 204) return undefined as T
  const body = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${response.status}`)
  return body as T
}

const partnerSnapshotCache = createSnapshotCache<PartnerSnapshot>(() => api('', {signal: AbortSignal.timeout(15_000)}))
export const cachedPartner = partnerSnapshotCache.peek
export function loadPartner(): Promise<PartnerSnapshot> { return partnerSnapshotCache.load() }
