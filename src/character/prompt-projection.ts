import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PromptAssembly } from '@deepseek-ai/dsh-system-prompt'

// Only host sections whose ownership was checked against rc.2/rc.5. Unknown
// sections, security policies, runtime contexts and tool schemas remain intact.
const TOOL_SECTIONS: Record<string, readonly string[]> = {
  'tool:read': ['read'], 'tool:write': ['write'], 'tool:edit': ['edit'],
  'tool:glob': ['glob'], 'tool:grep': ['grep'], 'tool:bash': ['bash'],
  'tool:jobs': ['job_output', 'job_kill'],
  'tool:goal': ['create_goal', 'get_goal', 'update_goal'],
  'tool:workflow': ['workflow'], 'tool:subagent': ['subagent', 'subagent_fork'],
  'tool:subagent_fork': ['subagent', 'subagent_fork'],
}
const protocols = new WeakMap<Agent, Map<string, string[]>>()

/** Request-only projection. Never changes persisted history or registrations. */
export function projectConversationPrompt(assembly: PromptAssembly, agent: Agent,
  options: { roleEnabled: boolean; discovery: boolean; exclusive?: boolean }): PromptAssembly {
  const moved = new Map<string, string[]>()
  const visible = new Set(assembly.tools.map(tool => tool.name))
  const sections = assembly.sections.flatMap(section => {
    // 伙伴会话始终使用伙伴身份；只移除 DSH 的精确默认身份句，不动用户改写过的预设。
    if (section.name==='harness:identity' && section.text.trim()==='You are an AI agent powered by DeepSeek Harness.')return []
    if (section.name === 'deployment:persona-prefix'
      && /^You are a coding agent powered by the [^\r\n]+ model\.$/.test(section.text.trim())) {
      // 默认模型身份会与伙伴长期行为准则冲突；仅匹配原样默认句，保留用户自定义内容。
      return []
    }
    if (options.roleEnabled && section.name === 'ui:deliverable-file-references') {
      // Partner's attachment protocol owns delivery on its chat surfaces.
      // Web-local paths are not a channel receipt (notably QQ image/voice).
      return []
    }
    const names = options.discovery ? TOOL_SECTIONS[section.name] : undefined
    if (!names || names.some(name => visible.has(name))) return [section]
    for (const name of names) moved.set(name, [...(moved.get(name) ?? []), section.text])
    return []
  })
  if(options.roleEnabled){
    const identity=sections.findIndex(section=>section.name==='partner-identity')
    if(identity>0)sections.unshift(...sections.splice(identity,1))
  }
  protocols.set(agent, moved)
  // 渠道路由是系统投递约束；独占人格不能移除这条防止等待本地输入的规则。
  return { ...assembly, sections: options.roleEnabled&&options.exclusive ? sections.filter(section=>section.name==='partner-identity'||section.name==='partner-channel-routing') : sections }
}

/** Only exposed after discovery has checked the tool's live access. */
export function discoveredToolProtocol(agent: Agent | undefined, name: string): string | undefined {
  const parts = agent ? protocols.get(agent)?.get(name) : undefined
  return parts?.filter(Boolean).join('\n\n') || undefined
}
