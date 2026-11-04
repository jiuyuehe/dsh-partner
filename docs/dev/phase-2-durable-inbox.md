# Phase 2 — Durable Inbox 与游标续读

日期：2026-11-04
分支：`yly-mm-wx-up`
迭代标记：`2.24.0-yly-mm-wx-up.0`
当前包版本：`2.24.1`（本阶段未发布或提升包版本）
Plane：`MM-WX 2.24 | Phase 2 Durable Inbox 与游标续读`

## 结果

P2-01 至 P2-07 的自动化验收通过。真实 Profile 启动后发现两个收件接线缺口：Mattermost 自动发现 DM 没把实际 DM ID 传给入库规范化；微信/Mattermost 的 Durable Inbox 分支没有像旧收件器一样创建待批准联系人。已修复并加入回归测试；真实浏览器复测仍是本次 P2 的下一道验证门槛。

本阶段不调用 Agent、不合并消息语义，也不发送回复。Inbox 中持久化的事件等待 Phase 3 Coalescer/Dispatcher 消费；因此本分支当前阶段的渠道收件验证不等于端到端回复验收。

## 实现范围

| 区域 | 改动 |
| --- | --- |
| `src/inbox/provider.ts`、`src/inbox/durable-inbox.ts` | SQLite Provider 与 Inbox facade；开启 WAL、外键、busy timeout，启动时应用 schema v1，限制数据库文件权限，并提供幂等关闭。 |
| `src/inbox/cursor-repository.ts`、`src/inbox/repository.ts` | 游标与事件/batch Repository；单事务写入一页事件、唯一去重、初始批次及游标；提供原子 claim、lease、settle、retry 和 dead-letter 查询。错误文本会遮蔽 Bearer 与凭据型键值。 |
| `src/inbox/channel-events.ts`、`src/inbox/mattermost-cursor.ts` | 微信与 Mattermost 消息规范化、授权过滤、附件元数据整理，以及 Mattermost 60 秒重叠续读游标；Mattermost 自动发现模式使用已验证入站消息所带的 DM ID。 |
| `src/channels/weixin/poll.ts`、`src/channels/manager.ts` | 微信只有在 Inbox 页面和 `get_updates_buf` 原子提交后才推进进程内 buffer；Mattermost 只有在 REST 页面成功入库后才推进高水位游标。新未批准联系人会生成待审批配对；近期旧版 filtered 事件会在启动时恢复待审批记录。满页响应会拒绝入库并保留旧游标，避免静默跳过积压帖子。两种渠道仍不启动 Agent。 |
| `src/channels/diagnostics.ts`、`src/ui/use-channel-status.ts`、`src/api.ts`、`src/client.tsx` | 本地 DSH 浏览器开发者控制台输出各消息渠道的收件、过滤、入库、配对发送与处理错误；复用现有 `GET /channels/status`，没有新增路由或改变 API 方法。输出不包含机器人令牌、微信 context token 或附件字节，正文预览最多 1000 字符并遮蔽常见凭据格式。 |
| `src/index.ts`、`src/inbox/index.ts` | 插件运行时打开独立的 `partner-channel-inbox.sqlite`，在关闭流程中回收连接并导出 Inbox API。 |
| `test/durable-inbox.test.mjs`、`test/helpers/claim-inbox-worker.mjs` | 新增持久化、恢复、并发 worker 与渠道轮询专项用例。 |

授权检查发生在规范化之前。未批准的微信联系人或 Mattermost DM 发言只写入去除正文/附件/微信回复 token 的 `filtered` 记录，再与游标一起提交；批准的微信事件保留回复路由 token 以便后续渠道适配器恢复使用，该 token 不传给 Agent。

## 验收记录

