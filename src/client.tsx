import { CompanionVitals } from './ui/companion-vitals.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { observePluginWorkspace } from './workspace-ownership.js'
import {
  IconAgentPresetOutlineRegular as IconAgentPresetOutline16, IconChevronDownOutlineRegular as IconChevronDownOutline14, IconChevronLeftOutlineRegular as IconChevronLeftOutline14,
  IconDataOutlineRegular as IconDataOutline16, IconEditOutlineRegular as IconEditOutline16, IconLinkOutlineRegular as IconLinkOutline16, IconPlusOutlineRegular as IconPlusOutline16,
  IconRefreshOutlineRegular as IconRefreshOutline16, IconUserOutlineRegular as IconUserOutline16, IconBrowseOutlineRegular as IconBrowseOutline16, IconListPenOutlineRegular as IconListPenOutline16, IconPlayOutlineRegular as IconPlayOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { QRCodeSVG } from 'qrcode.react'
import baseCssText from './client.css'
import workspaceCssText from './ui/workspace-ui.css'
import requirementCssText from './ui/requirement-board.css'
import responsiveCssText from './ui/responsive-ui.css'
import pickerCssText from './ui/companion-picker.css'
import pendantCssText from './pendant/widget.css'
import pendantSettingsCssText from './pendant/settings-panel.css'
import memoryCssText from './ui/memory/memory-ui.css'

// 由构建脚本从 package.json 注入，页面可直接标识当前加载的伙伴版本。
declare const __DSH_PARTNER_VERSION__: string
import {MemoryPanel} from './ui/memory/memory-panel.js'
import {ConcernPanel} from './ui/memory/concern-panel.js'
import { PendantSettingsPanel } from './pendant/settings-panel.js'
import { PartnerPendant } from './pendant/widget.js'
import { CompanionPicker } from './ui/companion-picker.js'
import { api, loadPartner, cachedPartner, type ChannelView, type CompanionView, type LoginView, type PartnerSnapshot } from './client-api.js'
import { pendingStorageRecovery } from './ui/storage-recovery-marker.js'
import { observeChannelDiagnostics } from './ui/use-channel-status.js'

import { GlassSurface } from './glass-surface.js'
import { SkillsPanel } from './ui/skills-panel.js'
import { McpPanel } from './ui/mcp-panel.js'
import mcpCssText from './ui/mcp.css'
import { TaskBoardPanel } from './ui/task-board-panel.js'
import { SchedulePanel } from './ui/schedule-panel.js'
import { CapabilityEditor } from './ui/capability-editor.js'
import { IdentityEditor } from './ui/identity-editor.js'
import { CompanionDeletion } from './ui/companion-deletion.js'
import { ChannelsPanel } from './ui/channels-panel.js'
import { useChannelStatus } from './ui/use-channel-status.js'
import identityCssText from './ui/identity-editor.css'
import characterCssText from './ui/character-editor.css'
import qqChannelCssText from './ui/qq-channel-settings.css'
import formSurfaceCssText from './ui/form-surface.css'
import interactionThemeCssText from './ui/interaction-theme.css'
import controlSurfacesCssText from './ui/control-surfaces.css'
import { Avatar, ChannelStatus as Status, ContentState as State, SectionHeading as Section, TabButton, WeixinGlyph, relativeTime } from './ui/partner-components.js'
import { errorMessage as message } from './ui/workspace-components.js'
import { CompanionCreateDialog, type NewCompanionDraft } from './ui/companion-create.js'
import { createPartnerController, type PartnerController as Controller } from './client-controller.js'
import { CAPABILITY_LABELS } from './capabilities.js'
import { registerChatReplies } from './chat/conversation.js'
import { registerDecisionCards } from './decision/conversation.js'

const PLUGIN_ID = '@lemoncat7/dsh-partner'
const STYLE_ID = `${PLUGIN_ID}/client`
const cssText = `${baseCssText}\n${workspaceCssText}\n${pickerCssText}\n${responsiveCssText}\n${requirementCssText}\n${pendantCssText}\n${pendantSettingsCssText}\n${memoryCssText}\n${identityCssText}\n${characterCssText}\n${formSurfaceCssText}\n${mcpCssText}\n${interactionThemeCssText}\n${controlSurfacesCssText}\n${qqChannelCssText}`
type SidebarProps = PropsRuntime<'sidebar.footer.action'>
type ConversationProps = PropsRuntime<'conversation'>
type CompanionTab = 'home' | 'identity' | 'capabilities' | 'weixin' | 'memory' | 'concerns'
import { WorkspaceGroupLinks, WorkspaceGroupTabs, GeneralSettingsPanel, workspaceGroup, type WorkspacePage } from './ui/workspace-navigation.js'
type View = CompanionTab | WorkspacePage

const WORKSPACE_PAGES = new Set<View>(['skills', 'mcp', 'board', 'schedules', 'pendant', 'general'])

export const inject = ['slots', 'layout', 'sessions', 'uiWorkspace']

export function apply(ctx: ClientContext): void {
  registerDecisionCards(ctx)
  registerChatReplies(ctx)
  ctx.effect(installStyles, 'dsh-partner: styles')
  ctx.effect(observeChannelDiagnostics, 'dsh-partner: local channel diagnostics')
  const controller = createPartnerController(ctx, PLUGIN_ID, (props, current) => <PartnerWorkspace {...props} controller={current} />)
  if(pendingStorageRecovery()!==undefined)controller.open(undefined,{page:'general'})
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'partner-pendant', order: 30 }, () => <PartnerPendant controller={controller} />))
  ctx.effect(() => observePluginWorkspace(PLUGIN_ID, controller.close), 'dsh-partner: exclusive workspace')
  ctx.effect(() => () => controller.close(), 'dsh-partner: workspace lifecycle')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'partner', order: -120,
  }, props => <PartnerSidebar {...props} controller={controller} collapse={() => ctx.layout.toggleSidebar()} />))
}

