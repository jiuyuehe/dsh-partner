# Phase 2 — Durable Inbox 人工验收手册

本手册用于在 Windows 上验证分支 `yly-mm-wx-up-p2` 的本地 DSH 收件和 SQLite 持久化。Phase 2 不包含 Agent 消费或 Mattermost 回复；**人工验收预期是帖子进入 Durable Inbox，不能用“机器人有没有回复”判断本阶段成败。**

## 1. 验收范围

人工检查以下行为：

1. 使用项目唯一的开发 Profile `dsh-partner-dev` 启动本分支插件；代码迭代、DSH 重启和人工验收都复用同一 Profile。
2. Mattermost 初次同步建立游标，不执行旧帖子；之后发送的新 DM 帖子写入 SQLite。
3. DSH 重启后游标仍存在；60 秒重叠续读会再次看到近期帖子，但同一 `post_id` 不会重复入库。
4. 如有微信测试账号，可检查 `get_updates_buf` 与消息事件同时持久化。
5. 未批准联系人的消息只产生 `filtered` 元数据记录，正文和附件不写入 Inbox。

本轮自测：`npm run build` 通过；`node --test test/channel-diagnostics.test.mjs test/durable-inbox.test.mjs test/weixin-reconnect.test.mjs test/direct-channels.test.mjs` 44/44 通过；`npm run pack:check` 通过。已修复自动发现 Mattermost DM ID 丢失和 Durable Inbox 未生成待审批联系人的问题。用户报告开发 Profile 正常启动；本轮真实浏览器收件仍需按下述步骤复测。

## 2. 预备条件

- Node.js 24.x，已安装可运行的 DSH CLI。
- 检出分支 `yly-mm-wx-up-p2` 的源码目录：`D:\yliyun_project\dsh-partner-yly-mm-wx-up`。
- 可用的 Mattermost bot 凭据和一个测试用户。测试服务器可使用用户提供的 `http://192.168.0.130:8065`；访问令牌只在 DSH 凭据/设置界面输入，不写进本手册、PowerShell 历史、截图或 Plane。
- 项目唯一开发 Profile：`dsh-partner-dev`，位于默认 `DSH_HOME`：`C:\Users\YLY_XM\.dsh`。
- 开发端口 `43128`。若已占用，先确认是否已有本次 DSH 实例；不要另起 Profile 或并行服务。

## 3. 复用开发 Profile 并链接本地分支

在 PowerShell 中复用现有 Profile。此操作只更新伙伴插件指向的源码路径，保留 `cordis.patch.yml`、Mattermost 配置、审批状态和本地数据。不要重建 Profile，也不要运行 `--from-default-profile`：

```powershell
$env:DSH_HOME = 'C:\Users\YLY_XM\.dsh'
$repo = 'D:\yliyun_project\dsh-partner-yly-mm-wx-up'
$profile = 'dsh-partner-dev'

dsh plugin --profile $profile add $repo

# 确认 Profile 同时包含 Web App、伙伴插件和当前开发工作流所需插件
(Get-Content "$env:DSH_HOME\profiles\$profile\package.json" -Raw | ConvertFrom-Json).dsh.profile.bundles
```

最后一条命令应列出 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`@lemoncat7/dsh-partner` 和 `@deepseek-ai/dsh-subagent-codex`。开发 Profile 已基于 `web` 模板创建，伙伴插件依赖的 `agentPresets`、`workspaceRegistry` 由 Web App 提供。不要为阶段测试复制或重建 Profile。

如 PowerShell 找不到 `dsh` 命令，可用当前机器的 CLI 入口替代：

```powershell
node 'C:\nvm4w\nodejs\node_modules\@deepseek-ai\dsh\lib\bin.js' plugin --profile $profile add $repo
```

