import { AffectionPanel } from './affection-panel.js'
import { renderIdentityRelationship } from '../character/relationship-adapter.js'
import { PERSONA_REQUEST_EXAMPLE } from '../character/identity-guide.js'
import { StickerLibraryDialog } from './sticker-library.js'
import { RoleReference } from './role-reference.js'
import { SettingsSections } from './settings-sections.js'
import { useState, type ReactNode } from 'react'
import { api, type CompanionView } from '../client-api.js'
import { emptyCharacterCard, normalizeCharacterCard, renderCharacterCore, roleTextForCard, type CharacterCard } from '../character/domain.js'
import { renderConversationBehavior, renderConversationTurn } from '../character/conversation-behavior.js'
import { FormField as Field } from './partner-components.js'
import { WorkspaceDialog, DiscardChangesDialog, errorMessage } from './workspace-components.js'
import Stepper, { Step } from './character-stepper.js'

const SAMPLE: CharacterCard = {
  ...emptyCharacterCard(), enabled: true,
  roleText: `## 你是谁
一位喜欢观察日常、说话坦率的同行者。对新事物好奇，也愿意承认不知道。

## 性格与反应
有自己的偏好，不为了讨好而附和；轻松时开点玩笑，正事认真处理。

## 怎么说话
自然简洁，不机械称呼，不重复口头禅。闲聊先给直接反应，不急着提建议；需要解释时认真展开。

## 对话参考（不是固定台词）
对方：你是不是觉得我的想法都对？
回应：倒也没有，刚才那个我就不赞成。
避免：你的每个想法都很棒！需要我帮你完善吗？

对方：外面又下雨了。
回应：刚好，今天有理由不出门了。
避免：下雨天记得带伞哦！你可以在家看书、听音乐或者看电影。`,
}

export function CharacterEditor({ companion, card, disabled, onChange, relationshipText, active = false }: { active?: boolean; relationshipText: string; companion: CompanionView; card?: CharacterCard; disabled: boolean; onChange(card: CharacterCard): void }): JSX.Element {
  const [wizard, setWizard] = useState(false)
  const [section, setSection] = useState<'role' | 'chat' | 'trial'>('role')
  // An explicitly empty document remains editable rather than reopening the wizard.
  const hasContent = Boolean(card && (card.roleText !== undefined || roleTextForCard(card) || card.lore.length))
  return <section className="dsh-partner-character" aria-label="角色聊天">
    <header><div><span className="dsh-partner-character-kicker">ROLE & CONVERSATION</span><h3>角色聊天 <small>可选</small></h3><p>告诉伙伴你想要的身份、关系、性格和语气，让 AI 按角色格式生成并应用设定。工具能力遵守渠道与账号权限。</p></div>
      <div className="dsh-partner-character-toggle"><button type="button" role="switch" aria-label="启用角色聊天" aria-checked={card?.enabled === true} className="dsh-partner-switch" data-on={card?.enabled === true} disabled={disabled} onClick={() => { if (!hasContent) setWizard(true); else onChange({ ...card!, enabled: !card!.enabled }) }}><i aria-hidden="true" /></button><span aria-hidden="true">{card?.enabled === true ? '已开启' : '已关闭'}</span></div>
    </header>
    <details className="dsh-partner-settings-advanced"><summary>怎么让 AI 帮我生成人格？</summary><p className="dsh-partner-character-hint">在与这个伙伴的正式聊天中提出要求即可。AI 会读取当前设定，将角色自身的身份、性格、语气与通用示例写入角色设定，将与用户的关系、专属称呼与相处方式单独写入关系设定。AI 保存后会更新下方同一份设定；页面正在编辑时会保留未保存内容，并提示先载入最新版本。</p><Field label="通用需求示例" hint="复制到与伙伴的聊天中，将括号里的内容换成你的要求。"><textarea readOnly rows={5} value={PERSONA_REQUEST_EXAMPLE} onFocus={event=>event.currentTarget.select()} /></Field></details>
    {!hasContent ? <div className="dsh-partner-character-empty"><strong>把你想要的角色告诉 AI</strong><p>推荐先在正式聊天中提出要求，由 AI 生成并应用；也可以在这里手动填写内容。关闭角色聊天后继续使用基本身份。</p><button type="button" disabled={disabled} onClick={() => setWizard(true)}>手动编写设定</button></div> : <>
      <p className="dsh-partner-character-status">{card!.enabled ? '已启用 · 保存后下一轮应用新设定，旧对话不会决定新的语气。' : '已关闭 · 内容保留，伙伴继续使用基本身份。'}</p>
      <AffectionPanel companion={companion} card={card!} active={active} disabled={disabled} onChange={onChange} />
      <SettingsSections<typeof section> label="角色聊天分段" value={section} onChange={setSection} sections={[
        {id: 'role', title: '角色设定', content: <fieldset disabled={disabled} className="dsh-partner-character-fields"><RoleFields card={card!} onChange={onChange} /><details className="dsh-partner-settings-advanced"><summary>背景资料 <small>可选 · {card!.lore.length} 条</small></summary><LoreFields card={card!} onChange={onChange} /></details></fieldset>},
        {id: 'chat', title: '聊天方式', content: <fieldset disabled={disabled} className="dsh-partner-character-fields"><ChatFields companionId={companion.id} card={card!} onChange={onChange} /></fieldset>},
        {id: 'trial', title: '试聊', content: <CharacterTrial companion={companion} relationshipText={relationshipText} card={card!} />},
      ]} />
    </>}
    {wizard && <CharacterWizard relationshipText={relationshipText} companion={companion} initial={card ?? emptyCharacterCard()} close={() => setWizard(false)} complete={value => { onChange(value); setWizard(false) }} />}
  </section>
}

