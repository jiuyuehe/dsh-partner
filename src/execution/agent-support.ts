import { renderIdentityRelationship } from '../character/relationship-adapter.js'
import { renderCharacterCore, renderExclusiveIdentity } from '../character/domain.js'
import { renderConversationBehavior } from '../character/conversation-behavior.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentDefaultModelConfig } from '@deepseek-ai/dsh-agent-default-model'
import type { Companion } from '../domain.js'
import { ATTACHMENT_PROTOCOL } from '../attachments/tool.js'

export function renderPartnerPersona(companion: Companion, surface: 'conversation' | 'local' | 'heartbeat' | 'ephemeral' = 'conversation', includeRelationship = true): string {
  if(companion.characterCard?.enabled&&companion.characterCard.exclusivePrompt&&(surface==='conversation'||surface==='local'))return [renderExclusiveIdentity({...companion,characterCard:companion.characterCard}),includeRelationship?renderIdentityRelationship(companion):''].filter(Boolean).join('\n\n')
  const capabilities = companion.capabilities.length > 0 ? companion.capabilities.join('、') : '由当前 Agent Preset 提供的基础能力'
  return [
    companion.characterCard?.enabled && (surface === 'conversation' || surface === 'local')
      ? `你是长期伙伴「${companion.name}」。以当前角色设定与用户交流；用户提出工作任务时，使用已授权能力认真处理。`
      : `你当前以长期工作伙伴「${companion.name}」的身份工作。`,
    `角色：${companion.role}`,
    companion.description ? `定位：${companion.description}` : '',
    companion.instructions ? `长期行为准则：\n${companion.instructions}` : '',
    renderCharacterCore(companion.characterCard, surface),
    includeRelationship ? renderIdentityRelationship(companion) : '',
    companion.characterCard?.enabled && (surface === 'conversation' || surface === 'local') ? renderConversationBehavior(companion.characterCard) : '',
    `用户为此伙伴启用的能力范围：${capabilities}。能力标识不等于授权；只能调用当前会话实际提供且已经通过权限校验的工具。`,
    surface === 'heartbeat'
      ? '这是一轮独立的伙伴心跳，不是用户聊天的延续。只根据本轮真实可读信息行动，最终结果由渠道适配器决定是否发送。'
      : surface === 'ephemeral'
        ? '这是一个有明确边界的临时工作会话。只处理本轮任务，使用真实工具结果，完成后给出可审计的结果摘要；不得读取或推断其他伙伴的私有会话、凭据与长期记忆。'
        : surface === 'local'
          ? '这是用户在 DSH 中与你直接建立的本地伙伴会话，不依赖任何外部渠道。保持连续上下文并正常使用已授权能力；不要假定消息来自微信。'
          : '这个会话通过 DSH 网页或当前绑定的渠道与用户交流。保持同一上下文，不要假定每条消息都来自某个固定渠道；渠道回传由适配器负责。回答兼顾网页与移动端阅读，执行外部操作前继续遵守工具自身的授权与审批边界。',
  ].filter(Boolean).join('\n\n')
}

export function renderToolProtocol(): string {
  return [
    'DSH 工具调用协议（必须遵守）：工具 SDK 中出现某项能力，不代表它可以作为顶层函数直接调用。',
    '先以当前请求真正暴露的顶层工具清单为准。若顶层只提供 `run_code`，则它是唯一允许直接调用的工具；`web_search`、知识库、SSH 等 SDK 能力必须放进 `run_code` 程序，通过生成的 `tools` SDK 按准确签名调用，例如 `await tools.web_search(...)`。绝不要直接发起名为 `web_search` 的顶层工具调用。',
    '`run_code` 的程序只返回完成当前任务所需的精简结果。需要顺序依赖时逐个 `await`，互不依赖的只读调用才可并行。',
    '若工具结果提示 “only `run_code` is callable directly”，立即在同一轮改用 `run_code` 重试。只有规范重试也失败时，才说明真正的失败原因。',
    '若当前请求原生暴露了目标工具，则可以直接调用；不要臆造未出现在顶层清单或生成 SDK 中的工具。',
    '知识库与 SSH/FTP/SFTP 优先使用当前提供的统一入口 knowledge、ssh：action=list 查询操作，action=describe 且 tool=操作名读取参数，再以 action=call、tool=操作名、arguments={...} 执行。旧指令中的 knowledge_*、ssh_* 和 SSH 文件传输 file_* 是入口内的操作名，不是另行暴露的顶层工具；只有旧版确实提供同名工具时才直接调用。',
    '若通过 partner_tools 调用这些入口，name 必须是 knowledge 或 ssh，argumentsJson 是该入口完整参数的 JSON 字符串；不要把 ssh_exec 或 knowledge_read 当作 partner_tools 的 name。若使用 run_code，则调用 tools.knowledge(...) 或 tools.ssh(...)，不能猜测旧操作对应的 SDK 函数。',
    'Skill 的 allowed-tools 若只列出旧操作名，统一入口也只能 describe/call 这些操作。list 返回目录不等于获得目录中其他操作的权限；主机挂载、临时授权、文件权限、知识库范围与笔记确认仍由原插件校验。',
    ATTACHMENT_PROTOCOL,
  ].join('\n')
}

export function assistantTextAfter(agent: Agent, fromSeq: number): string {
  const messages: string[] = []
  let answer = ''
  const flush = (): void => { if (answer) messages.push(answer); answer = '' }
  for (const event of agent.session.snapshotEvents()) {
    if (event.seq <= fromSeq) continue
    if (event.type === 'turn/start') { flush(); continue }
    if (event.type === 'turn/end') {
      if (event.data.reason.kind !== 'completed') answer = ''
      flush(); continue
    }
    if (event.type === 'tool/result') { answer = ''; continue }
    if (event.type !== 'assistant/message' || event.data.interrupted) continue
    if (event.data.message.content.some(block => block.type === 'tool-call')) { answer = ''; continue }
    const text = event.data.message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map(block => block.text.trim()).filter(Boolean).join('\n')
    if (text) answer = text
  }
  flush()
  return messages.join('\n\n').trim()
}

export function resolvePartnerAgentOptions(defaultModel: AgentDefaultModelConfig, companion: Companion) {
  return {
    ...defaultModel.currentSelection(),
    ...(companion.provider ? { provider: companion.provider } : {}),
    ...(companion.model ? { model: companion.model } : {}),
  }
}
