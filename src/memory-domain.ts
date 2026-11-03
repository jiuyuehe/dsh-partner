import type { AppliedConcernLifecycleDirective, ConcernCandidate } from './concern-domain.js'
import type { SceneProposal, ExperienceProposal, SceneView } from './memory-artifacts.js'

export type MemoryKind = 'profile' | 'preference' | 'task' | 'event' | 'relationship' | 'emotion'
export type MemoryStatus = 'active' | 'completed' | 'superseded' | 'expired'

export interface ConversationTurn {
  /** Trusted capture-time audience check, not inferred from dialogue text. */
  interactionEligible?: boolean
  identityRelation?: import('./channels/qq/identity-binding.js').QqIdentityRelation
  characterEnabled?: boolean
  userMessageIds?: string[]
  /** Transport identity for concern delivery, independent of shared memory. */
  concernScopeId?: string
  id: string
  companionId: string
  scopeId: string
  sessionId: string
  at: number
  user: string
  assistant: string
  concernDirective?: AppliedConcernLifecycleDirective
}

export interface MemoryEvidence {
  turnId: string
  at: number
  excerpt: string
}

export interface PartnerMemory {
  id: string
  companionId: string
  scopeId: string
  kind: MemoryKind
  subject: string
  content: string
  status: MemoryStatus
  confidence: number
  importance: number
  createdAt: number
  updatedAt: number
  expiresAt?: number
  locked?: boolean
  evidence: MemoryEvidence[]
}

export interface UserProfileSnapshot {
  persona?: import('./persona/types.js').PersonaView
  preferences?: PartnerMemory[]
  companionId: string
  scopeId: string
  version: string
  updatedAt?: number
  entries: PartnerMemory[]
  evidenceCount: number
  lockedCount: number
}

export interface MemoryRecallContext {
  history?: Array<Pick<ConversationTurn, 'id' | 'at' | 'user' | 'assistant'>>
  scenes?: SceneView[]
  profile: UserProfileSnapshot
  relevant: PartnerMemory[]
  connections: MemoryContextConnection[]
}

export interface DailyReflection {
  date: string
  companionId: string
  scopeId: string
  summary: string
  events: string[]
  openTasks: string[]
  completedTasks: string[]
  learnings: string[]
  updatedAt: number
  turnCount: number
}

export interface MemoryCandidate {
  targetMemoryId?: string
  evidenceQuote?: string
  sourceTurnId?: string
  sourceEvidence?: MemoryEvidence
  kind: MemoryKind
  subject: string
  content: string
  confidence: number
  importance: number
  operation: 'upsert' | 'complete' | 'remove'
  expiresInDays?: number
}

export interface ReflectionResult {
  interactionReview?: import('./character/interaction-review.js').InteractionReviewResult
  characterState?: import('./character/domain.js').CharacterState
  daily: Pick<DailyReflection, 'summary' | 'events' | 'openTasks' | 'completedTasks' | 'learnings'>
  memories: MemoryCandidate[]
  concerns: ConcernCandidate[]
}

export type MemoryRelationKind = 'supports' | 'depends_on' | 'about' | 'conflicts_with' | 'follows'
export interface MemoryRelation {
  id: string
  companionId: string
  scopeId: string
  sourceMemoryId: string
  targetMemoryId: string
  kind: MemoryRelationKind
  label: string
  confidence: number
  updatedAt: number
}

export interface MemoryContextConnection {
  relation: MemoryRelation
  source: PartnerMemory
  target: PartnerMemory
}

export interface DailyReviewTarget { companionId: string; scopeId: string; date: string; attempts: number }
export interface MemoryRelationCandidate {
  sourceSubject: string
  sourceKind?: MemoryKind
  targetSubject: string
  targetKind?: MemoryKind
  kind: MemoryRelationKind
  label: string
  confidence: number
  operation: 'upsert' | 'remove'
}
export interface MemoryRelationReviewContext extends MemoryRelation {
  sourceSubject: string
  sourceKind: MemoryKind
  targetSubject: string
  targetKind: MemoryKind
}
export interface DailyReviewResult extends ReflectionResult {
  scenes?: SceneProposal[]
  experiences?: ExperienceProposal[]
  relations: MemoryRelationCandidate[]
}
