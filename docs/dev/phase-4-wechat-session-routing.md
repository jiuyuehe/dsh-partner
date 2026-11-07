# Phase 4 — 微信会话隔离与回归

日期：2026-11-05\
分支：`yly-mm-wx-up`\
Plane：`MM-WX 2.24 | Phase 4 微信会话隔离与回归`

## 实现与验收

| 任务 | 实现范围 | 自动化证据 |
| --- | --- | --- |
| P4-01 联系人 Session Key | `InboxSessionRouter` 以稳定 `conversationKey` 映射微信账号和联系人。 | `each account/contact gets a stable isolated Session and CWD` |
| P4-02 Session 持久化 | Session/CWD 路由写入现有状态库；重建 Router 后继续使用同一个路由。 | `each account/contact gets a stable isolated Session and CWD across router restart` |
| P4-03 Context Token 路由 | 回复令牌只在内存中按 `accountId:userId` 隔离，绝不进入 Agent 正文或诊断。 | `WeChat context tokens stay isolated by bot account for the same contact` |
| P4-04 Buffer 持久化 | Inbox 事件和 `get_updates_buf` 在同一 SQLite 事务落库，重启恢复后继续消费。 | `WeChat buffer and message survive close/reopen`、`WeChat durable poll resumes its buffer...` |
| P4-05 微信附件回归 | Inbox 持久化短期媒体引用；消费时下载图片/文件并交给 Agent，回复附件沿用原上传通道和最新联系人的 context token。 | `WeChat media references survive inbox restart...` |
| P4-06 历史隔离迁移 | 新 Inbox 路由创建独立 Session 和 CWD；旧微信 Session、历史位置及联系人记忆键原样保留，不复制主 Session 历史。 | `first inbox route leaves the legacy channel Session...` |
| P4-07 渠道澄清续接 | 微信与 Mattermost 的 Durable Inbox 会话不向模型暴露 DSH UI 专用 `ask_user_question`；缺少必要信息时通过原渠道澄清，用户下一条消息继续进入相同 Session。问候类消息优先直接回应，忽略旧的页面待答问题。空 Agent 结果会进入可见失败状态，不会伪装成已完成。 | `WeChat and Mattermost inbox sessions hide the DSH page question tool`、`runtime guard denies hidden UI questions`、`exclusive persona projection preserves the hidden channel-routing system context`、`empty or whitespace-only Agent output is not considered a completed channel reply` |

来源身份只用于路由；发给 Agent 的 `message.text` 仍是本轮真实用户正文，附件内容以受控附件对象提供。context token、带签名 URL 和机器人 token 不会进入用户消息或 F12 诊断日志。不同账号、联系人和渠道配置会获得互不复用的 Session/CWD；旧历史不自动迁移或删除。

## 运行故障复现与修复

同一 `dsh-partner-dev` Profile 曾出现微信消息已入库、Agent 已启动但一直没有渠道回复。SQLite 中可见 1 个处理中批次和 2 个同一会话的待处理批次；对应 DSH Session 事件显示 Agent 将 `ask_user_question` 作为最后一个未完成调用。该工具等待 DSH 页面人工输入，外部微信/Mattermost 用户无法完成这个等待，因此旧批次持续续租并挡住同会话后续消息。

修复在 DSH 插件工具装配、`partner_tools` 目录和运行时派发守卫三处统一隐藏/拒绝 `ask_user_question`，并将渠道澄清规则作为独立系统上下文注入；系统上下文不加入伙伴可见的消息正文，即使角色启用了独占提示也保留渠道路由规则。确认没有更改 DSH HTTP 路由、请求方法或 Host 网络接口。

如果 Agent 因中断或异常只返回空文本、无附件、无卡片且没有确认过的工具投递，Inbox 现在会记录 `agent-empty-reply` 错误并将批次转入不可自动重放的失败状态，避免界面显示成功但 Mattermost/微信没有结果。系统提示也明确问候要就地问候，不应被历史中遗留的时区提问带偏。

## 实际验证

- `npm run build`：通过。
- `node --test test/inbox-session-router.test.mjs test/durable-inbox.test.mjs test/channel-media.test.mjs test/channel-question-tool.test.mjs test/channel-reply-deliverability.test.mjs`：63 项通过，0 失败。
- `npm run pack:check`：通过，npm pack dry-run 包含 Inbox migration 与 P3/P4 文档。
- 媒体集成测试在 SQLite 关闭并重开后读取保存的微信图片与文件，确认二者到达 Agent；Agent 返回的图片和文件通过微信 API 发出，且三个发送消息均带该联系人的持久化 context token。
- Windows 回归修正：真实 `C:\...` 附件路径不再被误判为 URL scheme；路径逃逸用例改用目录 Junction，测试结束前先排空附件 SQLite 队列并关闭数据库。

## 状态与人工门槛

- 自动化验收：**PASS**，联系人隔离、持久化续读、媒体传输、回复路由、页面提问工具隐藏和失败可见性均有回归覆盖。
- 真实渠道验收：用户确认从微信发送测试消息，DSH 未调用 `ask_user_question`；同一 `dsh-partner-dev` Profile 的 Inbox 记录显示获准事件已确认且批次完成，关联 Agent Session 的调用记录未出现该工具。此前观察到的 `pwsh` 审批后来已解决，最新 Inbox/Session 检查没有未完成的批次或待处理审批。
- 未声称本次人工操作重新覆盖每一种媒体和强制重启场景；这些行为由本阶段自动化集成测试覆盖，完整手工步骤保留在 `phase-3-4-manual-test.md`。
- 本阶段未清空或迁移 Profile 中任何既有 Session、Inbox、微信 buffer 或配对状态。

## 最终验收证据（2026-11-05）

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| P3 消息队列、合并窗口、Steer/Queue 与 Durable Inbox | **PASS** | `node --test test/durable-inbox.test.mjs test/inbox-session-router.test.mjs test/channel-task-handoff.test.mjs test/channel-diagnostics.test.mjs test/weixin-reconnect.test.mjs test/direct-channels.test.mjs`：60/60。 |
| P4 会话、附件、澄清工具与回执回归 | **PASS** | `node --test test/inbox-session-router.test.mjs test/durable-inbox.test.mjs test/channel-media.test.mjs test/channel-question-tool.test.mjs test/channel-reply-deliverability.test.mjs`：63/63。 |
| 构建和发布包 | **PASS** | `npm run build`；`npm run pack:check` 均退出码 0，打包检查包版本为 2.24.4。 |
| 微信真实消息与页面提问回归 | **PASS** | 用户确认测试来自微信且未触发页面提问；Profile Inbox/Session 记录与完成状态一致，无遗留处理批次。 |

Phase 4 已达到当前 SPEC 阶段门槛，可以进入 Phase 5。此前记录中的“仍有 `pwsh` 审批、批次 processing”是较早时间点的观察，已由后续完成状态取代。实时浏览器面板没有由本次自动化代替；用户已直接完成微信渠道人工测试。

真实渠道人工验收步骤和 F12 阶段日志判读见 `phase-3-4-manual-test.md`。
