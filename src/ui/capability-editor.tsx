import { useEffect, useRef, useState } from 'react'
import { IconCheckOutlineRegular as IconCheckOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type Capability, type CompanionView, type ModelCatalogView, type PartnerSnapshot } from '../client-api.js'
import { CAPABILITY_LABELS } from '../capabilities.js'
import { CapabilityResources } from './capability-resources.js'
import { SectionHeading as Section } from './partner-components.js'
import { RuntimeSettings } from './runtime-settings.js'
import { errorMessage as message } from './workspace-components.js'
import { companionDraft } from './companion-draft.js'

export function CapabilityEditor({ companion, presets, onChanged }: { companion: CompanionView; presets: PartnerSnapshot['presets']; onChanged(): Promise<void> }): JSX.Element {
  const [form, setForm] = useState(() => companionDraft(companion))
  const [persistedCapabilities, setPersistedCapabilities] = useState(companion.capabilities)
  const [modelCatalog, setModelCatalog] = useState<ModelCatalogView>()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string>()
  const savingRef = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (!savingRef.current) { setForm(companionDraft(companion)); setPersistedCapabilities(companion.capabilities) } }, [companion.id, companion.updatedAt])
  useEffect(() => { void api<ModelCatalogView>('/models').then(value => { if (mounted.current) setModelCatalog(value) }).catch(reason => { if (mounted.current) setError(message(reason)) }) }, [])
  const edit = (next: typeof form): void => { if (savingRef.current) return; void save(next) }
  const toggle = (capability: Capability): void => edit({ ...form, capabilities: form.capabilities.includes(capability) ? form.capabilities.filter(item => item !== capability) : [...form.capabilities, capability] })
  const save = async (next: typeof form): Promise<void> => {
    if (savingRef.current) return
    savingRef.current = true
    const previous = form
    setForm(next)
    setSaving(true); setSaved(false); setError(undefined)
    try {
      await api(`/companions/${companion.id}`, { method: 'PUT', body: JSON.stringify({ companion: next }) })
      if (!mounted.current) return
      setPersistedCapabilities(next.capabilities)
      setSaved(true)
      try { await onChanged() }
      catch { if (mounted.current) setError('能力已保存，但列表刷新失败。刷新页面即可，无需重复应用。') }
    } catch (reason) { if (mounted.current) { setForm(previous); setError(`保存失败：${message(reason)}。已恢复原选择，请重新操作。`) } }
    finally { savingRef.current = false; if (mounted.current) setSaving(false) }
  }
  const groups: Array<{ id: string; eyebrow: string; title: string; detail: string; choices: Array<{ id: Capability; title: string; detail: string }> }> = [
    { id: 'tools', eyebrow: 'TOOLS', title: '工作工具', detail: '连接当前伙伴能够使用的专业工具。', choices: [
      { id: 'knowledge', title: '知识库', detail: '在已挂载范围内检索与回写知识。' },
      { id: 'skills', title: 'Skill', detail: '使用单独启用的 Skill 与工作流程。' },
      { id: 'mcp', title: 'MCP', detail: '使用单独授权的外部 MCP 服务工具。' },
      { id: 'ssh', title: 'SSH', detail: '在 SSH 插件授权边界内操作主机。' },
      { id: 'git', title: 'Git', detail: '预留 Git 能力，需对应插件实际安装。' },
    ] },
    { id: 'coordination', eyebrow: 'COORDINATION', title: '协作与自动化', detail: '控制伙伴建立关系和自主安排工作的权限。', choices: [
      { id: 'companions', title: '创建伙伴', detail: '按明确需求创建默认无权限的新伙伴。' },
      { id: 'access', title: '伙伴授权', detail: '按明确要求配置伙伴之间的单向访问关系。' },
      { id: 'schedules', title: '定时任务', detail: '创建并管理由自己执行的周期任务。' },
    ] },
    { id: 'administration', eyebrow: 'ADMINISTRATION', title: '高权限管理', detail: '仅授予可信的管理伙伴；普通协作授权不包含修改权限。', choices: [
      { id: 'administration', title: CAPABILITY_LABELS.administration, detail: '修改其他伙伴的身份、能力与 Preset、协作、Skill 和知识库挂载。不共享会话、记忆或凭据；不能自改或转授本权限。' },
    ] },
  ]
  return <div className="dsh-partner-form is-capabilities"><Section eyebrow="COMPOSITION" title="能力组合" detail="伙伴声明意图范围；真正可调用的工具仍来自所选 Agent Preset，并继续执行各插件权限。" />
    <div className="dsh-partner-capability-save-status" role="status" aria-live="polite" aria-atomic="true">{saving ? '正在保存…' : saved ? '已保存，下一轮生效' : '修改自动保存，无需应用组合。'}{error && <p className="dsh-partner-inline-error" role="alert">{error}</p>}</div>
    <div className="dsh-partner-qq-toggle"><span><strong>统一伙伴工具入口</strong><small>仅收拢伙伴自身的工具，其他插件保持自己的入口。聊天、回忆和工作等基础能力按权限直接提供。修改在下一轮生效。</small></span><div><button type="button" role="switch" className="dsh-partner-switch" aria-label="统一伙伴工具入口" aria-checked={!!form.toolDiscovery} data-on={!!form.toolDiscovery} disabled={saving} onClick={()=>edit({...form,toolDiscovery:!form.toolDiscovery})}><i/></button><small>{form.toolDiscovery?'已开启':'已关闭'}</small></div></div>
    <RuntimeSettings value={form} catalog={modelCatalog} presets={presets} saving={saving} saved={saved} error={error} change={patch => edit({...form, ...patch})} />
    <p className="dsh-partner-inline-note">身份与能力在下一轮执行前更新；Preset 与模型作为会话默认配置，不覆盖已有会话的选择。</p>
    <CapabilityResources key={companion.id} companionId={companion.id} capabilities={persistedCapabilities} disabled={saving}>{manage => <div className="dsh-partner-capability-groups">{groups.map(group => {
      const enabled = group.choices.filter(choice => form.capabilities.includes(choice.id)).length
      return <section className="dsh-partner-capability-group" key={group.id} aria-labelledby={`partner-capability-${group.id}`}><header><span><small>{group.eyebrow}</small><strong id={`partner-capability-${group.id}`}>{group.title}</strong><p>{group.detail}</p></span><em>{enabled} / {group.choices.length} 已启用</em></header><div className="dsh-partner-capabilities">{group.choices.map(choice => {
        const active = form.capabilities.includes(choice.id)
        const control = <button type="button" disabled={saving} className={active ? 'is-active' : ''} aria-pressed={active} onClick={() => toggle(choice.id)}><span>{active && <IconCheckOutline14 size={14} />}</span><strong>{choice.title}</strong><small>{choice.detail}</small></button>
        return <div className="dsh-partner-capability-card" key={choice.id}>{control}{(choice.id === 'skills' || choice.id === 'mcp') && manage(choice.id)}</div>
      })}{group.id === 'coordination' && <div className="dsh-partner-capability-card is-access"><div className="dsh-partner-capability-card-copy"><strong>可访问伙伴</strong><small>选择能了解其能力并委派任务的伙伴。</small></div>{manage('access')}</div>}</div></section>
    })}</div>}</CapabilityResources>
  </div>
}