当前开发 Profile 的伙伴 `statePath` 是 `$env:DSH_HOME\profiles\dsh-partner-dev\partner-test\state.json`。阶段测试必须沿用该状态路径，不能改成临时 Profile 或另一套数据库。不要粘贴、导出或覆盖 `state.json` 中的凭据。

检查端口空闲：

```powershell
Get-NetTCPConnection -LocalPort 43128 -ErrorAction SilentlyContinue
```

如果已有 43128 监听，复用当前实例，或先在启动它的窗口按 `Ctrl+C` 停止后再重启；不要启动第二个 DSH 服务或改用旧页面的端口。

## 4. 启动并连接 Mattermost DM

为了不在源码目录生成默认伙伴 workspace，从 DSH Home 目录启动唯一开发 Profile：

```powershell
Push-Location $env:DSH_HOME
node 'C:\nvm4w\nodejs\node_modules\@deepseek-ai\dsh\lib\bin.js' --profile dsh-partner-dev --no-open --host 127.0.0.1 --port 43128
# 在 DSH 进程按 Ctrl+C 停止后，返回原目录
Pop-Location
```

DSH 启动后会输出带本机临时访问 token 的页面地址，例如 `http://127.0.0.1:43128/?token=…`。在同一台机器的浏览器打开终端输出的**完整地址**；不要把 query token 写入手册、Plane 或截图。裸地址可能返回 HTTP 401，这是访问认证，不代表服务未启动。每次重启后都以新进程打印的地址为准；旧端口页面会显示 `Failed to fetch`。

确认 DSH 页面加载，且启动输出没有 `Failed to load plugins`、`pending (waiting for services: agentPresets, workspaceRegistry)` 或 `statePath` 校验错误。继续使用此 Profile 中已配置的 Mattermost 渠道和审批状态；不要重复创建渠道或覆盖本地 state 文件。

在开始发消息前打开浏览器开发者工具（F12）并选中 **Console**，保持本地 DSH 的伙伴工作区打开且页面可见。诊断记录复用现有 `GET /partner-local/v1/channels/status`，不新增网络路由；本地页面会打印 `[dsh-partner][平台][阶段]` 事件，包括消息预览、来源 ID、过滤/入库结果和错误。日志最多展示 1000 字符正文预览，不包含 bot token、微信 context token 或附件内容。

等待连接进入运行状态至少 15 秒，让首次同步建立 Mattermost 高水位。首次同步会跳过历史帖子。

## 5. 验证新 DM 持久化与重启去重

在 Mattermost 测试用户与 bot 的私聊中发送一条新的、唯一的普通文本，例如：

```text
P2-MANUAL-20261104-A7F3
```

首次使用、尚未审批的联系人应先看到配对码提示；DSH 渠道配置中的联系人列表应出现待审批记录，且 Console 显示 `message-received`、`pairing-pending`、`pairing-notice-sent`。Mattermost 自动发现模式必须使用这条入站消息实际携带的 DM channel ID，不应再报 `Mattermost DM channel ID is required`。批准后再发一条新的唯一标记进行 Inbox 验证。

请使用不同的后缀，避免和历史消息冲突。等待最多 30 秒；Mattermost 正常轮询间隔为 10 秒。

按 `statePath` 定位 Inbox 数据库。当前项目开发 Profile 的数据库为：

```text
C:\Users\YLY_XM\.dsh\profiles\dsh-partner-dev\partner-test\partner-channel-inbox.sqlite
```

在另一个 PowerShell 窗口把变量设为实际路径和测试标记，然后查询。查询不会打印 bot token、微信 context token 或消息正文：

