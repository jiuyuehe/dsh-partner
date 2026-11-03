import type {Context} from '@deepseek-ai/cordis'
import type {AgentDefaultModelConfig} from '@deepseek-ai/dsh-agent-default-model'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import type {Companion} from '../domain.js'
import type {PartnerMemoryStore} from '../memory-store.js'
import {memoryFinishError} from '../memory-errors.js'
import {PERSONA_SYSTEM, EXPRESSION_LEARNING_GUIDANCE, parsePersona} from './domain.js'

type PersonaContext = Context & {llm: Context['llm']; agentDefaultModel: AgentDefaultModelConfig}

/** Runs inside the existing sequential memory worker, never on the reply path. */
export class PersonaService {
  private closed = false
  private readonly controllers = new Set<AbortController>()
  constructor(private readonly ctx: PersonaContext, private readonly store: PartnerMemoryStore) {}
  close(): void {
    this.closed = true
    for (const controller of this.controllers) controller.abort()
  }
  async process(companion: Companion, scopeId: string): Promise<void> {
    if (this.closed || !companion.automation.memory.enabled) return
    const job = await this.store.claimPersona(companion.id, scopeId)
    if (!job) return
    const controller = new AbortController()
    this.controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), 90_000)
    try {
      if (this.closed) throw new Error('服务停止，画像任务保留')
      const selection = {
        ...this.ctx.agentDefaultModel.currentSelection(),
        ...(companion.provider ? {provider: companion.provider} : {}),
        ...(companion.model ? {model: companion.model} : {}),
        ...(companion.automation.memory.provider ? {provider: companion.automation.memory.provider} : {}),
        ...(companion.automation.memory.model ? {model: companion.automation.memory.model} : {}),
      }
      let output = ''
      for await (const chunk of this.ctx.llm.stream({
        ...selection, system: PERSONA_SYSTEM + '\n' + EXPRESSION_LEARNING_GUIDANCE, temperature: 0.1, maxTokens: 3500, signal: controller.signal,
        messages: [createUserMessage({content: [{type: 'text', text: JSON.stringify({
          sources: job.sources, previous: job.previous.map(({topic,basis,text}) => ({topic,basis,text})),
          corrections: job.corrections,
        })}], source: {kind: 'plugin:@lemoncat7/dsh-partner', plugin: '@lemoncat7/dsh-partner', form: 'notice', summary: '伙伴综合画像'}})],
      })) {
        if (chunk.type === 'text-delta') output += chunk.text
        if (output.length > 24_000) throw new Error('画像输出超出限制')
        if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') throw new Error(memoryFinishError(chunk.reason))
      }
      if (controller.signal.aborted) throw new Error('画像生成中断，将自动重试')
      const paragraphs = parsePersona(output, job.sources)
      if (!paragraphs.length && job.previous.length) throw new Error('未生成可替换的画像，保留现有理解并稍后重试')
      await this.store.finishPersona(job, paragraphs)
    } catch (error) {
      await this.store.failPersona(job, error instanceof Error ? error.message : String(error))
    } finally {
      clearTimeout(timeout)
      this.controllers.delete(controller)
    }
  }
}
