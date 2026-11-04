# Phase 2 — Durable Inbox 与游标续读

日期：2026-11-04
分支：`yly-mm-wx-up`
迭代标记：`2.24.0-yly-mm-wx-up.0`
当前包版本：`2.24.1`（本阶段未发布或提升包版本）
Plane：`MM-WX 2.24 | Phase 2 Durable Inbox 与游标续读`

## 结果

Phase 2 的 P2-01 至 P2-07 验收通过。插件现在将微信和 Mattermost DM 收件持久化到独立 SQLite Inbox，并在同一短事务中提交事件、初始批次和渠道游标。重复消息不会重复入库；工作领取使用可过期租约；重试耗尽的事件进入可诊断 dead letter。

本阶段不调用 Agent、不合并消息语义，也不发送回复。Inbox 中持久化的事件等待 Phase 3 Coalescer/Dispatcher 消费；因此本分支当前阶段的渠道收件验证不等于端到端回复验收。

## 实现范围

| 区域 | 改动 |
| --- | --- |
| `src/inbox/provider.ts`、`src/inbox/durable-inbox.ts` | SQLite Provider 与 Inbox facade；开启 WAL、外键、busy timeout，启动时应用 schema v1，限制数据库文件权限，并提供幂等关闭。 |
| `src/inbox/cursor-repository.ts`、`src/inbox/repository.ts` | 游标与事件/batch Repository；单事务写入一页事件、唯一去重、初始批次及游标；提供原子 claim、lease、settle、retry 和 dead-letter 查询。错误文本会遮蔽 Bearer 与凭据型键值。 |
| `src/inbox/channel-events.ts`、`src/inbox/mattermost-cursor.ts` | 微信与 Mattermost 消息规范化、授权过滤、附件元数据整理，以及 Mattermost 60 秒重叠续读游标。 |
| `src/channels/weixin/poll.ts`、`src/channels/manager.ts` | 微信只有在 Inbox 页面和 `get_updates_buf` 原子提交后才推进进程内 buffer；Mattermost 只有在 REST 页面成功入库后才推进高水位游标。两种渠道在本阶段都不启动 Agent。满页响应会拒绝入库并保留旧游标，避免静默跳过积压帖子。 |
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
| P2-05 WeChat buffer | PASS | 消息与 `get_updates_buf` 同事务持久化；关闭并重开数据库后恢复 buffer 和事件，重放消息去重。 |
| P2-06 Mattermost cursor | PASS | 使用 `since = highWatermark - 60s`；相同毫秒的帖子通过重叠读取补回并按 post ID 去重；空首轮建立水位但不消费历史；满 200 帖的积压页拒绝推进。 |
| P2-07 Dead Letter | PASS | 按退避时间重试；超过尝试上限进入 dead letter；错误保留诊断信息并遮蔽测试凭据。 |

崩溃边界由事务回滚与关闭/重开测试覆盖：事务提交前 event/cursor 都不可见；提交后重启能恢复二者。专项还覆盖空页、满页、同事件 10 次、两个真实 worker thread 并发 claim、租约过期及 dead letter。

## 实际验证

- `npm run build`：通过。
- `node --test test/durable-inbox.test.mjs test/weixin-reconnect.test.mjs test/direct-channels.test.mjs`：39 项通过，0 失败。
- `npm run pack:check`：通过；dry-run 清单包含 Phase 2 文档、已编译 Inbox 模块和 up/down SQL migration。
- Mattermost REST 行为在本地 HTTP 模拟服务中验证；没有连接真实 Mattermost，也没有在浏览器中运行 DSH Profile。本阶段的 exit gate 是 Durable Inbox 自动化验收；DSH 中可见的收件/回复行为需 Phase 3 接入消费者后再做端到端验收。

## 风险与下一阶段门槛

- Phase 2 尚无 Inbox worker 消费者；当前数据会排队保存在 SQLite，Agent 回复能力留给 Phase 3。
- Mattermost 使用 60 秒回溯与 200 帖单页上限。超过单页上限时保持游标并持续重试，需要外部积压消退或后续分页实现才能恢复。
- WeChat buffer 和 Mattermost 水位原子性针对本地 Inbox 数据库；平台服务端是否按预期重放消息仍需后续真实账号验收。
- Phase 3 开始前应在本分支复核本报告及 Plane 记录；Phase 3 需实现 Coalescer/Dispatcher 并为入队事件设置可恢复的消费策略。
