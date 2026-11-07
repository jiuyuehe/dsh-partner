import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { record, requiredText } from '../core/validation.js'
import type { PartnerState } from '../domain.js'
import { questionOrigin } from '../channels/question-origin.js'
import { channelReplyAllowed } from '../channels/reply-access.js'
import { isToolAllowed, resolveToolAccess } from './tool-access-adapter.js'
import type { PartnerStore } from '../store.js'
import type { CodeExecutionRun, CodeExecutionStatus } from './code-domain.js'

const PROVIDER = 'codex'
const MAX_RUNS = 100
const MAX_TASK_LENGTH = 12_000
const MAX_OUTPUT_LENGTH = 8_000
const DEFAULT_TIMEOUT_SECONDS = 900
const TOOL_TIMEOUT_MS = 16 * 60_000
const ACTIVE = new Set<CodeExecutionStatus>(['starting', 'running'])

// 仅声明 DSH 官方 SubagentRuntime 的最小结构，保持 Codex Provider 为可选服务。
// 该结构与 DSH 0.2.1-rc.5 的 getProvider/startActivation 契约对应。
type CodeSubagentResult = {
  output: readonly { type: string; text?: string }[]
  stopReason: string
  diagnostic?: string
}
type CodeSubagentActivation = {
  childId: string
  result: Promise<CodeSubagentResult>
  dispose(): Promise<void>
}
type CodeSubagentService = {
  getProvider(name: string): unknown
  startActivation(spec: {
    provider: string
    label: string
    request: { cwd: string; prompt: { type: 'text'; text: string }[]; parent: NonNullable<ToolRunContext['agent']> }
    signal: AbortSignal
    delivery: 'caller'
  }): Promise<CodeSubagentActivation>
}

export interface CodeExecutionOptions {
  /** 测试可缩短时限；运行时始终从 DSH 父会话读取 Provider。 */
  timeoutSeconds?: number
  now?: () => number
  getSubagents?: (agentContext: unknown) => unknown
  report?: (message: string) => void
}

function safeDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const providerFailure = message.match(/Product subagent failure \(product: ([^;]+); stage: ([^;]+); category: ([^)]+)\)/i)
  if (providerFailure) return `Codex Provider failed at ${(providerFailure[2] ?? 'unknown').trim()} (category: ${(providerFailure[3] ?? 'unknown').trim()}). Check the DSH Host diagnostic for the safe provider detail.`
  return message
    .replace(/(authorization|token|api[_ -]?key|password)\s*[:=]\s*\S+/giu, '$1=[redacted]')
    .replace(/[A-Z]:\\(?:[^\\\s]+\\)*[^\\\s]*/giu, '[local path]')
    .slice(0, 800) || 'Codex Provider returned an unspecified failure.'
}