```powershell
$env:INBOX_DB = 'C:\Users\YLY_XM\.dsh\profiles\dsh-partner-dev\partner-test\partner-channel-inbox.sqlite'
$env:MANUAL_MARKER = 'P2-MANUAL-20261104-A7F3'

@'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.INBOX_DB, { readOnly: true });
try {
  const matches = db.prepare(`
    SELECT e.external_event_id, e.status, e.received_at,
           b.status AS batch_status,
           CASE WHEN json_extract(e.payload_json, '$.text') LIKE '%' || ? || '%' THEN 1 ELSE 0 END AS marker_match
    FROM inbox_events e
    LEFT JOIN message_batches b ON b.id = e.batch_id
    WHERE e.platform = 'mattermost'
    ORDER BY e.received_at DESC
    LIMIT 100
  `).all(process.env.MANUAL_MARKER).filter(row => row.marker_match === 1);
  const cursors = db.prepare(`
    SELECT channel_config_id, cursor_type, high_watermark, updated_at
    FROM channel_cursors WHERE platform = 'mattermost'
  `).all();
  console.log(JSON.stringify({ matches, cursors }, null, 2));
} finally { db.close(); }
'@ | node --input-type=module
```

**通过标准：** 对已批准联系人发送的新帖子，`matches` 恰有一条，`status` 和 `batch_status` 均为 `ready`，`external_event_id` 是 Mattermost 帖子 ID，且存在 Mattermost `timestamp` 游标和非空 `high_watermark`。Console 显示 `inbox-persisted`。若联系人未审批，预期事件为 `filtered`、正文为空，同时出现可批准的 pairing；不能把未批准消息要求为 `ready`。

现在在运行 DSH 的窗口按 `Ctrl+C` 正常停止，再用第 4 节相同命令重启同一个 Profile。等待 15–30 秒让 60 秒 overlap 补读刚才的帖子，再运行上面查询。**通过标准：** 标记仍只对应一条 Inbox event；其 `external_event_id` 不变，游标没有回退。

## 6. 可选：验证未批准联系人的内容过滤

只在测试服务器和可丢弃的测试 DM 中操作。使用一个尚未批准的测试用户发一条唯一标记，等待轮询后查询：

```powershell
@'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.INBOX_DB, { readOnly: true });
try {
  const rows = db.prepare(`
    SELECT external_event_id, status,
           CASE WHEN COALESCE(json_extract(payload_json, '$.text'), '') = '' THEN 1 ELSE 0 END AS body_redacted,
           CASE WHEN json_array_length(json_extract(payload_json, '$.attachments')) = 0 THEN 1 ELSE 0 END AS attachments_redacted,
           CASE WHEN json_type(payload_json, '$.replyContextToken') IS NULL THEN 1 ELSE 0 END AS route_token_absent
    FROM inbox_events
    WHERE platform = 'mattermost' AND actor_id = ?
    ORDER BY received_at DESC LIMIT 5
  `).all(process.env.UNAPPROVED_MM_USER_ID);
  console.log(JSON.stringify(rows, null, 2));
} finally { db.close(); }
'@ | node --input-type=module
```

**通过标准：** 该事件状态是 `filtered`，`body_redacted`、`attachments_redacted`、`route_token_absent` 都是 `1`。测试后如有需要，撤销/清理测试用户的配对状态。

## 7. 可选：验证微信 buffer 恢复

若开发 Profile 能连接测试微信账号，等待首次轮询后，先在 Console 观察 `poll-page` 和 `message-received`。未批准联系人应出现待批准配对与配对码提示；批准后再让其发送一条带唯一标记的文本，等待一次 `get_updates` 成功返回。使用下面只输出状态的查询：

```powershell
@'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.INBOX_DB, { readOnly: true });
try {
  console.log(JSON.stringify({
    cursors: db.prepare(`
      SELECT channel_config_id, cursor_type, updated_at,
             CASE WHEN json_type(cursor_json, '$.buffer') = 'text' THEN 1 ELSE 0 END AS buffer_saved
      FROM channel_cursors WHERE platform = 'weixin'
    `).all(),
    events: db.prepare(`
      SELECT external_event_id, status, received_at,
             CASE WHEN json_type(payload_json, '$.replyContextToken') = 'text' THEN 1 ELSE 0 END AS reply_route_saved
      FROM inbox_events WHERE platform = 'weixin' ORDER BY received_at DESC LIMIT 5
    `).all()
  }, null, 2));
} finally { db.close(); }
'@ | node --input-type=module
```