function CharacterWizard({ companion, initial, close, complete, relationshipText }: { relationshipText: string; companion: CompanionView; initial: CharacterCard; close(): void; complete(card: CharacterCard): void }): JSX.Element {
  const [draft, setDraft] = useState(() => ({ ...structuredClone(initial), enabled: true }))
  const [step, setStep] = useState(1)
  const [error, setError] = useState<string>()
  const [discard, setDiscard] = useState(false)
  const next = () => {
    setError(undefined)
    try { const value = normalizeCharacterCard(draft); if (step === 3) complete(value); else setStep(step + 1) }
    catch (e) { setError(errorMessage(e)) }
  }
  const dismiss = () => JSON.stringify(draft) !== JSON.stringify({ ...initial, enabled: true }) ? setDiscard(true) : close()
  return <><WorkspaceDialog title="设置角色" eyebrow="ROLE SETUP" detail="先写角色，再选聊天方式。无需填写完整传记，也不强制添加示例。" close={dismiss} width="wide" className="dsh-partner-character-dialog">
    {error && <p role="alert" className="dsh-partner-inline-error">{error}</p>}
    <Stepper step={step} onStepChange={n => { setStep(n); setError(undefined) }} onNext={next} busy={false} backButtonText="上一步" nextButtonText="继续" completeButtonText="应用到编辑区">
      <Step title="角色设定"><p className="dsh-partner-character-hint">几条具体习惯就够。可以先填入通用示例，再改成自己的角色。</p><button type="button" onClick={() => setDraft(structuredClone(SAMPLE))}>填入通用示例</button><RoleFields card={draft} onChange={setDraft} /></Step>
      <Step title="聊天方式"><ChatFields companionId={companion.id} card={draft} onChange={setDraft} /></Step>
      <Step title="试聊"><p>试聊可跳过。完成后点击身份页面的“保存身份”生效。</p><CharacterTrial companion={companion} relationshipText={relationshipText} card={draft} /></Step>
    </Stepper>
  </WorkspaceDialog>{discard && <DiscardChangesDialog keepEditing={() => setDiscard(false)} discard={close} />}</>
}

