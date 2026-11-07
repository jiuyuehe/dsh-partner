/** Codex 子 Agent 的运行状态；只记录插件可核验的生命周期结果。 */
export type CodeExecutionStatus =
  | 'starting'
  | 'running'
  | 'completed'
  | 'provider_missing'
  | 'auth_failed'
  | 'startup_failed'
  | 'process_failed'
  | 'timeout'
  | 'canceled'
  | 'permission_denied'
  | 'invalid_result'
  | 'cleanup_failed'
  | 'interrupted'

/** 可持久化的 Codex 委派账本，不保存认证材料或完整提示词。 */
export interface CodeExecutionRun {
  runId: string
  provider: 'codex'
  subagentId?: string
  companionId: string
  parentSessionId: string
  workspace: string
  task: string
  status: CodeExecutionStatus
  startedAt: number
  updatedAt: number
  finishedAt?: number
  stopReason?: string
  diagnostic?: string
  outputPreview?: string
}
