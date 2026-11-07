# Phase 3/4 微信渠道人工验收

日期：2026-11-05\
分支：`yly-mm-wx-up-p2`\
包版本：`2.24.4`\
Profile：`dsh-partner-dev`（`127.0.0.1:43128`）

## 先区分“收到了”和“交给 DSH”

P2 负责把平台消息与游标原子写进 SQLite，**P2 单独不会调用 DSH Agent**。由 P3 Dispatcher 等待 debounce 窗口后领取 `ready` 消息，再调用 Agent。F12 中看到 `poll-page` 或 `message-received` 只能证明平台返回了帖子，不代表 Agent 已接收。

在 DSH 的伙伴页面打开 Chrome DevTools → Console，localhost 会通过现有 `GET /partner-local/v1/channels/status` 输出以下记录：

| 阶段 | 典型日志 | 意义 |
| --- | --- | --- |
| 平台收件 | `poll-page`、`message-received` | 平台轮询返回了消息 |
| 持久化 | `inbox-persisted` | 消息与游标已提交；检查 `inserted`、`duplicate` |
| 等待审批 | `pairing-pending` | 联系人未批准；正文不会交给 Agent |
| 立即确认 | `inbox-ack-sent` | 已向获准联系人发出收件确认 |
| 进入任务队列 | `inbox-claimed` | Dispatcher 已领取持久化批次 |
| DSH 调用 | `agent-dispatch-starting`、`agent-followup-starting`、`agent-followup-submitted` | 确认 DSH Agent 开始并收到本轮正文 |
| 处理结果 | `agent-followup-completed`、`agent-dispatch-returned`、`inbox-completed` | Agent 已返回并完成渠道投递 |
| 故障 | `inbox-failed`、`agent-dispatch-error`、`agent-empty-reply` | 查看同条记录的 `detail`；失败不会伪装为已完成 |

正常消息收到后约 1.2 秒静默窗口内会合批；首条消息起最多收集 4 秒，每批最多 8 条。每条获准消息先单独确认，随后整批只调用一次 Agent。

## 启动同一个 Profile

先检查 `127.0.0.1:43128` 是否已有 DSH 运行。若已在运行，不要再启动第二个进程。停止时在启动它的 PowerShell 窗口按 `Ctrl+C`。需要手动启动时：

```powershell
$node = 'C:\nvm4w\nodejs\node.exe'
$dsh = 'C:\nvm4w\nodejs\node_modules\@deepseek-ai\dsh\lib\bin.js'
& $node $dsh --profile dsh-partner-dev --no-open --host 127.0.0.1 --port 43128
```

打开 [http://127.0.0.1:43128/](http://127.0.0.1:43128/)，确认伙伴与微信渠道正常。此次开发 Profile 的插件目录应指向 `D:\yliyun_project\dsh-partner-yly-mm-wx-up`，包版本为 `2.24.4`。

## 验收步骤

1. **联系人授权与问候**：使用已经批准的微信联系人发送“你好”。微信应立即收到“收到，正在整理这组消息。”；静默窗口后 DSH 应在渠道专属会话中收到正文并自然问候。F12 顺序至少应到 `inbox-claimed`、`agent-followup-submitted`、`inbox-completed`。旧会话中遗留的页面提问不得再次出现。
2. **多条消息合批**：在 1.2 秒内连续发送“整理本次变更”和“最后列出测试结果”。每条都应先收到确认；批次只调用一次 Agent，正文按顺序包含两条原文，最终答复回到该微信联系人。
3. **独立请求排队**：首批已进入执行后，再发送一个明确独立请求。它应成为该联系人的下一批，按 FIFO 在首批之后处理；不应覆盖或重复执行首批。
4. **不同联系人隔离**（有第二个测试账号时）：A、B 分别发不同问题。应使用不同 DSH Session；A 的回复使用 A 的微信上下文，B 的回复使用 B 的上下文。
5. **重启续读**：在 DSH 正常运行时先确认基线日志，然后停止同一 Profile。停机时向微信发送一条新测试消息，再启动同一 Profile。消息应续读并执行一次；不应丢失或重复回复。Profile 数据、配对与旧 Session 不需要手动删除。
6. **媒体回归**：发送一张图片和一个普通文件，确认 Agent 收到附件内容；再让 Agent 交付一个真实工作区文件，确认微信收到附件。F12/诊断不能出现 context token、机器人令牌或附件字节。
7. **失败可诊断**：若消息已 `inbox-persisted` 却没有 `agent-followup-submitted`，记录最后一个阶段及其 `detail`。`pairing-pending` 代表审批问题；`inbox-failed` 代表 Dispatcher/Agent 失败；仅有 `message-received` 代表尚未证明消息写入 Inbox。

## 自动化证据

- P2：`node --test test/channel-diagnostics.test.mjs test/durable-inbox.test.mjs test/weixin-reconnect.test.mjs test/direct-channels.test.mjs`（56/56）。
- P3：`node --test test/durable-inbox.test.mjs test/inbox-session-router.test.mjs test/channel-task-handoff.test.mjs test/channel-diagnostics.test.mjs test/weixin-reconnect.test.mjs test/direct-channels.test.mjs`（60/60）。
- P4：`node --test test/inbox-session-router.test.mjs test/durable-inbox.test.mjs test/channel-media.test.mjs test/channel-question-tool.test.mjs test/channel-reply-deliverability.test.mjs`（63/63）。
- 用户在上述 Profile 完成人工步骤后，再把真实微信结果、F12 阶段顺序和回复/附件结果记录到 Plane；自动化结果不代替真实渠道验收。