function PartnerSidebar(props: SidebarProps & { controller: Controller; collapse(): void }): JSX.Element {
  // 侧栏节点由 DSH 插槽与 React 生命周期共同管理，不在宿主 DOM 中手动搬动它。
  const [open, setOpen] = useState(true)
  const [snapshot, setSnapshot] = useState<PartnerSnapshot | undefined>(cachedPartner)
  useChannelStatus(setSnapshot)
  const [, update] = useState(0)
  useEffect(() => props.controller.subscribe(() => update(value => value + 1)), [props.controller])
  useEffect(() => { void loadPartner().then(setSnapshot).catch(() => {}) }, [props.controller.isOpen()])
  const launch = (id?: string): void => {
    props.controller.open(id)
    if (props.wide && window.matchMedia('(max-width: 820px)').matches) props.collapse()
  }
  if (!props.wide) return <section className="dsh-partner-sidebar is-rail"><button type="button" className={`dsh-partner-rail${props.controller.isOpen() ? ' is-active' : ''}`} title={`伙伴 · v${__DSH_PARTNER_VERSION__}`} onClick={() => props.controller.toggle()}><IconAgentPresetOutline16 size={18} /></button></section>
  return <section className="dsh-partner-sidebar">
    <div className="dsh-partner-sidebar-heading">
      <button type="button" className="dsh-partner-sidebar-title" aria-expanded={open} onClick={() => setOpen(value => !value)}><span data-open={open}><IconChevronDownOutline14 size={14} /></span>伙伴<small className="dsh-partner-sidebar-version">v{__DSH_PARTNER_VERSION__}</small></button>
    </div>
    <div className={`dsh-partner-sidebar-list${open ? ' is-open' : ''}`} aria-hidden={!open}>
      <div className="dsh-partner-sidebar-list-inner">
        <button type="button" tabIndex={open ? 0 : -1} className={`dsh-partner-sidebar-row${props.controller.isOpen() ? ' is-active' : ''}`} onClick={() => launch()}>
          <span className="dsh-partner-sidebar-symbol"><IconAgentPresetOutline16 size={16} /></span><span><strong>伙伴面板</strong><small>{snapshot ? `${snapshot.companions.length} 位伙伴 · ${snapshot.channels.filter(item => item.runtimeStatus === 'running').length} 个渠道在线` : '身份、能力与渠道'}</small></span><i className={snapshot?.channels.some(item => item.runtimeStatus === 'running') ? 'is-online' : ''} />
        </button>
      </div>
    </div>
  </section>
}

