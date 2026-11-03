import {useRef, useState} from 'react'
import {api} from '../../client-api.js'
import type {PersonaView as View, PersonaParagraph} from '../../persona/types.js'
import {CollectionEmpty, WorkspaceDialog, WorkspaceNotice, errorMessage} from '../workspace-components.js'
import {relativeTime} from '../partner-components.js'

const topics = {background: '背景与目标', interests: '持续兴趣', collaboration: '沟通与协作', changes: '近期变化', expression: '聊天习惯'}
const statuses = {waiting: '等待足够依据', pending: '等待后台更新', processing: '正在整理画像', ready: '已更新', retrying: '等待自动重试'}

export function PersonaView({view, base, scopeId, enabled, changed}: {
  view: View | undefined; base: string; scopeId: string; enabled: boolean; changed(): Promise<void>
}): JSX.Element {
  const [selected, setSelected] = useState<PersonaParagraph>()
  const [correction, setCorrection] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const lock = useRef(false)
  const submit = async (action: 'refresh' | 'correct'): Promise<void> => {
    if (!view || lock.current) return
    lock.current = true; setBusy(true); setError(undefined); setNotice(undefined)
    try {
      await api(`${base}/memory/persona?${new URLSearchParams({scopeId})}`, {method: 'POST',
        body: JSON.stringify({action, version: view.version, paragraphId: selected?.id, correction})})
      setSelected(undefined)
      setNotice(enabled ? '已加入后台队列，完成后自动更新；不影响当前对话。' : '已保存请求，恢复学习后继续整理。')
      await changed()
    } catch (reason) {setError(errorMessage(reason))}
    finally {lock.current = false; setBusy(false)}
  }
  return <details className="dsh-partner-persona" aria-label="用户概述">
    <summary><strong>用户概述</strong><small role="status">{!enabled ? '学习已暂停' : view ? statuses[view.status] : '正在读取'}{view?.updatedAt ? ` · ${relativeTime(view.updatedAt)}` : ''}</small></summary>
    <div className="dsh-partner-persona-body">
    {notice && <WorkspaceNotice kind="success">{notice}</WorkspaceNotice>}
    {error && !selected && <WorkspaceNotice>{error}</WorkspaceNotice>}
    {view?.error && <WorkspaceNotice>上次整理失败：{view.error}。已有有效画像仍保留；{enabled ? '后台会自动重试。' : '恢复学习后重试。'}</WorkspaceNotice>}
    {!view?.paragraphs.length && <CollectionEmpty title="还没有足够依据形成用户概述" detail="描述你的背景、目标与稳定偏好，不把临时任务当作人物特征。已有记忆仍可在下方查看。" />}
    <article>{Object.entries(topics).map(([topic, title]) => {
      const paragraphs = view?.paragraphs.filter(item => item.topic === topic) ?? []
      return paragraphs.length ? <section key={topic}><h4>{title}</h4>{paragraphs.map(item => <p key={item.id}>{item.text}</p>)}</section> : null
    })}</article>
    <details className="dsh-partner-memory-record"><summary>依据与修正</summary><div>
      <p className="dsh-partner-memory-hint">观察性描述是可以纠正的理解，不是已确认事实。修改基础记忆请点击下方列表中的条目。</p>
      {view?.paragraphs.map(item => <section key={item.id}>
        <small>{topics[item.topic]} · {item.basis === 'explicit' ? '明确表达' : '多轮观察'}</small><p>{item.text}</p>
        <details className="dsh-partner-memory-record"><summary>查看依据 · {item.evidence.length}</summary><div>{item.evidence.map(source => <blockquote key={source.id}><p>{source.text}</p><small>{new Date(source.at).toLocaleString()} · {source.kind === 'memory' ? '有效记忆' : '用户原话'}</small></blockquote>)}</div></details>
        <button type="button" disabled={busy} onClick={() => {setSelected(item); setCorrection(''); setError(undefined)}}>纠正这段理解</button>
      </section>)}
      <button type="button" disabled={busy || !view || !enabled || view.status === 'processing' || view.status === 'waiting'} onClick={() => {void submit('refresh')}}>{busy ? '提交中…' : view?.status === 'retrying' ? '立即重试' : '重新整理概述'}</button>
    </div></details>
    {selected && <WorkspaceDialog title="纠正伙伴的理解" detail="提交后立即停用这段理解，再根据依据重新整理。留空表示否认此结论。" close={() => {if (!busy) setSelected(undefined)}}>
      {error && <WorkspaceNotice>{error}</WorkspaceNotice>}
      <p>{selected.text}</p>
      <div className="dsh-partner-feature-form"><label>正确的理解<textarea value={correction} maxLength={500} onChange={event => setCorrection(event.target.value)} rows={4} /></label></div>
      <footer className="dsh-partner-memory-actions"><button type="button" disabled={busy} onClick={() => setSelected(undefined)}>取消</button><button type="button" className="is-primary" disabled={busy} onClick={() => {void submit('correct')}}>{busy ? '保存中…' : '保存纠正'}</button></footer>
    </WorkspaceDialog>}
    </div>
  </details>
}
