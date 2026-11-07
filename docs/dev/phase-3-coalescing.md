# Phase 3 — 消息 Coalescer 和 Dispatcher

日期：2026-11-05\
分支：`yly-mm-wx-up-p2`\
Plane：`MM-WX 2.24 | Phase 3 消息 Coalescer 和 Dispatcher`

## 实现与验收

| 任务 | 实现范围 | 自动化证据 |
| --- | --- | --- |
| P3-01 Debounce | 使用数据库 `readyAt` 实现短窗口合批，并限制最大收集时间。 | `coalescer respects quiet and hard windows` |
| P3-02 同会话合并 | 以稳定 `conversationKey` 限定批次范围；DM 必须是同一发言人。 | `coalescer respects quiet and hard windows`、`same event repeated ten times` |
| P3-03 多人 Thread 合并 | 同 root thread 内保留每个发言人和时间顺序，不同 root 分开。 | `coalescer respects quiet and hard windows` |
| P3-04 Steer | Inbox 消费期间使用已存在的 Agent steer 接口；微信 DM 只有显式“补充/更正/追加”标记才进入运行中任务。 | `WeChat steer requires an explicit supplement marker`、`dispatcher runs one lane...` |
| P3-05 Queue | 每个会话按批次顺序处理，独立目标排队。 | `a blocked conversation does not block another lane...` |
| P3-06 并行 | 活跃任务按会话分 lane；一个会话阻塞时，另一会话可以完成。 | `a blocked conversation does not block another lane...` |
| P3-07 限流 | 队列上限只产生诊断，不丢弃 SQLite 中的入站消息。 | `queue pressure is diagnosed while persisted messages remain available for FIFO drain` |

Agent 接线由 `ChannelManager.start()` 启动 Durable Inbox Dispatcher；消息先落库、逐条即时确认，再合批进入 Agent。持久批次由租约保护，调用 Agent 后再记录成功或可诊断失败。DSH 本地渠道诊断记录 Agent 调用开始、失败/返回及耗时，不记录微信 context token 或机器人凭据。

Mattermost 空闲会话采用 5 秒静默窗口、15 秒最长收集时间，避免用户已经停下后仍等待 30 秒；同一 Mattermost 会话已有 Agent 正在执行时，新消息继续通过原生 steer 立即插入，不等待该窗口。

## 实际验证

- `npm run build`：通过。
- `node --test test/durable-inbox.test.mjs test/inbox-session-router.test.mjs test/channel-task-handoff.test.mjs test/channel-diagnostics.test.mjs test/weixin-reconnect.test.mjs test/direct-channels.test.mjs`：60 项通过，0 失败。
- 集成测试覆盖 `ChannelManager.start()`、微信收件入库、立即确认、等待合批、Agent 调用、最终回复以及诊断事件顺序。
- 更宽回归另包含 `test/channel-media.test.mjs`，出现 5 个 Windows 环境失败：两项创建符号链接时 `EPERM`，两项临时 SQLite 文件清理时 `EBUSY`，一项长文附件期待值与当前平台路径行为不符。本阶段专项 60 项不包含这组既有平台限制用例。

## 状态与人工门槛

- 自动化验收：**PASS**。
- 本地 DSH 浏览器与真实聊天账号的消息合批/分步回复：待用户在 `dsh-partner-dev` 人工验收。
- 剩余风险：系统按规则合并连续入站消息；独立目标的语义判断仍由 Agent 根据完整批次正文负责，插件不会拆分后自行猜测多个业务目标。

## F12 如何判断消息是否进入 DSH

`poll-page` 和 `message-received` 只证明平台返回了消息；若只看到这两项，尚不能说 Agent 已收到。P2 还会记录 `inbox-persisted`，其中未批准联系人会出现 `pairing-pending` 并保持 `filtered`，不会交给 Agent。获准消息经 debounce 后应继续出现 `inbox-claimed`、`agent-dispatch-starting` 和 `agent-followup-submitted`；最后通常是 `inbox-completed`。若停在 `inbox-failed`，看同一记录的错误详情；空 Agent 回复会明确报 `agent-empty-reply`，不会被记为完成。

这组阶段日志由现有 `GET /channels/status` 汇总并在 localhost 的浏览器 Console 输出，没有增加或改动插件 HTTP 路径/方法。逐步人工用例见 `phase-3-4-manual-test.md`。
