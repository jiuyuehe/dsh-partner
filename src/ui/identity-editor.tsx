import { patchIdentity } from '../companions/identity.js'
import { PersonaTemplate } from './persona-template.js'
import { relationshipTextForIdentity } from '../character/relationship-adapter.js'
import { SleepEditor } from './sleep-editor.js'
import { sleepPolicy } from '../character/sleep.js'
import { IdleContactEditor } from './idle-contact-editor.js'
import { SettingsSections } from './settings-sections.js'
import { CharacterEditor } from './character-editor.js'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { IconCheckOutlineRegular as IconCheckOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { api, type CompanionView } from '../client-api.js'
import { pageIdentity } from '../companions/identity.js'
import { FormField as Field, SectionHeading as Section } from './partner-components.js'
import { errorMessage } from './workspace-components.js'

interface Props {
  companion: CompanionView
  onChanged(): Promise<void>
}

/** Identity-scoped lifetime prevents confirmations and late results crossing targets. */
export function IdentityEditor(props: Props): JSX.Element { return <IdentityEditorForm key={props.companion.id} {...props} /> }

function IdentityEditorForm({ companion, onChanged }: Props): JSX.Element {
  const [form, setForm] = useState(() => pageIdentity(companion))
  const revision = useRef(companion.updatedAt)
  const [operation, setOperation] = useState<'save'>()
  const [section, setSection] = useState<'identity' | 'character' | 'relationship' | 'idle' | 'sleep'>('identity')
  const dirty = useRef(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string>()
  const locked = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { if (!dirty.current) { setForm(pageIdentity(companion)); revision.current = companion.updatedAt } }, [companion.updatedAt])
  const busy = operation !== undefined
  const edit = (value: typeof form) => { setForm(value); dirty.current = true; setSaved(false) }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (locked.current) return
    locked.current = true; setOperation('save'); setError(undefined)
    let committed = false
    try {
      await api(`/companions/${encodeURIComponent(companion.id)}/identity`, { method: 'PUT', body: JSON.stringify({ expectedAt: revision.current, identity: { ...form, characterCard: form.characterCard ?? null, idleContact: form.idleContact ?? null, sleepPolicy: form.sleepPolicy ?? null } }) })
      committed = true
      dirty.current = false
      await onChanged()
      if (alive.current) setSaved(true)
    } catch (reason) {
      if (alive.current) setError(`${committed ? '身份已保存，但刷新失败，无需重复保存：' : '保存失败：'}${errorMessage(reason)}`)
    } finally { locked.current = false; if (alive.current) setOperation(undefined) }
  }
  return <form onInvalidCapture={event => { event.preventDefault(); const target = event.target as HTMLElement; const idle = Boolean(target.closest('[aria-label="闲时自主活动"]')); setSection(idle ? 'idle' : 'identity'); setError(idle ? '请选择自主活动的目标会话。' : '请填写基本身份中的名字和角色。'); requestAnimationFrame(() => target.focus()) }} id="dsh-partner-identity-editor" className="dsh-partner-form is-identity" aria-busy={operation !== undefined} onSubmit={event => { void submit(event) }}>
    <Section eyebrow="IDENTITY" title="身份与角色" detail="页面与 AI 使用同一份设定。推荐在聊天中提出要求，让 AI 生成角色与关系；这里查看最新内容，也可直接修改保存。" />
    {dirty.current && companion.updatedAt !== revision.current && <p role="status" className="dsh-partner-character-hint">设定已被 AI 或其他页面更新。你的未保存编辑仍在，保存会进行版本校验；请先载入最新设定再修改，避免覆盖新内容。</p>}
    <section className="dsh-partner-identity-card" aria-label="身份配置">
    <SettingsSections<typeof section> label="身份设置分段" value={section} onChange={setSection} sections={[{id: 'identity', title: '基本身份', detail: '名字、定位与行为准则', content: <>
    <PersonaTemplate section="basic" />
    <div className="dsh-partner-fields two"><Field label="名字"><input disabled={busy} required maxLength={60} value={form.name} onChange={event => edit({ ...form, name: event.target.value })} /></Field><Field label="角色"><input disabled={busy} required maxLength={120} value={form.role} onChange={event => edit({ ...form, role: event.target.value })} /></Field></div>
    <Field label="一句话定位" hint="用于名册识别，不会替代完整行为准则。"><textarea disabled={busy} rows={2} maxLength={500} value={form.description} onChange={event => edit({ ...form, description: event.target.value })} /></Field>
    <Field label="长期行为准则" hint="写角色通用的职责、表达与边界。与用户的身份关系、专属称呼请放到“关系设定”。"><textarea disabled={busy} rows={9} maxLength={12000} value={form.instructions} onChange={event => edit({ ...form, instructions: event.target.value })} /></Field>
    </>}, {id: 'character', title: '角色聊天', detail: form.characterCard?.enabled ? '已启用 · 设定与试聊' : '可选 · 设定与试聊', content: <CharacterEditor active={section === 'character'} relationshipText={relationshipTextForIdentity(form)} companion={companion} {...(form.characterCard ? {card:form.characterCard} : {})} disabled={busy} onChange={characterCard => edit({...form,characterCard})} />}, {id: 'relationship', title: '关系设定', detail: '称呼与相处 · 按渠道应用', content: <>
      <p className="dsh-partner-character-hint">角色设定写“我是谁”，这里写“我们是什么关系”。普通会话会合并使用；QQ 仅在发送者匹配任一归属账号时附加这份关系，群聊与私聊通用。其他人根据角色性格与实际交往相处。</p>
      <PersonaTemplate section="relationship" />
      <Field label="关系设定" hint="写关系身份、专属称呼和相处习惯，也可附关系示例。留空表示不预设关系。"><textarea disabled={busy} rows={12} maxLength={12000} value={relationshipTextForIdentity(form)} onChange={event => edit({...form, relationshipText:event.target.value})} /></Field>
      <details className="dsh-partner-settings-advanced"><summary>通用示例与编辑说明</summary><p>我们是互相尊重的老朋友，称呼对方的名字。熟悉时可以开玩笑，认真讨论时直说意见，不编造共同往事。</p><p>可以让 AI 分别生成角色与关系。AI 与页面编辑同一份生效内容；保存后下一轮使用新设定。旧版角色或基本身份中混写的专属关系，需要移到这里；系统不会猜测删改旧文本。QQ 账号只需在渠道的访问权限中填写。</p></details>
    </>}, {id: 'idle', title: '闲时自主活动', detail: form.idleContact?.enabled ? '已开启 · 按概率自主行动' : '可选 · 聊天或使用能力', content: <><IdleContactEditor companionId={companion.id} value={form.idleContact} disabled={busy} onChange={idleContact => edit({...form,idleContact})} /><details className="dsh-partner-settings-advanced"><summary>自主调整记录（{companion.personaHistory?.length??0} / 12）</summary>{!companion.personaHistory?.length&&<p>还没有自主调整记录。</p>}{[...(companion.personaHistory??[])].reverse().map(entry=><article key={entry.at}><p>{new Date(entry.at).toLocaleString()} · {entry.reason}</p><details><summary>查看修改前后</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({修改前:entry.before,修改后:entry.after},null,2)}</pre></details><button type="button" disabled={busy} onClick={()=>{try{edit(patchIdentity(form,entry.before));setError(undefined)}catch(e){setError(errorMessage(e))}}}>载入此次修改前的内容</button></article>)}</details></>}, {id: 'sleep', title: '睡眠与做梦', detail: '自主休息 · 梦境与感受', content: <SleepEditor companion={companion} value={sleepPolicy(form)} disabled={busy} active={section === 'sleep'} onChange={sleepPolicy => edit({...form,sleepPolicy})} />}]} />
    {error && <p className="dsh-partner-inline-error" role="alert">{error}</p>}
    <div className="dsh-partner-form-actions"><button type="button" disabled={busy} onClick={() => { setForm(pageIdentity(companion)); revision.current = companion.updatedAt; dirty.current = false; setError(undefined); setSaved(false) }}>载入最新设定</button><span role="status">{saved && <><IconCheckOutline14 size={14} />身份已保存，下一轮将使用新身份</>}</span><button disabled={busy}>{operation === 'save' ? '正在保存…' : '保存身份'}</button></div>
    </section>
  </form>
}
