export type PersonaTopic = 'background' | 'interests' | 'collaboration' | 'changes' | 'expression'
export interface PersonaSource {
  id: string
  kind: 'memory' | 'turn'
  text: string
  at: number
  /** Only verified owner/default conversation turns can teach shared expression. */
  expressionEligible?: boolean
  signature: string
  turnIds: string[]
}
export interface PersonaParagraph {
  id: string
  topic: PersonaTopic
  basis: 'explicit' | 'observed'
  text: string
  evidence: PersonaSource[]
}
export interface PersonaView {
  status: 'waiting' | 'pending' | 'processing' | 'ready' | 'retrying'
  paragraphs: PersonaParagraph[]
  version: string
  updatedAt?: number
  nextAt?: number
  error?: string
  stale: boolean
}
export interface PersonaCorrection { id: string; text: string; correction: string; at: number }
export interface PersonaJob {
  companionId: string
  scopeId: string
  token: string
  sourceHash: string
  sources: PersonaSource[]
  previous: PersonaParagraph[]
  corrections: PersonaCorrection[]
}