function PartnerWorkspace({ controller }: ConversationProps & { controller: Controller }): JSX.Element {
  const [snapshot, setSnapshot] = useState<PartnerSnapshot | undefined>(cachedPartner)
  useChannelStatus(setSnapshot)
  const [selectedId, setSelectedId] = useState(() => controller.selected() ?? cachedPartner()?.companions[0]?.id)
  const [view, setView] = useState<View>(controller.destination()?.page ?? 'home')
  const [requestedDestination, setRequestedDestination] = useState(controller.destination())
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(() => !cachedPartner())
  const [creatingCompanion, setCreatingCompanion] = useState(false)
  const [notice, setNotice] = useState<string>()
  const selectionRef = useRef({ selectedId, companions: snapshot?.companions })
  selectionRef.current = { selectedId, companions: snapshot?.companions }
  const refresh = useCallback(async (throwOnError = false) => {
    try {
      const next = await loadPartner()
      setSnapshot(next)
      setSelectedId(current => next.companions.some(item => item.id === current) ? current : next.companions[0]?.id)
      setError(undefined)
    } catch (reason) { setError(message(reason)); if (throwOnError) throw reason } finally { setLoading(false) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => controller.subscribe(() => { const next = controller.selected(); if (next) setSelectedId(next); const destination = controller.destination(); if (destination) { setView(destination.page); setRequestedDestination(destination) } }), [controller])
  const selected = snapshot?.companions.find(item => item.id === selectedId)
  const companionRemoved = async (id: string): Promise<void> => {
    const current = selectionRef.current
    const name = current.companions?.find(item => item.id === id)?.name ?? '伙伴'
    setSnapshot(value => value ? { ...value, companions: value.companions.filter(item => item.id !== id), sessions: value.sessions.filter(item => item.companionId !== id) } : value)
    if (current.selectedId === id) {
      setSelectedId(current.companions?.find(item => item.id !== id)?.id)
      setView('home')
    }
    setNotice(`已删除「${name}」，已退出删除确认。`)
    try { await refresh(true) }
    catch (reason) { setError(`伙伴已删除，但刷新失败，请刷新页面，无需再次删除：${message(reason)}`) }
  }
  const create = async (draft: NewCompanionDraft): Promise<void> => {
    try {
      const companion = await api<CompanionView>('/companions', { method: 'POST', body: JSON.stringify({ companion: {
        ...draft, capabilities: [],
      } }) })
      await refresh(); setSelectedId(companion.id); setView('identity'); setCreatingCompanion(false)
    } catch (reason) { setError(message(reason)); throw reason }
  }
  const openSession = async (routeId: string, sessionId: string): Promise<void> => {
    try { setError(undefined); await controller.openSession(routeId, sessionId) }
    catch (reason) { setError(message(reason)) }
  }
  const startSession = async (companionId: string): Promise<void> => {
    try { setError(undefined); await controller.startSession(companionId) }
    catch (reason) { setError(message(reason)) }
  }
  const renewSession = async (routeId: string): Promise<void> => {
    try { setError(undefined); await controller.renewSession(routeId) }
    catch (reason) { setError(message(reason)) }
  }
  const workspacePage = WORKSPACE_PAGES.has(view)
  const openCompanion = (id: string): void => { setSelectedId(id); setView('home') }
  return <main className="dsh-partner-workspace">
    {creatingCompanion && <CompanionCreateDialog close={() => setCreatingCompanion(false)} create={create} />}
    <header className="dsh-partner-topbar">
      <div className="dsh-partner-topbar-brand"><button type="button" data-xiaohei-workspace-close onClick={controller.close} aria-label="返回会话" title="返回会话"><IconChevronLeftOutline14 size={15} /></button><IconAgentPresetOutline16 size={18} /><span><strong>伙伴</strong><small>长期身份与消息渠道 · v{__DSH_PARTNER_VERSION__}</small></span></div>
      <MobileWorkspaceControls
        companions={snapshot?.companions ?? []}
        selectedId={selectedId}
        view={view}
        openCompanion={openCompanion}
        openPage={setView}
        createCompanion={() => setCreatingCompanion(true)}
      />
    </header>
    <div className="dsh-partner-grid">
      <aside className="dsh-partner-roster">
        <div className="dsh-partner-roster-title"><span><small>COMPANIONS</small><strong>伙伴名册</strong></span><button type="button" onClick={() => setCreatingCompanion(true)} aria-label="新建伙伴"><IconPlusOutline16 size={16} /></button></div>
        <div className="dsh-partner-roster-list">{snapshot?.companions.map(companion => {
          const channel = snapshot.channels.find(item => item.companionId === companion.id)
          return <button type="button" key={companion.id} className={!workspacePage && selectedId === companion.id ? 'is-active' : ''} onClick={() => openCompanion(companion.id)}>
            <Avatar name={companion.name} /><span><strong>{companion.name}</strong><small>{companion.role}</small></span><i className={channel?.runtimeStatus === 'running' ? 'is-online' : ''} title={channel ? channel.runtimeStatus : '未连接渠道'} />
          </button>
        })}</div>
        <nav className="dsh-partner-workspace-nav" aria-label="伙伴工作区">
          <WorkspaceGroupLinks view={view} open={setView} />
        </nav>
        <div className="dsh-partner-roster-note"><IconLinkOutline16 size={16} /><span><strong>身份与渠道分离</strong><small>渠道只负责收发，权限仍由 DSH 工具决定。</small></span></div>
      </aside>
      <section className={`dsh-partner-stage${workspacePage ? ' is-workspace-page' : ''}`}>
        {loading ? <State title="正在读取伙伴…" /> : workspacePage ? <><div className="dsh-partner-group-heading"><h1>{workspaceGroup(view)?.label}</h1></div><WorkspaceGroupTabs view={view} open={setView} /><div className="dsh-partner-stage-scroll is-workspace-page">
          {view === 'skills' && <SkillsPanel />}
          {view === 'mcp' && <McpPanel />}
          {view === 'board' && <TaskBoardPanel initialTaskId={requestedDestination?.taskId} openRequest={requestedDestination} />}
          {view === 'schedules' && <SchedulePanel companions={snapshot?.companions ?? []} />}
          {view === 'pendant' && <PendantSettingsPanel />}
          {view === 'general' && <GeneralSettingsPanel />}
        </div></> : selected === undefined ? <State title="创建第一个伙伴" detail="伙伴会保存独立身份、能力和微信会话。" action={<button onClick={() => setCreatingCompanion(true)}>新建伙伴</button>} /> : <>
          <div className="dsh-partner-identity"><Avatar name={selected.name} /><span><small>ACTIVE COMPANION</small><h1>{selected.name}</h1><p>{selected.description || selected.role}</p></span><Status channel={snapshot?.channels.find(item => item.companionId === selected.id)} /></div>
          <nav className="dsh-partner-tabs" aria-label="伙伴配置">
            <TabButton active={view === 'home'} onClick={() => setView('home')} icon={<IconAgentPresetOutline16 size={16} />}>总览</TabButton>
            <TabButton active={view === 'identity'} onClick={() => setView('identity')} icon={<IconEditOutline16 size={16} />}>身份</TabButton>
            <TabButton active={view === 'capabilities'} onClick={() => setView('capabilities')} icon={<IconAgentPresetOutline16 size={16} />}>能力</TabButton>
            <TabButton active={view === 'weixin'} onClick={() => setView('weixin')} icon={<IconLinkOutline16 size={16}/>}>渠道</TabButton>
            <TabButton active={view === 'memory'} onClick={() => setView('memory')} icon={<IconDataOutline16 size={16} />}>记忆</TabButton>
            <TabButton active={view === 'concerns'} onClick={() => setView('concerns')} icon={<IconBrowseOutline16 size={16} />}>持续关注</TabButton>
          </nav>
          <div className="dsh-partner-stage-scroll">
            {notice && <p className="dsh-partner-inline-notice" role="status">{notice}</p>}
            {view === 'home' && <><CompanionDeletion key={selected.id} companion={selected} count={snapshot?.companions.length ?? 1} channelCount={snapshot!.channels.filter(channel => channel.companionId === selected.id).length} onRemoved={companionRemoved} /><HomePanel companion={selected} snapshot={snapshot!} navigate={setView} openSession={openSession} startSession={startSession} renewSession={renewSession} /></>}
            {view === 'identity' && <IdentityEditor companion={selected} onChanged={() => refresh(true)} />}
            {view === 'capabilities' && <CapabilityEditor key={selected.id} companion={selected} presets={snapshot?.presets ?? []} onChanged={() => refresh(true)} />}
            {view === 'weixin' && <ChannelsPanel key={selected.id} companion={selected} snapshot={snapshot!} onChanged={refresh} weixin={<WeixinPanel companion={selected} snapshot={snapshot!} onChanged={refresh} />} />}
            {view === 'memory' && <MemoryPanel key={selected.id} companion={selected} snapshot={snapshot!} openSession={openSession} startSession={startSession} renewSession={renewSession} onChanged={refresh} />}
            {view === 'concerns' && <ConcernPanel key={selected.id} companion={selected} snapshot={snapshot!} onChanged={refresh} />}
          </div>
        </>}
        {error && <p className="dsh-partner-error" role="alert">{error}</p>}
      </section>
    </div>
  </main>
}

function MobileWorkspaceControls({ companions, selectedId, view, openCompanion, openPage, createCompanion }: {
  companions: CompanionView[]
  selectedId: string | undefined
  view: View
  openCompanion(id: string): void
  openPage(page: WorkspacePage): void
  createCompanion(): void
}): JSX.Element {
  return <div className="dsh-partner-mobile-controls">
    <div className="dsh-partner-mobile-companion-row">
      <CompanionPicker companions={companions} selectedId={selectedId} onChange={openCompanion} />
      <button type="button" className="dsh-partner-mobile-create" onClick={createCompanion} aria-label="新建伙伴"><IconPlusOutline16 size={17} /></button>
    </div>
    <nav className="dsh-partner-mobile-workspace-nav" aria-label="伙伴工作区快捷入口">
      <WorkspaceGroupLinks view={view} open={openPage} compact />
    </nav>
  </div>
}

function HomePanel({ companion, snapshot, navigate, openSession, startSession, renewSession }: { companion: CompanionView; snapshot: PartnerSnapshot; navigate(tab: CompanionTab): void; openSession(routeId: string, sessionId: string): Promise<void>; startSession(companionId: string): Promise<void>; renewSession(routeId: string): Promise<void> }): JSX.Element {
  const channel = snapshot.channels.find(item => item.companionId === companion.id)
  const sessions = snapshot.sessions.filter(item => item.companionId === companion.id)
  const localSession = sessions.find(item => item.kind === 'local')
  const pending = channel ? snapshot.pairings.filter(item => item.channelId === channel.id && item.status === 'pending').length : 0
  const approved = channel ? snapshot.pairings.filter(item => item.channelId === channel.id && item.status === 'approved').length : 0
  const capabilities = companion.capabilities.map(item => CAPABILITY_LABELS[item])
  const online = channel?.runtimeStatus === 'running'
  return <div className="dsh-partner-home">
    <header className="dsh-partner-home-heading">
      <span><small>工作台</small><h2>{online ? `${companion.name} 正在渠道待命` : `${companion.name} 已准备就绪`}</h2></span>
      <p>{online ? '消息、授权与上下文边界都在这里汇总。' : '伙伴身份、会话与能力已经准备完成。'}</p>
    </header>

    <CompanionVitals key={companion.id} companion={companion} />

    <section className={`dsh-partner-home-channel${online ? ' is-online' : ''}`}>
      <div className="dsh-partner-home-route" aria-hidden="true">
        <Avatar name={companion.name} />
        <span className="dsh-partner-route-line"><i /></span>
        <span className="dsh-partner-route-weixin"><WeixinGlyph large /></span>
      </div>
      <div className="dsh-partner-home-channel-copy">
        <span className="dsh-partner-home-kicker"><i />消息渠道 · {channel?.platform==='qq'?'QQ':channel?.platform==='matrix'?'Matrix':channel?.platform==='mattermost'?'Mattermost':'微信'}</span>
        <h3>{!channel ? '等待扫码连接' : online ? '连接正常，正在接收消息' : channel.runtimeStatus === 'error' ? '渠道连接需要处理' : '渠道当前已停用'}</h3>
        <p>{!channel ? '连接微信、Matrix 或 Mattermost，联系人首次发消息需批准。' : online ? '本地与所有已授权渠道共用伙伴主对话，回复返回消息来源。' : channel.lastError || '渠道配置仍然保留，可以随时重新启用。'}</p>
        <div className="dsh-partner-home-channel-actions">
          <button type="button" className="is-primary" onClick={() => navigate('weixin')}>{!channel ? '连接微信' : pending > 0 ? `处理 ${pending} 个请求` : '管理渠道'}</button>
          <span>{!channel ? '选择渠道并连接账号' : `${approved} 位联系人 · 共用主对话`}</span>
        </div>
      </div>
    </section>

    <div className="dsh-partner-home-details">
      <section className="dsh-partner-home-profile">
        <header><span><IconUserOutline16 size={16} /></span><div><small>伙伴底稿</small><strong>{companion.role}</strong></div><button type="button" onClick={() => navigate('identity')}>编辑</button></header>
        <blockquote>{companion.instructions || companion.description || '尚未设置长期行为准则。'}</blockquote>
      </section>
      <section className="dsh-partner-home-runtime">
        <header><span><IconAgentPresetOutline16 size={16} /></span><div><small>运行能力</small><strong>{companion.presetId || 'DSH 默认 Preset'}</strong></div><button type="button" onClick={() => navigate('capabilities')}>调整</button></header>
        <div className="dsh-partner-home-capability-list">{capabilities.length ? capabilities.map(item => <em key={item}>{item}</em>) : <small>尚未声明能力范围</small>}</div>
      </section>
      <section className="dsh-partner-home-continuity">
        <header><span><IconDataOutline16 size={16} /></span><div><small>伙伴对话</small><strong>{localSession?.archived ? '会话已归档' : '伙伴会话已建立'}</strong></div><button type="button" onClick={() => localSession === undefined ? void startSession(companion.id) : localSession.archived ? void renewSession(localSession.id) : void openSession(localSession.id, localSession.sessionId)}>{localSession === undefined ? '开始对话' : localSession.archived ? '开始新会话' : '打开会话'}</button></header>
        <p>{localSession ? `最近活动于 ${relativeTime(localSession.lastMessageAt)}；本地与渠道在这里接着聊。` : '伙伴会话正在初始化，稍后即可打开。'}</p>
      </section>
    </div>
  </div>
}

function WeixinPanel({ companion, snapshot, onChanged }: { companion: CompanionView; snapshot: PartnerSnapshot; onChanged(): Promise<void> }): JSX.Element {
  const channels = snapshot.channels.filter(item => item.companionId === companion.id && (!item.platform || item.platform === 'weixin'))
  return <>
    {channels.length > 1 && <p className="dsh-partner-inline-error" role="alert">发现 {channels.length} 个历史微信渠道。请先停用不使用的渠道，再对需要保留的渠道重新扫码；联系人授权不会跨机器人迁移。</p>}
    {channels.length ? channels.map(channel => <WeixinChannelPanel key={channel.id} companion={companion} snapshot={snapshot} onChanged={onChanged} channel={channel} />) : <WeixinChannelPanel companion={companion} snapshot={snapshot} onChanged={onChanged} />}
  </>
}

function WeixinChannelPanel({ companion, snapshot, onChanged, channel }: { companion: CompanionView; snapshot: PartnerSnapshot; onChanged(): Promise<void>; channel?: ChannelView }): JSX.Element {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [login, setLogin] = useState<LoginView>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const loginGeneration = useRef(0)
  const changedRef = useRef(onChanged)
  changedRef.current = onChanged
  useEffect(() => {
    if (!login || login.phase === 'confirmed' || login.phase === 'expired' || login.phase === 'error') return
    let disposed = false
    let timer: number
    const generation = loginGeneration.current
    const poll = async (): Promise<void> => {
      try {
        const result = await api<{ login: LoginView; channel?: ChannelView }>(`/weixin/login/${login.id}`)
        if (disposed || generation !== loginGeneration.current) return
        setError(undefined)
        setLogin(result.login)
        if (result.channel) { setLogin(undefined); await changedRef.current(); return }
      } catch (reason) {
        if (!disposed && generation === loginGeneration.current) setError(message(reason))
      }
      if (!disposed && generation === loginGeneration.current) timer = window.setTimeout(() => { void poll() }, 2_000)
    }
    timer = window.setTimeout(() => { void poll() }, 2_000)
    return () => { disposed = true; clearTimeout(timer) }
  }, [login?.id, login?.phase])
  const begin = async (): Promise<void> => {
    loginGeneration.current += 1
    setLogin(undefined)
    setBusy(true); setError(undefined)
    try { setLogin(await api('/weixin/login', { method: 'POST', body: JSON.stringify({ companionId: companion.id, channelId: channel?.id }) })) }
    catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }
  const toggle = async (): Promise<void> => {
    if (!channel) return
    setBusy(true); setError(undefined)
    try { await api(`/channels/${channel.id}/enabled`, { method: 'POST', body: JSON.stringify({ enabled: !channel.enabled }) }); await onChanged() }
    catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }
  const pairings = channel ? snapshot.pairings.filter(item => item.channelId === channel.id) : []
  const remove = async (): Promise<void> => {
    if (!channel || !confirmDelete) return
    loginGeneration.current += 1
    setLogin(undefined); setBusy(true); setError(undefined)
    try { await api(`/channels/${channel.id}`, { method: 'DELETE' }); await onChanged() }
    catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }
  const actPairing = async (id: string, status: 'approved' | 'blocked'): Promise<void> => {
    try { await api(`/pairings/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }); await onChanged() } catch (reason) { setError(message(reason)) }
  }
  return <div className="dsh-partner-form is-channel"><Section eyebrow="PRIMARY CHANNEL" title="微信渠道" detail="使用微信 iLink Bot 扫码接入。每个机器人只绑定一个伙伴，每位联系人保持独立 DSH 会话。" />
    {!channel && !login && <GlassSurface as="div" interactive className="dsh-partner-weixin-connect" borderRadius={15} distortionScale={-10} saturation={1.06}><div className="dsh-partner-weixin-mark"><WeixinGlyph large /></div><span><strong>把 {companion.name} 带到微信</strong><p>扫码后，机器人凭据直接保存进 DSH 凭据库，不会显示在浏览器或普通配置文件中。</p><ul><li>私聊首次联系必须审批</li><li>联系人之间上下文完全隔离</li><li>工具权限不会因微信身份自动扩大</li></ul></span><button type="button" disabled={busy} onClick={() => { void begin() }}>{busy ? '正在申请二维码…' : '扫码连接微信'}</button></GlassSurface>}
    {login && <GlassSurface as="div" interactive className="dsh-partner-qr" borderRadius={16} distortionScale={-10} saturation={1.06}><div className="dsh-partner-qr-code">{login.qrContent && <QRCodeSVG value={login.qrContent} size={176} level="M" />}</div><span><small>WECHAT ILINK BOT</small><strong>{login.phase === 'scanned' ? '已扫码，请在微信确认' : login.phase === 'expired' ? '二维码已过期' : login.phase === 'error' ? '连接失败' : '使用微信扫码'}</strong><p>{login.error || (login.phase === 'scanned' ? '确认后会自动启动渠道，不需要复制 Token。' : '二维码约 5 分钟有效。此页面可以安全地保持打开。')}</p>{(login.phase === 'expired' || login.phase === 'error') && <button type="button" onClick={() => { setLogin(undefined); void begin() }}><IconRefreshOutline16 size={16} />重新生成</button>}</span></GlassSurface>}
    {channel && <>
      <GlassSurface as="div" interactive className="dsh-partner-channel-card" borderRadius={14} distortionScale={-10} saturation={1.06}><div className="dsh-partner-weixin-mark"><WeixinGlyph large /></div><span><small>WECHAT CHANNEL</small><strong>{channel.name}</strong><p>{channel.accountId}</p></span><Status channel={channel} /><div className="dsh-partner-weixin-actions"><button type="button" className="dsh-partner-switch" data-on={channel.enabled} disabled={busy} role="switch" aria-checked={channel.enabled} aria-label={channel.enabled ? '停用微信渠道' : '启用微信渠道'} onClick={() => { void toggle() }}><i /></button><button type="button" className="dsh-partner-weixin-rescan" disabled={busy} title="更新当前机器人的登录凭据，保留联系人授权" onClick={() => { void begin() }}><IconRefreshOutline16 size={16} />{busy ? '请稍候…' : '重新扫码'}</button></div></GlassSurface>
      {channel.enabled && channel.runtimeStatus === 'starting' && !channel.lastError && <p className="dsh-partner-weixin-help" role="status">登录凭据已保存，正在等待微信接收通道首次响应。长轮询可能需要几十秒；向机器人发送一条消息可帮助确认收发是否正常，无需重复扫码。</p>}
      {channel.lastError && <p className="dsh-partner-inline-error" role="alert">{channel.lastError}</p>}
      {confirmDelete ? <div role="group" aria-label="确认删除微信渠道">
        <p className="dsh-partner-inline-error" role="alert">确认删除 {channel.accountId}？将移除该渠道凭据、联系人配对和渠道会话关联，不会迁移授权，且不可撤销。</p>
        <div className="dsh-partner-weixin-actions"><button type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button><button type="button" disabled={busy} onClick={() => { void remove() }}>{busy ? '正在删除…' : '确认删除'}</button></div>
      </div> : <div className="dsh-partner-weixin-actions"><button type="button" disabled={busy} onClick={() => setConfirmDelete(true)}>删除此渠道</button></div>}
      <div className="dsh-partner-pairing-heading"><span><small>ACCESS</small><strong>私聊配对</strong></span><em>{pairings.filter(item => item.status === 'pending').length} 个待处理</em></div>
      <div className="dsh-partner-pairings">{pairings.length === 0 ? <State title="等待首次消息" detail="扫码只完成机器人登录，不会自动授权联系人。请先在微信向机器人发送一条消息，再回到这里点击「批准」，之后即可对话。" compact /> : pairings.map(pairing => <article key={pairing.id}><span className={`is-${pairing.status}`}><IconUserOutline16 size={16} /></span><div><strong>{pairing.displayName}</strong><small>{pairing.status === 'pending' ? '等待审批' : pairing.status === 'approved' ? '已授权独立会话' : '已阻止'} · {new Date(pairing.updatedAt).toLocaleString()}</small></div>{pairing.status === 'pending' && <><button onClick={() => { void actPairing(pairing.id, 'blocked') }}>拒绝</button><button className="is-primary" onClick={() => { void actPairing(pairing.id, 'approved') }}>批准</button></>}{pairing.status === 'approved' && <button onClick={() => { void actPairing(pairing.id, 'blocked') }}>撤销</button>}{pairing.status === 'blocked' && <button onClick={() => { void actPairing(pairing.id, 'approved') }}>重新批准</button>}</article>)}</div>
    </>}
    {error && <p className="dsh-partner-inline-error">{error}</p>}
  </div>
}

function installStyles(): () => void { let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null; if (!style) { style = document.createElement('style'); style.id = STYLE_ID; style.textContent = cssText; document.head.append(style) } return () => style?.remove() }