function failureStatus(error: unknown, timedOut: boolean, canceled: boolean, permissionRevoked = false): CodeExecutionStatus {
  if (timedOut) return 'timeout'
  // 父会话主动取消与授权撤销都可能触发 Abort；明确的父会话取消应保留为 canceled。
  if (canceled) return 'canceled'
  if (permissionRevoked) return 'permission_denied'
  const message = safeDiagnostic(error).toLocaleLowerCase()
  if (/auth|login|credential|unauthor|\b401\b/u.test(message)) return 'auth_failed'
  if (/permission|access-policy|approval|sandbox|revok|authorization/u.test(message)) return 'permission_denied'
  if (/stage: initialize|failed at initialize|initialize \(/u.test(message)) return 'startup_failed'
  return 'process_failed'
}

function resultText(result: CodeSubagentResult): string {
  return result.output.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n').trim()
}

function resultStatus(reason: string, output: string): CodeExecutionStatus {
  if (reason === 'completed') return output ? 'completed' : 'invalid_result'
  if (reason === 'aborted') return 'canceled'
  if (reason === 'refusal') return 'permission_denied'
  return 'process_failed'
}

function statusGuard(owner: string, store: PartnerStore, exec: ToolRunContext, toolName: string) {
  const agent = exec.agent
  if (!agent) throw new Error('Codex 委派需要当前 DSH Agent 会话')
  const state = store.snapshot()
  const companion = state.companions.find(item => item.id === owner)
  const route = state.sessions.find(item => item.companionId === owner && item.sessionId === agent.session.id)
  if (!companion || store.isCompanionRemoving(owner) || !route) throw new Error('当前伙伴会话不存在或已停止')
  const access = resolveToolAccess({ agent, state })
  if (!isToolAllowed(access, toolName)) throw new Error('当前会话没有使用此 Codex 工具的授权')
  if (route.kind === 'channel') {
    const source = questionOrigin(agent.session.id, agent.session.snapshotEvents(), state.sessions)
    if (!source || !channelReplyAllowed(state, source.channelId, source.userId)) throw new Error('原渠道或发言人授权已撤销')
  }
  exec.signal.throwIfAborted()
  return { agent, route }
}

async function sessionWorkspace(agent: NonNullable<ToolRunContext['agent']>, route: PartnerState['sessions'][number]): Promise<string> {
  // 工作目录只能取自当前 DSH Session/已持久化路由，绝不接受模型传入路径。
  // 渠道会话的路由目录由插件持久化，优先级高于模型可能改坏的 Session header。
  const source = route.kind === 'channel' ? route.cwd || agent.session.header.cwd : agent.session.header.cwd || route.cwd
  if (!source || typeof source !== 'string') throw new Error('当前 DSH 会话没有可用的工作目录')
  let workspace: string
  try { workspace = await realpath(resolve(source)) } catch { throw new Error('当前 DSH 会话工作目录不存在或不可访问') }
  try { if (!(await stat(workspace)).isDirectory()) throw new Error('not-directory') } catch { throw new Error('当前 DSH 会话工作目录不可访问') }
  return workspace
}

function subagentService(agentContext: unknown, options: CodeExecutionOptions): CodeSubagentService | undefined {
  let value: unknown
  if (options.getSubagents) value = options.getSubagents(agentContext)
  else {
    const context = agentContext as { get?: (name: string, strict?: boolean) => unknown } | undefined
    if (typeof context?.get === 'function') value = context.get.call(agentContext, 'subagents', false)
  }
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<CodeSubagentService>
  return typeof candidate.getProvider === 'function' && typeof candidate.startActivation === 'function'
    ? candidate as CodeSubagentService : undefined
}

function updateRecord(state: PartnerState, runId: string, patch: Partial<CodeExecutionRun>, now: number): void {
  const runs = state.codeExecutionRuns ?? []
  const run = runs.find(item => item.runId === runId)
  if (!run) throw new Error(`Codex Run Ledger entry not found: ${runId}`)
  Object.assign(run, patch, { updatedAt: now })
  state.codeExecutionRuns = runs
}

async function saveRun(store: PartnerStore, run: CodeExecutionRun, options: CodeExecutionOptions): Promise<void> {
  await store.update(state => {
    const runs = state.codeExecutionRuns ?? []
    const combined = [...runs, run]
    const active = combined.filter(item => ACTIVE.has(item.status))
    if (active.length > MAX_RUNS) throw new Error('Codex Run Ledger 已满，不能丢弃仍在运行的记录')
    if (combined.length > MAX_RUNS) {
      const terminalSlots = MAX_RUNS - active.length
      const terminal = terminalSlots > 0 ? combined.filter(item => !ACTIVE.has(item.status)).slice(-terminalSlots) : []
      state.codeExecutionRuns = [...terminal, ...active].sort((a, b) => a.startedAt - b.startedAt)
    } else state.codeExecutionRuns = combined
  })
  options.report?.(`Codex run ${run.runId}: ${run.status}`)
}

async function patchRun(store: PartnerStore, runId: string, patch: Partial<CodeExecutionRun>, options: CodeExecutionOptions): Promise<void> {
  await store.update(state => updateRecord(state, runId, patch, (options.now ?? Date.now)()))
  options.report?.(`Codex run ${runId}: ${patch.status ?? 'updated'}`)
}

function normalizeInput(raw: unknown, configuredTimeout = DEFAULT_TIMEOUT_SECONDS) {
  const input = record(raw)
  const task = requiredText(input.task, 'task', MAX_TASK_LENGTH)
  const rawCriteria = input.acceptanceCriteria ?? []
  if (!Array.isArray(rawCriteria) || rawCriteria.length > 12 || rawCriteria.some(item => typeof item !== 'string' || !item.trim() || item.length > 500)) {
    throw new Error('acceptanceCriteria 必须为至多 12 项、每项不超过 500 字的非空字符串')
  }
  const timeoutSeconds = input.timeoutSeconds ?? configuredTimeout
  if (typeof timeoutSeconds !== 'number' || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > DEFAULT_TIMEOUT_SECONDS) throw new Error(`timeoutSeconds 必须为 1 到 ${DEFAULT_TIMEOUT_SECONDS} 的整数`)
  return { task, acceptanceCriteria: rawCriteria as string[], timeoutSeconds }
}

function buildPrompt(task: string, criteria: readonly string[]): string {
  return [
    '你是本次由 DSH 官方 Codex Provider 启动的 Codex 子 Agent。请在提供的工作目录中真实执行任务，并把可核验结果返回给调用方。',
    '只操作当前工作目录及其子目录；先读取相关文件，再做最小必要变更。不要假称执行了命令或修改了文件。',
    '使用 Provider 当前配置的 Codex 模型；用户要求的其他 DSH 模型不代表 Codex CLI 可以切换到该模型。若任务依赖切换到不可用模型，明确说明限制，不要声称使用了该模型。',
    '若任务无法完成，明确说明失败阶段、真实错误和已发生的文件变更；不要把失败包装成成功。',
    `任务：\n${task}`,
    ...(criteria.length ? [`验收标准：\n${criteria.map((item, index) => `${index + 1}. ${item}`).join('\n')}`] : []),
    '最终回复请包含：执行摘要、实际运行的命令及结果、变更文件、仍未验证的事项。',
  ].join('\n\n')
}

function taskSummary(task: string): string { return task.replace(/\s+/gu, ' ').trim().slice(0, 800) }

function readStatusArgs(raw: unknown) {
  const input = record(raw)
  const runId = input.runId === undefined ? undefined : requiredText(input.runId, 'runId', 100)
  const limit = input.limit ?? 10
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit 必须为 1 到 50 的整数')
  return { runId, limit }
}

export function partnerCodeExecutionTools(owner: string, store: PartnerStore, options: CodeExecutionOptions = {}): ToolDefinition[] {
  const execute: ToolDefinition = {
    name: 'partner_code_execute',
    description: '用于代码任务（读取/修改仓库或文件、修复代码、编写/运行测试、构建、调试和代码审查）；用户明确要求 Codex CLI/Codex 子 Agent 完成其他任务时也使用本工具。通过 DSH 官方 Codex Provider 在当前 DSH 会话工作目录真实执行，结果回到本 Agent。Codex 缺失、认证失败或执行失败时明确失败并停止；不得改用 partner_work_execute、临时 DSH Agent 或自己伪称已委派。参数不接受工作目录，工作区始终由插件从当前 Session 确定；使用 Provider 当前配置的 Codex 模型，不得声称切换到了其他 DSH 模型。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        task: { type: 'string', minLength: 1, maxLength: MAX_TASK_LENGTH },
        acceptanceCriteria: { type: 'array', maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 500 } },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: DEFAULT_TIMEOUT_SECONDS },
      },
      required: ['task'],
    },
    timeoutMs: TOOL_TIMEOUT_MS,
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    presentCall: () => ({ card: 'generic', title: 'Codex 任务 · 结果回到原会话' }),
    async execute(raw, exec) {
      const { task, acceptanceCriteria, timeoutSeconds } = normalizeInput(raw, options.timeoutSeconds)
      const { agent, route } = statusGuard(owner, store, exec, 'partner_code_execute')
      const workspace = await sessionWorkspace(agent, route)
      const now = options.now ?? Date.now
      const runId = randomUUID()
      const run: CodeExecutionRun = {
        runId, provider: 'codex', companionId: owner, parentSessionId: agent.session.id,
        workspace, task: taskSummary(task), status: 'starting', startedAt: now(), updatedAt: now(),
      }
      await saveRun(store, run, options)

      const subagents = subagentService(agent.ctx, options)
      if (!subagents) {
        await patchRun(store, runId, { status: 'provider_missing', diagnostic: 'DSH subagents 服务不存在或未注入；没有执行或回退到其他 Agent。', finishedAt: now() }, options)
        throw new Error(`Codex Provider unavailable: DSH subagents service is missing. runId=${runId}; no DSH Agent fallback was used.`)
      }
      let provider: unknown
      try { provider = subagents.getProvider(PROVIDER) } catch (error) {
        const diagnostic = safeDiagnostic(error)
        await patchRun(store, runId, { status: 'provider_missing', diagnostic, finishedAt: now() }, options)
        throw new Error(`Codex Provider lookup failed. runId=${runId}; ${diagnostic}`)
      }
      if (!provider) {
        const diagnostic = 'DSH subagents.getProvider("codex") returned no provider; no execution or fallback occurred.'
        await patchRun(store, runId, { status: 'provider_missing', diagnostic, finishedAt: now() }, options)
        throw new Error(`Codex Provider unavailable. runId=${runId}; no DSH Agent fallback was used.`)
      }

      const timeoutController = new AbortController()
      const combinedSignal = AbortSignal.any([exec.signal, timeoutController.signal])
      let timedOut = false
      let permissionRevoked = false
      let activation: CodeSubagentActivation | undefined
      let status: CodeExecutionStatus = 'process_failed'
      let output = ''
      let diagnostic: string | undefined
      let stopReason: string | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let parentAbortHandler: (() => void) | undefined
      let combinedAbortHandler: (() => void) | undefined
      const timeoutFailure = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          timeoutController.abort(new Error('Codex task timed out'))
          reject(new Error(`Codex task exceeded ${timeoutSeconds} seconds`))
        }, timeoutSeconds * 1000)
      })
      const parentCanceled = new Promise<never>((_resolve, reject) => {
        parentAbortHandler = () => reject(exec.signal.reason instanceof Error ? exec.signal.reason : new Error('DSH request canceled'))
        if (exec.signal.aborted) parentAbortHandler()
        else exec.signal.addEventListener('abort', parentAbortHandler, { once: true })
      })
      const combinedCanceled = new Promise<never>((_resolve, reject) => {
        combinedAbortHandler = () => reject(combinedSignal.reason instanceof Error ? combinedSignal.reason : new Error('Codex activation canceled'))
        if (combinedSignal.aborted) combinedAbortHandler()
        else combinedSignal.addEventListener('abort', combinedAbortHandler, { once: true })
      })
      let unsubscribe: (() => void) | undefined
      try {
        // 长任务期间实时复核伙伴、会话和渠道权限，撤权后取消对应 Codex Activation。
        unsubscribe = store.subscribe(() => {
          try { statusGuard(owner, store, exec, 'partner_code_execute') } catch (error) {
            permissionRevoked = true
            timeoutController.abort(error)
          }
        }, () => {})
        const starting = subagents.startActivation({
          provider: PROVIDER,
          label: `Code: ${taskSummary(task).slice(0, 120)}`,
          request: { cwd: workspace, prompt: [{ type: 'text', text: buildPrompt(task, acceptanceCriteria) }], parent: agent },
          signal: combinedSignal,
          delivery: 'caller',
        })
        try {
          activation = await Promise.race([starting, timeoutFailure, parentCanceled, combinedCanceled])
        } catch (error) {
          // Provider 启动若在超时/取消后迟到兑现，也必须释放它刚发布的句柄。
          void starting.then(late => late.dispose()).catch(() => {})
          throw error
        }
        await patchRun(store, runId, { status: 'running', subagentId: activation.childId }, options)
        const result = await Promise.race([activation.result, timeoutFailure, parentCanceled, combinedCanceled])
        stopReason = result.stopReason
        output = resultText(result)
        status = resultStatus(result.stopReason, output)
        if (result.diagnostic) diagnostic = safeDiagnostic(new Error(result.diagnostic))
        if (status !== 'completed' && !diagnostic) diagnostic = `Codex subagent stopped with stopReason=${result.stopReason}.`
      } catch (error) {
        status = failureStatus(error, timedOut, exec.signal.aborted, permissionRevoked)
        diagnostic = safeDiagnostic(error)
      } finally {
        if (timer) clearTimeout(timer)
        if (parentAbortHandler) exec.signal.removeEventListener('abort', parentAbortHandler)
        if (combinedAbortHandler) combinedSignal.removeEventListener('abort', combinedAbortHandler)
        unsubscribe?.()
        if (activation) {
          try { await activation.dispose() } catch (error) {
            status = 'cleanup_failed'
            diagnostic = `Codex result/cleanup could not be confirmed. ${safeDiagnostic(error)}`
          }
        }
        const finishedAt = now()
        await patchRun(store, runId, {
          status, ...(activation ? { subagentId: activation.childId } : {}),
          ...(stopReason ? { stopReason } : {}), ...(diagnostic ? { diagnostic } : {}),
          ...(output ? { outputPreview: output.slice(0, MAX_OUTPUT_LENGTH) } : {}), finishedAt,
        }, options)
      }

      if (status !== 'completed') throw new Error(`Codex execution ${status}; runId=${runId}; ${diagnostic ?? `stopReason=${stopReason ?? 'unknown'}`}`)
      return { runId, subagentId: activation!.childId, provider: PROVIDER, status, stopReason, workspace, result: output }
    },
  }

  const statusTool: ToolDefinition = {
    name: 'partner_code_status',
    description: '读取当前伙伴、当前 DSH 会话自己的 Codex Run Ledger。可确认 runId/subagentId、最终 stopReason、失败诊断和结果摘要；不启动或恢复任务。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { runId: { type: 'string', minLength: 1, maxLength: 100 }, limit: { type: 'integer', minimum: 1, maximum: 50 } },
    },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    presentCall: () => ({ card: 'generic', title: 'Codex 运行记录' }),
    async execute(raw, exec) {
      const { runId, limit } = readStatusArgs(raw)
      const { agent } = statusGuard(owner, store, exec, 'partner_code_status')
      const matches = (store.snapshot().codeExecutionRuns ?? []).filter(run => run.companionId === owner && run.parentSessionId === agent.session.id && (!runId || run.runId === runId))
      return { runs: matches.slice(-limit).map(run => ({
        runId: run.runId, ...(run.subagentId ? { subagentId: run.subagentId } : {}), provider: run.provider,
        status: run.status, startedAt: run.startedAt, updatedAt: run.updatedAt,
        ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
        ...(run.stopReason ? { stopReason: run.stopReason } : {}), ...(run.diagnostic ? { diagnostic: run.diagnostic } : {}),
        ...(run.outputPreview ? { outputPreview: run.outputPreview } : {}),
      })) }
    },
  }
  return [execute, statusTool]
}

/** DSH 重启后，上一进程仍标记运行中的 Codex 任务必须显式变成 interrupted。 */
export async function reconcileInterruptedCodeExecutions(store: PartnerStore, now = Date.now()): Promise<number> {
  const count = (store.snapshot().codeExecutionRuns ?? []).filter(run => ACTIVE.has(run.status)).length
  if (!count) return 0
  await store.update(state => {
    for (const run of state.codeExecutionRuns ?? []) {
      if (!ACTIVE.has(run.status)) continue
      run.status = 'interrupted'
      run.updatedAt = now
      run.finishedAt = now
      run.diagnostic = 'DSH restarted before Codex execution reached a confirmed terminal result; automatic re-execution was not attempted.'
    }
  })
  return count
}