function RoleFields({ card, onChange }: { card: CharacterCard; onChange(card: CharacterCard): void }): JSX.Element {
  return <div className="dsh-partner-character-section">
    <RoleReference />
    {card.roleText === undefined && roleTextForCard(card) && <p className="dsh-partner-character-hint">旧角色与示例完整保留；独立的旧关系字段会显示在“关系设定”。混写在正文里的专属关系请手动移过去，或让 AI 帮你拆分。</p>}
    <Field label="角色设定" hint="只写角色自身的身份、性格、语气与通用示例。与用户的关系、专属称呼请写在身份的“关系设定”，不要混入这里、聊天偏好或背景资料。"><textarea rows={14} maxLength={48000} value={roleTextForCard(card)} onChange={e => onChange({ ...card, roleText: e.target.value })} /></Field>
  </div>
}

function ChatFields({ card, onChange, companionId }: { card: CharacterCard; companionId: string; onChange(card: CharacterCard): void }): JSX.Element {
  const [library,setLibrary]=useState(false)
  return <div className="dsh-partner-character-section">
    <div className="dsh-partner-conversation-summary"><strong>像聊天一样接话</strong><p>先给直接反应，说到点上就停。可以不同意、不知道或开玩笑；不固定追问、不把闲聊改成建议清单。认真求助时照常查证和执行。</p></div>
    <div className="dsh-partner-fields two"><Field label="闲聊节奏" hint="也控制任务回应：短句接话按人格简短接话，不汇总报告，长内容交付文档；自然模式摘要配附件；展开模式在正文说明。你的本轮明确要求优先。"><select value={card.length} onChange={e => onChange({ ...card, length: e.target.value as CharacterCard['length'] })}><option value="short">短句接话</option><option value="balanced">随话题自然调整</option><option value="rich">愿意展开聊</option></select></Field><label className="dsh-partner-character-check"><input type="checkbox" checked={card.narration} onChange={e => onChange({ ...card, narration: e.target.checked })} />允许少量动作描写</label></div>
    <div className="dsh-partner-chat-options">
      <label><input type="checkbox" checked={card.segmentedReplies===true} onChange={e=>onChange({...card,segmentedReplies:e.target.checked})}/><span><strong>允许分段回复</strong><small>默认一句说完就停。确有新内容才另发一条，不凑条数、不刻意等待；长文和代码保持完整。</small></span></label>
      <label><input type="checkbox" checked={card.stickersEnabled===true} onChange={e=>onChange({...card,stickersEnabled:e.target.checked})}/><span><strong>表情包</strong><small>根据语境从表情库选图，作为单独消息发送。不支持表情的渠道会显示图片。</small></span></label>
      <button type="button" onClick={()=>setLibrary(true)}>管理表情库</button>
    </div>
    {library&&<StickerLibraryDialog companionId={companionId} close={()=>setLibrary(false)}/>}
    <Field label="额外聊天偏好（可选）" hint="例如：玩笑时直接接梗；认真说烦恼时先听，不急着给建议。留空使用默认聊天规则。"><textarea rows={4} maxLength={2000} value={card.chatStyle ?? ''} onChange={e => onChange({ ...card, chatStyle: e.target.value })} /></Field>
    <p className="dsh-partner-character-hint">角色聊天保留已配置能力；QQ 未归属账号仅聊天，也不会主动延迟、潜水或省略应有的私聊回复。</p>
  </div>
}

