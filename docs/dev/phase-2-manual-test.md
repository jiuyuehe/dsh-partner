# Phase 2 — Durable Inbox 人工验收手册

本手册用于在 Windows 上验证分支 `yly-mm-wx-up-p2` 的本地 DSH 收件和 SQLite 持久化。Phase 2 不包含 Agent 消费或 Mattermost 回复；**人工验收预期是帖子进入 Durable Inbox，不能用“机器人有没有回复”判断本阶段成败。**

## 1. 验收范围

人工检查以下行为：

1. 用隔离的 DSH Profile 启动本分支插件，且不影响现有 `yly-dev` 或其它 DSH。
2. Mattermost 初次同步建立游标，不执行旧帖子；之后发送的新 DM 帖子写入 SQLite。
3. DSH 重启后游标仍存在；60 秒重叠续读会再次看到近期帖子，但同一 `post_id` 不会重复入库。
4. 如有微信测试账号，可检查 `get_updates_buf` 与消息事件同时持久化。
5. 未批准联系人的消息只产生 `filtered` 元数据记录，正文和附件不写入 Inbox。

本轮自动自测已先行完成：`npm run build` 通过；Durable Inbox、微信续读和 Mattermost 通道回归测试共 39/39 通过；`npm run pack:check` 通过。真实服务器/浏览器步骤由测试者按下面流程执行。

## 2. 预备条件

- Node.js 24.x，已安装可运行的 DSH CLI。
- 检出分支 `yly-mm-wx-up-p2` 的源码目录：`D:\yliyun_project\dsh-partner-yly-mm-wx-up`。
- 可用的 Mattermost bot 凭据和一个测试用户。测试服务器可使用用户提供的 `http://192.168.0.130:8065`；访问令牌只在 DSH 凭据/设置界面输入，不写进本手册、PowerShell 历史、截图或 Plane。
- 新的本地端口 `43129`。若已占用，选一个空闲端口并在下文统一替换。

## 3. 建立隔离 Profile 并安装本地分支

在新的 PowerShell 窗口执行。请保持这个窗口的 `DSH_HOME` 环境变量，后续启动也在同一个窗口进行：

```powershell
$env:DSH_HOME = 'D:\dsh-home-yly-mm-wx-up-p2'
$repo = 'D:\yliyun_project\dsh-partner-yly-mm-wx-up'

# 初始化一个独立 Profile 并从当前本地源码安装插件
dsh plugin --profile yly-mm-wx-up-p2 add $repo
```

如 PowerShell 找不到 `dsh` 命令，可用当前机器的 CLI 入口替代：

```powershell
node 'C:\nvm4w\nodejs\node_modules\@deepseek-ai\dsh\lib\bin.js' plugin --profile yly-mm-wx-up-p2 add $repo
```

安装完成后检查新 Profile 配置中的 `partner` 插件仍有必填 `statePath`。隔离模板默认值通常是 `$DSH_HOME\partner\state.json`；如曾手动覆盖配置，请恢复该字段，并确认它位于上述独立 `DSH_HOME` 下。不要把测试 Profile 指向现有 `yly-dev` 的状态文件或目录。

检查端口空闲：

```powershell
Get-NetTCPConnection -LocalPort 43129 -ErrorAction SilentlyContinue
```

没有输出表示该端口目前没有监听。若输出了连接记录，换用其它端口。

## 4. 启动并连接 Mattermost DM

启动隔离 Profile：

```powershell
node 'C:\nvm4w\nodejs\node_modules\@deepseek-ai\dsh\lib\bin.js' --profile yly-mm-wx-up-p2 --no-open --host 127.0.0.1 --port 43129
```

在浏览器打开 `http://127.0.0.1:43129/`，确认 DSH 页面可以加载，伙伴插件已启用且没有 `statePath` 校验错误。通过插件设置添加 Mattermost DM 渠道，使用测试服务器和凭据完成连接，并批准当前测试用户。不要复用现有 Profile 的本地 state 文件。

等待连接进入运行状态至少 15 秒，让首次同步建立 Mattermost 高水位。首次同步会跳过历史帖子。

## 5. 验证新 DM 持久化与重启去重

在 Mattermost 测试用户与 bot 的私聊中发送一条新的、唯一的普通文本，例如：

```text
P2-MANUAL-20261104-A7F3
```

请使用不同的后缀，避免和历史消息冲突。等待最多 30 秒；Mattermost 正常轮询间隔为 10 秒。

按 `statePath` 定位 Inbox 数据库。若使用默认隔离路径，数据库为：

```text
D:\dsh-home-yly-mm-wx-up-p2\partner\partner-channel-inbox.sqlite
```

在另一个 PowerShell 窗口把变量设为实际路径和测试标记，然后查询。查询不会打印 bot token、微信 context token 或消息正文：

```powershell
$env:INBOX_DB = 'D:\dsh-home-yly-mm-wx-up-p2\partner\partner-channel-inbox.sqlite'
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

**通过标准：** `matches` 恰有一条，`status` 和 `batch_status` 均为 `ready`，`external_event_id` 是 Mattermost 帖子 ID，且存在 Mattermost `timestamp` 游标和非空 `high_watermark`。

现在在运行 DSH 的窗口按 `Ctrl+C` 正常停止，再用第 4 节相同命令重启同一个 Profile。等待 15–30 秒让 60 秒 overlap 补读刚才的帖子，再运行上面查询。**通过标准：** 标记仍只对应一条 Inbox event；其 `external_event_id` 不变，游标没有回退。

## 6. 可选：验证未批准联系人的内容过滤

只在隔离测试服务器和可丢弃的测试 DM 中操作。使用一个尚未批准的测试用户发一条唯一标记，等待轮询后查询：

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

若隔离 Profile 能连接测试微信账号，等待首次轮询后，让已批准联系人发送一条带唯一标记的文本，等待一次 `get_updates` 成功返回。使用下面只输出状态的查询：

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

## 8. 预期结果与排障

| 观察 | 说明/处理 |
| --- | --- |
| DSH 页面可用，数据库出现 `ready` event，但没有机器人回复 | Phase 2 的预期行为；Agent 消费和回复要等 Phase 3。 |
| 启动报 `$.statePath missing required value` | 检查隔离 Profile 的 `partner.statePath`；确保是该测试 DSH_HOME 内的独立路径。 |
| 首次连接没有旧消息 event | 预期；Mattermost 首轮只建立游标。从首轮完成后发送新帖子。 |
| 新帖子 30 秒后仍不存在 | 检查 Profile 插件状态、Mattermost 连接状态和测试用户审批；确认帖子是在 bot 所在 DM 中发出。不要用 channel 顶层帖子或旧消息替代本阶段的 DM 用例。 |
| 重启后游标没变化 | 先确认重启的是同一 `DSH_HOME` 和 Profile；检查 statePath 对应目录是否可写。 |
| 消息被重复插入 | 记录两条 event 的 `external_event_id`、时间、channel config 和状态；保留数据库与 DSH 日志供排查，不要手动删除 event。 |
| 积压超过单页 200 帖 | 插件保持旧游标并暂停推进，避免漏消息；减少测试积压后重连。分页恢复不属于 Phase 2。 |

人工验收结束后只停止这个测试 Profile（运行窗口按 `Ctrl+C`）。保留该隔离 DSH_HOME 和 SQLite 文件，直到验收结果确认完成；不要用清理命令删除或覆盖现有 DSH Profile、凭据或数据库。