重启同一 Profile 后再次查询。**通过标准：** WeChat 游标类型是 `opaque-buffer`、`buffer_saved=1`，消息仍存在且状态保持 `ready`；授权消息有回复路由 token 时只检查 `reply_route_saved=1`，不要打印 token 本身。重放同一消息后 event 数量不能增加。

对于升级前已保存但无 pairing 的最近一小时 `filtered` 事件，启动插件时会恢复对应的待批准联系人。旧事件仍保持脱敏和 `filtered`，不会因审批而重新执行；审批后需联系人发一条新消息。Console 应显示 `pairing-recovered`。整个 Phase 2 不启动 Agent，因此批准后也不会有 Agent 回复。

## 8. 预期结果与排障

| 观察 | 说明/处理 |
| --- | --- |
| Skill 市场或内置插件显示 `Failed to fetch` | 确认当前 DSH 仍在监听 43128，并打开该进程本次打印的完整 token URL；旧端口、已停止服务的页面或裸地址都不能代表当前 DSH 状态。 |
| DSH 页面可用，数据库出现 `ready` event，但没有机器人回复 | Phase 2 的预期行为；Agent 消费和回复要等 Phase 3。 |
| 启动报 `$.statePath missing required value` | 检查 `dsh-partner-dev` 的 `partner.statePath`，恢复为本 Profile 内的固定路径。 |
| `/partner-local/v1/companions` 返回 404 或 405 | 伙伴列表快照使用 `GET /partner-local/v1/`；创建使用 `POST /partner-local/v1/companions`。不要把 `GET /companions` 当作列表接口或插件挂载探针。 |
| GET `/partner-local/v1/health`、`/partner-local/v1/storage/status` 或 `/partner-local/v1/pendant/inbox` 返回 404 | 这些都是插件明确注册的 GET 路由。先核对当前端口的 DSH Profile、插件是否已激活、服务注入是否完成、加载的包路径/构建版本和 `exposeWeb`；404 表示当前请求未命中伙伴 API 路由，不要先改前端 URL 或方法。 |
| 匿名探测上述插件 API 返回 401 | DSH Connection 已拦截未认证请求；用当前 DSH 浏览器会话验证需要打开该 Profile 的登录页面。401 与 404 不同，前者说明请求已到达插件路由并被认证层拒绝。 |
| 启动报 `unsupported partner state schema` | 不要删改现有 `state.json`。P2 会原样保留已知的 schema 15 `mattermostBatches` 数据；其它 schema 版本仍需先核对迁移兼容性。 |
| 首次连接没有旧消息 event | 预期；Mattermost 首轮只建立游标。从首轮完成后发送新帖子。 |
| 新帖子 30 秒后仍不存在 | 检查 Profile 插件状态、Mattermost 连接状态和测试用户审批；确认帖子是在 bot 所在 DM 中发出。不要用 channel 顶层帖子或旧消息替代本阶段的 DM 用例。 |
| 重启后游标没变化 | 先确认重启的是同一 `DSH_HOME` 和 Profile；检查 statePath 对应目录是否可写。 |
| 消息被重复插入 | 记录两条 event 的 `external_event_id`、时间、channel config 和状态；保留数据库与 DSH 日志供排查，不要手动删除 event。 |
| 积压超过单页 200 帖 | 插件保持旧游标并暂停推进，避免漏消息；减少测试积压后重连。分页恢复不属于 Phase 2。 |

人工验收结束后只停止 `dsh-partner-dev`（运行窗口按 `Ctrl+C`）。保留其 state 和 SQLite 文件；不要用清理命令删除、重建或覆盖其它 Profile、凭据或数据库。