function LoreFields({ card, onChange }: { card: CharacterCard; onChange(card: CharacterCard): void }): JSX.Element {
  return <div className="dsh-partner-character-section"><p className="dsh-partner-character-hint">地点、人物等背景细节可放在这里，提到关键词时加载。日常聊天无需配置。</p>
    {card.lore.map((entry, index) => <ContentDisclosure className="dsh-partner-character-lore" key={entry.id} initialOpen={!entry.title && !entry.content}><summary>{entry.title || `新条目 ${index + 1}`}<small>{entry.enabled ? '已启用' : '已停用'}</small></summary>
      <Field label="条目标题"><input maxLength={100} value={entry.title} onChange={e => onChange({ ...card, lore: card.lore.map((x, i) => i === index ? { ...x, title: e.target.value } : x) })} /></Field>
      <Field label="触发词" hint="最多 8 个，用逗号分隔。"><input value={entry.keywords.join('，')} onChange={e => onChange({ ...card, lore: card.lore.map((x, i) => i === index ? { ...x, keywords: e.target.value.split(/[,，]/).map(t => t.trim()) } : x) })} /></Field>
      <Field label="设定内容"><textarea rows={3} maxLength={2000} value={entry.content} onChange={e => onChange({ ...card, lore: card.lore.map((x, i) => i === index ? { ...x, content: e.target.value } : x) })} /></Field>
      <div className="dsh-partner-character-row"><label className="dsh-partner-character-check"><input type="checkbox" checked={entry.enabled} onChange={e => onChange({ ...card, lore: card.lore.map((x, i) => i === index ? { ...x, enabled: e.target.checked } : x) })} /><span>启用条目</span></label><button type="button" onClick={() => onChange({ ...card, lore: card.lore.filter((_, i) => i !== index) })}>移除条目</button></div>
    </ContentDisclosure>)}<button type="button" disabled={card.lore.length >= 40} onClick={() => onChange({ ...card, lore: [...card.lore, { id: crypto.randomUUID(), title: '', keywords: [], content: '', enabled: true }] })}>添加世界条目</button>
  </div>
}

function CharacterTrial({ companion, card, relationshipText }: { companion: CompanionView; card: CharacterCard; relationshipText: string }): JSX.Element {
  const [audience, setAudience] = useState<'default' | 'qq-owner' | 'qq-guest'>('default')
  const [message, setMessage] = useState('今天不太顺利，想和你聊聊。')
  const [history, setHistory] = useState<Array<{user: string; assistant: string}>>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const send = async () => {
    if (busy) return
    setBusy(true); setError(undefined)
    try { normalizeCharacterCard(card); const result = await api<{reply:string}>(`/companions/${encodeURIComponent(companion.id)}/character/preview`, {method:'POST', body:JSON.stringify({card,message,history,relationshipText,audience})}); setHistory(old => [...old, {user:message,assistant:result.reply}].slice(-8)); setMessage('') }
    catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  return <div className="dsh-partner-character-trial"><Field label="试聊对象" hint="只模拟关系加载，不会向 QQ 发消息。切换对象会清空试聊历史。"><select disabled={busy} value={audience} onChange={e => { setAudience(e.target.value as typeof audience); setHistory([]) }}><option value="default">普通会话 · 角色与关系</option><option value="qq-owner">QQ 归属账号 · 角色与关系</option><option value="qq-guest">QQ 其他账号 / 未绑定 · 仅角色</option></select></Field><details><summary>查看角色与聊天规则</summary><pre>{card.enabled ? [renderCharacterCore(card), renderIdentityRelationship({relationshipText}, audience === 'default' ? {channel:'default'} : {channel:'qq', matched:audience === 'qq-owner'}), renderConversationBehavior(card), renderConversationTurn(card, 1)].join('\n\n') : '角色聊天未启用。'}</pre></details><p className="dsh-partner-character-hint">使用此伙伴当前模型，最多保留 8 组试聊，不写正式记忆。这里仅预览语气，不预览分段或表情发送，不执行操作；正式会话按渠道与账号权限提供工具。</p>
    <div aria-live="polite">{history.map((x, i) => <div className="dsh-partner-trial-exchange" key={i}><p><b>你</b>{x.user}</p><p><b>{companion.name}</b>{x.assistant}</p></div>)}</div>
    <Field label="试聊消息"><textarea rows={2} maxLength={2000} disabled={busy} value={message} onChange={e => setMessage(e.target.value)} /></Field>{error && <p role="alert" className="dsh-partner-inline-error">{error}</p>}
    <div className="dsh-partner-character-row"><button type="button" disabled={busy} onClick={() => setHistory([])}>重新试聊</button><button type="button" disabled={busy || !message.trim() || !card.enabled} onClick={() => void send()}>{busy ? '角色正在回复…' : '发送试聊'}</button></div>
  </div>
}

function ContentDisclosure({children, className, initialOpen}: {children: ReactNode; className: string; initialOpen: boolean}): JSX.Element {
  const [open, setOpen] = useState(initialOpen)
  return <details className={className} open={open} onToggle={event => setOpen(event.currentTarget.open)}>{children}</details>
}