| 项目 | 状态 | 证据 |
| --- | --- | --- |
| P2-01 SQLite Provider | PASS | WAL、`user_version=1`、重开同一数据库；两个独立 worker thread 同时争抢同一批次，只能一个取得租约。 |
| P2-02 Inbox Repository | PASS | 同一 event 连续提交 10 次只有 1 条记录和 1 个初始 batch；领取、settle 状态更新正确。 |
| P2-03 Cursor Repository | PASS | 页面包含非法 event 时事件与游标都回滚；Mattermost 高水位回退被拒绝；满页轮询异常时已提交游标不变。 |
| P2-04 Lease 恢复 | PASS | 两个 worker 不会同时拥有同一有效租约；过期租约可被新 worker 回收，旧 worker 的 settle 被拒绝。 |
| P2-05 WeChat buffer | PASS（自动化 + 本机 Inbox 观察） | 消息与 `get_updates_buf` 同事务持久化；关闭并重开数据库后恢复 buffer 和事件，重放消息去重。本机旧版已实际保存 2 条 `filtered` 事件且 buffer 游标前进；新版本补上待审批记录恢复。 |
| P2-06 Mattermost cursor | 自动化 PASS；真实 Profile 待复测 | 使用 `since = highWatermark - 60s`；相同毫秒的帖子通过重叠读取补回并按 post ID 去重；空首轮建立水位但不消费历史；满 200 帖的积压页拒绝推进。新回归验证自动发现 DM 的真实 channel ID 被保留并用于回复配对码。 |
| P2-07 Dead Letter | PASS | 按退避时间重试；超过尝试上限进入 dead letter；错误保留诊断信息并遮蔽测试凭据。 |

崩溃边界由事务回滚与关闭/重开测试覆盖：事务提交前 event/cursor 都不可见；提交后重启能恢复二者。专项还覆盖空页、满页、同事件 10 次、两个真实 worker thread 并发 claim、租约过期及 dead letter。

## 实际验证

- `npm run build`：通过。
- `node --test test/channel-diagnostics.test.mjs test/durable-inbox.test.mjs test/weixin-reconnect.test.mjs test/direct-channels.test.mjs`：44 项通过，0 失败；包含诊断脱敏/限量、动态 Mattermost DM ID、微信待审批联系人、配对提示来源路由和旧 filtered 事件恢复回归。
- `npm run pack:check`：通过；npm dry-run 打包完成。
- Mattermost REST 行为在本地 HTTP 模拟服务中验证；没有连接真实 Mattermost，也没有在浏览器中运行 DSH Profile。本阶段的 exit gate 是 Durable Inbox 自动化验收；DSH 中可见的收件/回复行为需 Phase 3 接入消费者后再做端到端验收。

## 2026-11-04 本地 Profile 复测门槛

- 用户报告 `dsh-partner-dev` 正常启动。只读检查本机现存 Inbox 数据时，微信最近两条事件均为 `filtered`、正文已按授权边界清空，微信 buffer 游标已前进，但旧版本没有生成配对申请；新版本启动时会为最近一小时的此类记录恢复待批准联系人。
- Mattermost 真实 DM 尚未由本轮浏览器验证。自动发现消息现在使用每条消息的 `targetId` 作为 conversation/channel ID，避免空配置值阻止游标提交。
- 打开本地 DSH 的「伙伴」工作区并保持页面可见，在浏览器 F12 → Console 查看 `[dsh-partner][渠道][阶段]` 记录。发送新消息时应看到 `message-received`；未授权联系人应看到 `pairing-pending` 和 `pairing-notice-sent`；写入 SQLite 后看到 `inbox-persisted`；失败会以 `console.error` 显示。
- 配对通过后，请联系人再发一条新消息；P2 只保证 `ready` Inbox 持久化，不会调用 Agent 或自动回复。真实浏览器需要确认旧微信申请恢复、Mattermost DM ID 不再报错、授权后新事件进入 Inbox。

## 风险与下一阶段门槛

- Phase 2 尚无 Inbox worker 消费者；当前数据会排队保存在 SQLite，Agent 回复能力留给 Phase 3。
- Mattermost 使用 60 秒回溯与 200 帖单页上限。超过单页上限时保持游标并持续重试，需要外部积压消退或后续分页实现才能恢复。
- WeChat buffer 和 Mattermost 水位原子性针对本地 Inbox 数据库；平台服务端是否按预期重放消息仍需后续真实账号验收。
- Phase 3 开始前应在本分支复核本报告及 Plane 记录；Phase 3 需实现 Coalescer/Dispatcher 并为入队事件设置可恢复的消费策略。
