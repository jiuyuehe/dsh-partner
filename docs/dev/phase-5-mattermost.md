# Phase 5 — Mattermost DM、频道与 Thread

## 2.24.22 伙伴身份与 DSH 默认模型身份冲突修正（2026-11-06）

- **根因：** DSH 默认的 Harness 身份和“coding agent powered by [model]”提示只在可选“角色聊天”开关开启时才从提示词投影中移除；伙伴自己的长期行为准则则始终注入。开关关闭时，两套身份会同时进入模型请求，可能诱发截图中的模型/运行环境自我介绍。截图没有显示角色聊天开关状态，所以这里记录的是已确认的代码路径，不推断截图当时开关值。
- **修正：** `src/character/prompt-projection.ts` 对伙伴会话始终移除 DSH 原样默认身份句，只匹配两个已知默认句；用户自定义的身份文本和预设、DSH 工具说明、安全规则、交付规则均保留。伙伴顶层“长期行为准则”仍由 `renderPartnerPersona` 注入，不依赖可选角色聊天开关。
- **回归覆盖：** `test/persona-projection.test.mjs` 覆盖可选角色开关关闭时仍去除原样默认模型身份、同时保留伙伴身份及安全/交付说明；另验证用户编辑过的 DSH 身份保留。`test/partner-prompt-readiness.test.mjs` 覆盖实际 DSH 提示词组装。
- **验证：** `npm run build` 通过；`node --test test/persona-projection.test.mjs test/partner-prompt-readiness.test.mjs test/character-preview.test.mjs test/mattermost-phase5.test.mjs test/mattermost-continuity.test.mjs test/durable-inbox.test.mjs`：102/102 通过。`npm run pack:check` 与 `npm run pack:verify` 通过。
- **运行状态：** 复用 `dsh-partner-dev` Profile 重启后，43128 由 PID 59660 监听；Profile 插件 junction 指向 `D:\yliyun_project\dsh-partner-yly-mm-wx-up`，其 `package.json` 为 v2.24.22。启动日志未见启动失败或插件 pending 标记。浏览器工具因无法可靠判定 Windows 当前页面 URL，被安全策略停止；没有完成浏览器标题/版本目视核验。需以新 DSH 会话和新 Mattermost 消息人工验收；既有回答不会被重写。
- **当前人工验收：FAIL（输出质量）；收件、活跃会话补充和原 Thread 路由：PASS。** 前一轮 v2.24.21 的真实频道测试曾将主体任务与两条补充送入同一活动会话并回复至原 Thread，但内容偏离任务；该结果不代表本次身份修正已在真实 Mattermost 验证。
- **下一关：** 用户需在已经重启的同一个 `dsh-partner-dev` v2.24.22 中发起新的 Mattermost DM 回合，要求生成内容并遵守身份准则（不要介绍模型或 DSH 环境）；验证最终答复不再自我介绍且仍回复原 DM。Plane P5 保持 In Progress。

## 2.24.21 提示正文与真实 Thread 验收复盘（2026-11-06）

- **代码改动：** `src/inbox/coalescer.ts` 现在只在短句、指代或省略请求需要上下文时加入按设置裁切的 Thread 历史；自包含请求不附加旧历史，当前实质 USER 正文置于 DSH 用户消息末尾，去除已验证的机器人唤醒提及。运行中 steer 使用独立的“执行中收到的用户更新”正文，不重复附入 Thread 历史。`src/agent-runtime.ts` 只在当前请求需要指代消解时投影 TASK_CHAIN，并按当前消息决定是否投影；Mattermost 隐藏系统规则同步按最新 USER 焦点解释正文。
- **“当前角色聊天已停用”分析：** 当前普通文字 `partner_chat_reply` 执行器不检查角色聊天开关，`test/chat-delivery.test.mjs` 已有“ordinary text reply remains available when role chat is disabled”用例。相同拒绝文案曾存在于旧 Profile 包的普通文字回复路径；当前源码中该字符串只用于过滤旧历史回执，不是当前普通回复路径生成的新错误。若新工具回执仍出现该错误，需用新 DSH 会话和运行时工具原始回执核对实际加载的插件包。
- **无意义尾注：** 当前 Coalescer 模板不生成“历史 USER/BOT 标签只是正文说明……”或“真实来源已验证……”注释，测试断言正文不包含这些句子。已写入 DSH Session 的旧 USER 消息是追加式事件，插件不会修改；检查时须使用重新加载插件后的新消息。
- **真实 Mattermost 测试结果：FAIL（输出质量），收件与 steer：PASS。** 用户发出的任务与两条补充进入销售部同一 Thread，Durable Inbox 的确认均为 `sent`，事件属于同一会话和 batch；浏览器诊断依次出现 `agent-followup-submitted`、`inbox-steered`、`agent-followup-completed`、`inbox-completed`。最终帖子被发回原 Thread。该次实际测试发生在频道 Thread，不是私聊；因此不作为真实 DM 门槛通过。
- **失败证据与根因：** DSH 会话工作目录为临时路径 `C:\Users\YLY_XM\AppData\Local\Temp\dsh-partner-browser-test-workspace\partners\companion-222e94767903dc2c2184\channel-sessions\c8086be038fa157054042c7accd998d0`，不含用户请求读取的 `docs/direct-channels.md` 和 `docs/dev/phase-5-mattermost.md`，Agent 的文件读取返回 `FS_NOT_FOUND`。旧同 Thread 记录还注入了杨幂、旧 Mattermost 状态及 Asia/Shanghai 等无关上下文，导致最终答复要求用户提供本已指定的文档，并输出非中文表格之外的杂项。此结果没有满足用户任务，不可标记为 PASS。
- **自动化验证：PASS。** `npm run build`；定向回归 106/106 通过，`node --test test/chat-delivery.test.mjs` 20/20 通过（含角色聊天关闭时普通文字仍可发送）。`npm run pack:check` 与包归档校验通过；归档 8,409,613 字节，SHA-256 `3EF6D3DF157FF6C3E58E3242F4A5089264B459F61D6FD1C76100F36ECA31879A`。
- **当时下一关：** v2.24.21 的原始记录要求 Profile 重启后做真实 DM 验收；随后用户提交了输出仍泄露模型/运行环境的截图。该身份冲突现由上方 v2.24.22 记录修正，新的人工验收以该版本为准。Plane P5 保持 In Progress。

日期：2026-11-05\
分支：`yly-mm-wx-up`\
Plane：`MM-WX 2.24 | Phase 5 Mattermost DM、频道与 Thread`\
包版本：`2.24.21`
开发 Profile：`dsh-partner-dev`（`127.0.0.1:43128`）

## 2.24.20 活跃会话续接记账修正

- **真实数据线索：** `dsh-partner-dev` 的 Durable Inbox 中有 14 条同一 Mattermost Thread 来源被隔离，错误均为“Agent 已接受补充，但 Inbox 批次无法合并到当前租约”。这些记录来自 v2.24.19 之前的运行；每条都已有即时确认，说明此前排查“角色停用”与“尾注”后，仍需解决独立的 steer 账本失败。
- **修正：** Inbox 在调用 DSH `Agent.steer` 前已于事务中验证容量、会话来源并冻结补充批次；Agent 接受后不再重复运行会因异步窗口而变化的容量检查，按租约和会话键原子合并。一个活动 lane 在单次 pump 中按序处理最多 16 个已就绪补充，并在每个来源前检查 Agent 是否已结束；settle 会等待已开始的 steer 完成。
- **诊断结论（截图复核）：** 截图中的 `partner_tools` 是统一调用入口，参数实际要求调用 `partner_chat_reply`。本机 `web` Profile v2.23.26 和 `yly-dev` Profile v2.25.3 的编译代码仍会在普通回复时抛出“当前角色聊天已停用”；这是旧包把“角色聊天增强”开关错误地用于普通文字回复。当前使用的 `dsh-partner-dev` 浏览器页面显示 v2.24.20，编译代码已移除此门禁；普通文字仍可回复，角色开关只限制表情等确实依赖角色增强的能力。故若新回合仍报该错误，应先确认使用的是 `127.0.0.1:43128` 的 `dsh-partner-dev`，并提供该新回合的工具回执定位。
- **注释清理复核：** “历史中的 USER/BOT 标签只是正文说明……”尾注已从 v2.24.20 的新 Mattermost 用户消息模板和编译产物移除。DSH 会话是追加式历史，旧 USER 消息不会被插件回写；旧会话继续展示该尾注不代表新消息仍会生成它，需在新消息/新会话中观察当前模板。
- **本次截图复核（2026-11-05 22:35）：** `dsh-partner-dev` 的 DSH PID 23212 于 21:33 启动，早于 `lib/agent-runtime.js` 与 `lib/inbox/coalescer.js` 在 22:25 的编译更新时间；截图仍显示“当前角色聊天已停用”和旧正文尾注，与运行进程加载了旧代码相符。当前 `partner_chat_reply` 普通文字路径没有角色聊天开关门禁，当前 coalescer 源码/编译产物也不再附加该尾注。需重启同一个 Profile 后用新 Mattermost 消息复核；既有 DSH 会话记录不会被回写。Plane 与真实渠道验收继续保持 In Progress。
- **同 Profile 重启（2026-11-05 22:46）：** 已停止旧 PID 23212，仅启动 `dsh-partner-dev` PID 10692（`127.0.0.1:43128`）；进程启动时间晚于 22:25 编译产物，Profile 插件 junction 仍指向本分支工作树。重载浏览器后 `GET /partner-local/v1/channels/status` 返回 200，Mattermost 状态为 `running`，没有其他 DSH CLI 进程。Inbox 中帖子 `qg4pbtb153dgtjy183yaa4ze9e` 已在重启前完成且确认送达，因此不算新代码人工验收。Mattermost 将 Thread 根帖的 `update_at` 更新到最新回复时间；时间游标重叠会每轮再次读到该旧根帖，当前 Inbox 以唯一帖子 ID 去重，不再确认或执行 Agent，但 `message-received` 诊断会重复显示。重启后尚无新用户帖子；普通回复工具和新正文尾注的真实复核、以及活跃 Agent steer 的 DM/Thread 复核仍待新消息。
- **当前复核（2026-11-05）：** `npm run build` 通过；`node --test --test-reporter=tap test/direct-channels.test.mjs test/direct-media.test.mjs test/durable-inbox.test.mjs test/inbox-model.test.mjs test/inbox-session-router.test.mjs test/channel-task-handoff.test.mjs test/channel-question-tool.test.mjs test/channel-reply-deliverability.test.mjs test/reply-progress.test.mjs test/mattermost-phase5.test.mjs test/mattermost-continuity.test.mjs test/partner-prompt-readiness.test.mjs test/chat-delivery.test.mjs test/tool-discovery.test.mjs`：192/192 通过。覆盖 Bot 校验、双人 DM、多成员频道、白名单与 @过滤、Thread/Session 隔离、附件归属、发言人授权，以及同一 DM/Thread 活跃时连续补充使用原生 steer、不另开 FIFO turn。
- **打包检查：** `npm run pack:check`、`npm run pack:verify -- 'C:\Users\YLY_XM\AppData\Local\Temp\dsh-p5-audit-v22420\lemoncat7-dsh-partner-2.24.20.tgz'` 通过。归档 SHA-256 与字节数记录在 Plane P5 issue 评论；当前打包检查不作为真实 Mattermost 人工验收的替代。
- **真实渠道状态：BLOCKED / 待用户新消息。** 目前尚未用 v2.24.20 在真实 Mattermost 验证一轮新 steer。所有历史死信均保留为诊断证据，不自动重放，避免对旧帖子重复执行。
- **下一关：** v2.24.20 已构建、打包并在同一个 `dsh-partner-dev` 浏览器中确认版本；自动化与本地页面通过，尚未通过真实 Mattermost 新回合验收。由已批准用户在真实 Mattermost 发起一条新长任务，并在运行中连续发两条同 Thread 补充，确认 Console 有序记录两次插入，最终回复回到原 Thread。P5 保持 In Progress。
- **再次复核（2026-11-05 23:06 Asia/Shanghai）：** 实际 Chrome 页面仍显示 `伙伴 v2.24.20`；`npm run build`、Mattermost/Inbox 定向回归（192/192）、`npm run pack:check` 与 `git diff --check` 通过。PID 10692 仍为 `dsh-partner-dev` 的唯一 DSH 进程。DSH 当前选中的会话仍展示重启前的旧工具拒绝和旧 USER/BOT 尾注；这些是追加式历史，不能用来证明新版本仍在输出。Inbox 数据库确认 22:46:34 重启后没有新 Mattermost 用户事件，最新的 `p5-role-reply-20261105` 也早于重启。因此普通文字回复修复、尾注移除和活动 Agent `steer` 尚缺新帖子实测；P5 继续 In Progress，下一关是已批准用户发起新 DM，并在运行期间补发两条消息。
- **刷新后浏览器复核（2026-11-05 23:13 Asia/Shanghai）：** 通过 Playwright 刷新 `127.0.0.1:43128` 后，伙伴侧栏、渠道在线数和 v2.24.20 均正常显示；新页面 Console 为 0 errors / 0 warnings。刷新前读到的 4 条 `Cannot use import statement outside a module` 在新页面未复现，不能归因于当前页面。旧会话中的错误答复和尾注仍保留；重启后的 Mattermost Inbox 仍无新用户帖子，因此真实 DM/Thread/steer 验收尚未通过。
- **全量回归复核：** 补齐绕过构造函数的两个测试夹具中 `channelQuestionContexts` Map 后，`test/conversation-context.test.mjs` 与 `test/role-conversation.test.mjs` 单独回归 22/22 通过。随后执行 `npm run build` 与 `node --test --test-reporter=tap test/*.test.mjs`，全仓 1377/1398 通过、21 失败；Mattermost P5 定向组仍为 192/192 通过。剩余失败主要涉及 Windows symlink `EPERM`、POSIX 路径断言、Windows 下 `python3` 命令不可用，以及附件长度、CSS、心跳内容和 SQLite 路径等其他模块断言；没有逐一证明它们都是环境问题，因此全仓测试状态记为 FAIL，不能宣称全量通过。
- **打包复核：** 最近一次 `npm run pack:check` 对 v2.24.20 通过，打包清单 2909 个文件；`git diff --check` 通过，仅报告 LF/CRLF 转换提示。

## 2.24.19 历史停用误导修正

- 历史 DSH 会话可能保存旧版把普通文字回复错误地归因于“角色聊天”开关的助手回复或工具结果。Mattermost 隐藏系统规则现在明确将这类旧拒绝视为过时错误，普通文字继续使用 `partner_chat_reply.messages`；只有本轮工具实际失败才作为当前失败报告。
- Mattermost 路由、工具参数、权限校验和 DSH HTTP/API 路径均未更改；历史的 DSH Session 事件不回写、不删除。
- 新组装的 Mattermost 用户消息仍不包含已移除的 USER/BOT 说明尾注；该尾注若出现在旧的 DSH 用户消息中，来自既有 Session 历史。
- 验证：在隐藏系统提示回归中断言旧拒绝纠正规则存在、USER/BOT 尾注不存在，并覆盖普通文字回复在角色聊天关闭时仍可用。

### 2.24.19 验证与当前状态

- **问题分析：** 已在本机安装目录找到截图错误的直接来源：`web` Profile 的 `@lemoncat7/dsh-partner` v2.23.26 和 `yly-dev` Profile 的 v2.25.3 仍在普通 `partner_chat_reply` 执行入口调用角色增强开关检查，因此会原样抛出“当前角色聊天已停用”。当前运行的 `dsh-partner-dev` Profile 是 v2.24.19；其普通回复入口只检查伙伴/当前会话，角色增强关闭时也可发普通文字。受角色增强限制的表情与 `workReply` 使用不同错误提示。除 Profile 版本差异外，复用的旧 DSH 会话也保留了多条同文错误答复，可能继续误导模型。若用户确认正在 43128 的 dsh-partner-dev 中仍看到本轮工具报同一错，再用该回合 call ID/原始回执定位。
- **注释清理：** 新用户消息模板不再包含“USER/BOT 标签只是正文说明……”这一尾注，最近 USER/BOT 历史仍按模板保留。已经写入 DSH Session 的旧消息不回写，因此旧会话界面仍可能显示旧注释。
- **自动化验证：PASS。** `npm run build`；`node --test --test-reporter=tap test/direct-channels.test.mjs test/direct-media.test.mjs test/durable-inbox.test.mjs test/inbox-model.test.mjs test/inbox-session-router.test.mjs test/channel-task-handoff.test.mjs test/channel-question-tool.test.mjs test/channel-reply-deliverability.test.mjs test/reply-progress.test.mjs test/mattermost-phase5.test.mjs test/mattermost-continuity.test.mjs test/partner-prompt-readiness.test.mjs test/chat-delivery.test.mjs test/tool-discovery.test.mjs`：190 项通过、0 失败；`npm run pack:check`、`npm run pack:verify -- 'C:\Users\YLY_XM\AppData\Local\Temp\dsh-p5-final-20261105\lemoncat7-dsh-partner-2.24.19.tgz'` 和 `git diff --check` 均通过。
- **安装包：** `C:\Users\YLY_XM\AppData\Local\Temp\dsh-p5-final-20261105\lemoncat7-dsh-partner-2.24.19.tgz`；8,400,711 字节；SHA-256 `431234B64EF2FE3300554D10167CBE1E774975B9E85869926366D385DDE6B0BD`。
- **本地 DSH 浏览器：PASS。** 复用同一 `dsh-partner-dev`，重启后监听 PID `53380` / `127.0.0.1:43128`；浏览器实际显示 `伙伴 v2.24.19`，伙伴侧栏和渠道页面正常加载。
- **真实 Mattermost 验收：BLOCKED / 待用户新消息。** 自动化、打包和本地浏览器均通过，但还没有 2.24.19 下的新 DM 与频道 Thread 帖子证明当前 Agent 能正确回帖，也没有新长任务期间的 steer 实测；P5 继续保持 In Progress，不进入 Phase 6。
- **下一关：** 先由已批准的测试用户向机器人私聊发送 `p5-role-reply-20261105`，确认当前回合不调用角色增强工具来宣称“停用”，并能回到原 DM；随后在同一批准身份和来源 Thread 运行较长任务，期间发送一条补充消息，确认 Console 有 steer 阶段记录且最终回复仍投递到原 Thread。失败时记录本轮 call ID、工具原始回执和帖子/Thread ID。

## 2.24.18 活跃会话直插

- **到活跃 DSH 会话的路径：** Mattermost 活跃来源现在可在静默合批窗口到期前读取队首补充；同一获准 DM 发言人或同一精确 Thread 的消息立即尝试 DSH 原生 `Agent.steer`，不再等 30 秒。
- **未接受处理：** 对已经匹配的 Mattermost 活跃来源，DSH 明确未接受 steer 时将持久化批次隔离并输出失败诊断，不自动释放为后续 FIFO 回合。跨发言人或跨 Thread 消息不插入其他 Agent。
- **DSH 时序边界：** `Agent.steer` 进入 `next-step`，当前模型或工具步骤完成后才处理；它不会抢占当前步骤，也不承诺立刻产生回复。
- **定向验证：** 新增测试覆盖 30 秒窗口内直插活跃会话、被拒绝时不启动第二个 turn，以及微信旧 FIFO fallback 保持不变。详细执行结果见本节后续验证记录。

## 2.24.16 修正记录

- **旧错误解释修正：** 隐藏的 Mattermost 指导明确说明旧版本曾把普通文字回复错误地受角色开关限制；模型不能把旧 `当前角色聊天已停用` 回执当成本轮状态，只有本轮实际工具回执才代表本轮发送结果。
- **正文噪音：** USER/BOT 来源注释已从新组装的 DSH 用户消息中移除；已有持久化会话不会被改写。
- **验证：** `node --test --test-reporter=tap test/tool-discovery.test.mjs test/chat-delivery.test.mjs test/durable-inbox.test.mjs`：86 项通过；仍需真实 Mattermost DM/Thread 手工确认，Phase 5 不因此关闭。

## 2.24.17 修正记录

- **停用提示根因收敛：** 普通文字 `partner_chat_reply` 在工具实现与统一工具入口中都不受角色聊天增强开关限制；新隐藏指导只要求经 `partner_chat_reply` 回复，并说明 DSH 旧轮次工具结果不代表当前状态，不再向模型重复展示旧错误原文。工具仍在执行时核验当前会话和渠道授权。
- **任务焦点降噪：** 当前用户正文开头的唤醒提及不会重复写成“当前唤醒消息”；同批纯提及不再列为补充。只使用去掉提及后长度大于两个有效字符的正文作为任务，无法找到时保留单问题澄清与 `task-focus-fallback` 诊断。
- **历史配对修正：** 纯提及历史从 USER/BOT 轮次中移除；重复机器人答复只在相邻重复时去重，不会因为两个不同用户轮次的短答复内容相同而错删前一轮。
- **验证：** `npm run build`；`node --test --test-reporter=tap test/durable-inbox.test.mjs test/partner-prompt-readiness.test.mjs test/chat-delivery.test.mjs test/tool-discovery.test.mjs test/mattermost-continuity.test.mjs test/mattermost-phase5.test.mjs`：123 项通过。普通回复在关闭角色聊天增强后通过 `partner_tools` 的自动化路径已验证；真实 Mattermost 端到端仍需人工消息确认，Phase 5 保持打开。
- **旧注释说明：** “USER/BOT 标签只是正文说明……”尾注已不在新消息模板中；旧 DSH 会话里已保存的历史消息不会被插件重写。

## 2.24.15 修正记录

- **停用提示定位：** 普通文字 `partner_chat_reply` 不再受“角色聊天”增强开关拦截；该开关仍单独约束角色表情和 `workReply`，这两条路径的错误现在会说明具体受限功能并引导使用普通文字回复。隐藏 Mattermost 系统规则也说明：历史中的停用错误不是当前状态，不能用来拒绝新问题。
- **提示正文降噪：** 组装后的 DSH 用户消息正文不包含“程序已验证来源、频道/Thread/post ID 仅供定位”的额外注释；来源校验继续留在插件侧，DSH 的原生系统提示和工具 schema 仍负责系统规则与工具调用约束。
- **定向验证：** `npm run build`；`node --test test/tool-discovery.test.mjs test/partner-prompt-readiness.test.mjs test/durable-inbox.test.mjs test/chat-delivery.test.mjs test/work-expression.test.mjs`：176 项通过，覆盖统一入口下角色聊天关闭仍可发送普通文字、可选表情/workReply 错误准确、旧停用回执与冗余注释不会成为新历史；`npm run pack:check` 通过并包含 v2.24.15 构建。
- **实际页面复核：PASS（版本）。** 重启同一 `dsh-partner-dev` Profile 后，浏览器伙伴入口显示 `v2.24.15`；此次未在 DSH 中创建测试消息。真实 Mattermost DM/Thread 的普通文字回复及入站消息还需人工发一条新消息确认，Phase 5 保持未完成。

## 历史验证状态（2026-11-05，2.24.14）

- **上下文设置：已实现。** Mattermost 配置页可设 Thread 历史轮数，默认 3，范围 0–10；每个事件保存本次采用的设置，升级时缺失字段回退到 3。
- **任务焦点与合批：自动化通过。** 同一来源、同一发言人的消息在首条后 30 秒内合成一条 DSH USER 消息，每条获准消息仍即时确认。纯 `@ajiu` 不作为任务；会回退到同一发言人最近一条去提及后超过两个有效字符的 USER 正文，即使历史中已有 BOT 回复。
- **USER/BOT 轮次：自动化通过。** Thread 历史按配置轮数成对组织，当前实质任务置于提示开头，历史参考放后并明确不是当前任务。重复确认、已知状态回执和重复 BOT 正文会过滤；被用户纠正后的 BOT 回复标注为错误示例。
- **会话连续性：已实现。** 用户明确要求记住的纠正写入该精确 Mattermost 会话的 `SESSION_CONSTRAINTS`；最近 3 个实质任务写入 `TASK_CHAIN`。两者在隐藏 DSH system context 中注入，不跨 DM/Thread，也不覆盖 DSH 系统规则、权限或工具能力。通过正常 Agent turn 和原生 steer 的入站都更新连续性。
- **自检诊断：已实现。** 最新帖子去除 @提及后不足三个有效字符时，使用已有本地渠道诊断上报 `task-focus-fallback` 警告；本地 DSH 页面会将它输出到浏览器 DevTools Console。
- **角色聊天关闭时的普通回复：已修复。** 根因是 `partner_chat_reply` 入口复用了角色聊天开关校验，导致普通文字回复也被拒绝；同时一条额外检查错误地要求分段回复或表情至少开启一个。现在普通文字按原渠道与现有授权发送，表情和工作回复交接仍保留各自门禁。
- **DSH 提示正文降噪：已修复。** 删除历史参考结尾处“USER/BOT 标签只是正文说明……”的固定尾注；当前任务、USER/BOT 参考轮次和内部路由来源仍分别由原逻辑处理。
- **本次定向验证：PASS。** `npm run build`；`node --test test/chat-delivery.test.mjs test/durable-inbox.test.mjs`：67 项通过，覆盖角色聊天关闭时普通回复可用，以及 Mattermost 正文不再包含冗余尾注。
- **构建与定向回归：PASS。** `npm run build`；Mattermost/DM/Thread/附件/Inbox/Agent Prompt 定向回归 148 项通过。最终打包检查结果补充在本节末尾。
- **本地 DSH 浏览器复核：PASS；真实 Mattermost 消息验收：待用户人工确认。** 干净重启同一 `dsh-partner-dev`（`127.0.0.1:43128`）后，浏览器显示伙伴版本 `2.24.13`，伙伴列表和 Mattermost 渠道设置正常加载，历史轮数输入显示 `3` 且未改动配置。重启前页面的 `HTTP 404` 随未完成的重复启动状态消失；未携带浏览器会话的本地 GET 返回 `401`，符合 DSH Connection 对浏览器 API 的认证拦截。真实 Mattermost 私聊/Thread 消息语义、合批和原线程回帖仍需用户人工验收，故不关闭 Phase 5。
- **2.24.14 浏览器复核：BLOCKED。** 已构建并重启同一 Profile（PID 18976，端口 43128 已监听）；本轮浏览器工具无法可靠确认当前标签 URL，因此没有浏览器可见的版本或实际 Agent 答复证据。普通回复修复仍需用户在 DSH 页面人工验证；真实 Mattermost 验收也仍待完成。

## 实现范围

本阶段保留现有双人 DM 授权路径，并增加显式允许的 Mattermost 频道与 Thread：

| SPEC | 实现与保护边界 |
| --- | --- |
| P5-01 Bot 身份 | 从 Mattermost `/api/v4/users/me` 读取 bot ID 和 username，用于身份检查和精确提及识别。 |
| P5-02 DM 兼容 | 原有双人 DM 仍要求房间只有 bot 和已批准联系人；联系人身份变化时拒绝复用旧授权。 |
| P5-03 多成员频道 | 频道传输单独标记为频道/Thread 模式，验证公开或私有频道类型及 bot 成员关系。 |
| P5-04 频道白名单 | 只处理显式配置的 channel ID；白名单外或无白名单的频道失败关闭。升级前创建、尚未保存频道目录的配置可从现有设置页重新读取机器人已加入的频道。 |
| P5-05 精确 @ | 接受 Mattermost metadata 中 bot user ID，或边界明确的 `@username`；`@ajiux` 等前缀相似文本不触发。 |
| P5-06 Thread Root | 顶层提及以原 post 为 thread root；线程里的后续消息也必须明确 @机器人，才会进入 Inbox，并保留来源 root。 |
| P5-07 Thread Session | 以账号、渠道配置、channel ID 和 root ID 隔离会话及记忆；同一 Thread 的获准协作者共享该 Thread 会话。 |
| P5-08 Thread 回复 | 获准提及、附件帖和进度卡均通过原 channel ID 与 root ID 回到来源 Thread；未 @机器人的频道帖子和线程回复不进入 Inbox。 |
| P5-09 多人授权 | 每条消息保留 actor ID；频道中每位发言人独立审批，撤销后不再执行或回复。 |
| P5-10 附件 | 从来源帖子读取 file ID；下载前校验 Mattermost 文件属于当前获准频道，附件上传后再发送带 file ID 的帖子。 |
| P5-11 执行中续接 | 同一获准发言人向同一 DM 连续发普通消息，或在频道精确 Thread 中再次 @机器人时，使用 DSH 原生 `steer` 插入正在运行的 Agent；正文语义由 Agent 判断，跨用户/来源隔离。 |

频道消息继续复用插件现有 Mattermost 路由与标准 REST API，不新增 DSH Host 服务或自定义 HTTP 路径。Mattermost 官方 [`posts?since=` 文档](https://docs.mattermost.com/api/reference/get-posts-for-channel)说明它会返回该时间之后修改的帖子；请求参数没有只按 bot mention 过滤的选项。因此传输层只把明确提及 bot 的帖子交给 Inbox，非提及帖子只用于推进游标，不保存正文、不建立批次、不触发 Agent。事件去重使用稳定的帖子内容版本，不使用会随线程活动变化的 `update_at`，防止机器人在线程中的回复把根帖重新触发。收件、游标、上下文和授权状态存入现有 Durable Inbox；各 DM/频道独立续读。

## 自动化验证记录

以下命令在 `yly-mm-wx-up` 工作区执行：

- `npm run build`：通过（TypeScript 和客户端构建成功）。
- `node --test test/direct-channels.test.mjs test/direct-media.test.mjs test/durable-inbox.test.mjs test/inbox-model.test.mjs test/inbox-session-router.test.mjs test/channel-task-handoff.test.mjs test/channel-question-tool.test.mjs test/channel-reply-deliverability.test.mjs test/reply-progress.test.mjs test/mattermost-phase5.test.mjs test/mattermost-continuity.test.mjs test/partner-prompt-readiness.test.mjs`：本次运行 148 项通过、0 失败。新增覆盖提及过滤、同发言人 30 秒合批、已答复后纯提及回退、USER/BOT 配对历史、纠正持久约束、三任务链、可配置轮数与浏览器 Console 焦点警告。
- `npm test`：1372 项中 1343 通过、29 失败。当前失败项包含 Windows 下创建符号链接的 `EPERM`、POSIX 路径断言，以及内存/会话和桥接进程用例；未逐项证明所有失败均由环境造成。失败清单中没有 Mattermost Phase 5 定向用例；该全量套件仍为红，不能据此宣称全仓验证通过。
- `node --test test/chat-delivery.test.mjs`：此前 18 项通过、1 项因 Windows 临时 SQLite 文件 `EBUSY` 失败；Mattermost 频道回复授权覆盖在定向回归中通过。
- `npm run pack:check`：通过，归档清单包含 2.24.13 发布说明、Phase 5 文档及 Inbox 迁移。
- `npm pack --pack-destination $env:TEMP` 与 `npm run pack:verify -- <2.24.13 tgz>`：通过；归档 8,396,049 字节，SHA-256 `F1EC34E4E1B7D1A54BD42A2EAEDE710641DC5E55ECD9BAFEF10385D93DF127F4`。真实 Mattermost 验收仍待人工完成。

## 复用现有 Profile 的人工验收

`dsh-partner-dev` Profile 的 `@lemoncat7/dsh-partner` 依赖链接到当前分支目录。不要新建 Profile 或清空数据。重新构建后使用同一 Profile 重启，页面和伙伴面板应显示当前包版本。

先在仓库目录生成构建。当前开发 Profile 已链接到本分支，无需重复安装或切换 Profile：

```powershell
Set-Location 'D:\yliyun_project\dsh-partner-yly-mm-wx-up'
npm run build
```

按现有机器配置，从启动 DSH 的 PowerShell 窗口启动相同 Profile：

```powershell
Set-Location 'C:\Users\YLY_XM\.dsh'
node 'C:\nvm4w\nodejs\node_modules\@deepseek-ai\dsh\lib\bin.js' --profile dsh-partner-dev --no-open --host 127.0.0.1 --port 43128
```

打开 `http://127.0.0.1:43128/`。检查左侧“伙伴”入口刷新、切换页面和新建会话后仍可见，Console 不再出现 `removeChild` / `slot entry crashed in 'sidebar'`。左侧标题与面板顶栏应与 `package.json` 当前版本一致。Mattermost 设置应显示“Thread 历史轮数”，默认 3，可保存 0–10；入站 DSH 消息先突出本轮实质任务，再附所设 USER/BOT 历史。DevTools 的 Console 保持可见，确认 `poll-page`、`message-received`、`inbox-persisted`、`inbox-steered` 与 `task-focus-fallback` 等记录能按序输出；最后核对回复仍回到来源 DM 或原 Thread。

Mattermost 渠道恢复按钮验收：进入伙伴面板 → 渠道 → Mattermost 配置。已停用时，底部应显示“启动并连接”；点击后状态应经过“连接中”变为“已连接”。如果渠道仍启用但状态为“已停用”或“连接异常”，底部应显示“重新连接”。完成后用一条新的已授权 DM 或明确 `@ajiu` 的允许频道消息确认收件恢复。

浏览器复核 `dsh-partner-dev` 使用 `v2.24.5` 时发现：销售部虽然出现在机器人已加入的频道目录里，但未勾选；它因此不在插件运行时白名单，原测试帖没有进入收件流程。按用户要求在真实 DSH 设置页勾选并保存销售部。随后该帖进入频道收件，联系人界面显示销售部频道授权待批准；DM 批准不会覆盖频道授权。

这次真实收件又暴露出重复处理：同一顶层帖在数据库中因 `update_at` 反复变化形成多个外部事件与批次，并不断发送重复确认。已在浏览器中停用 Mattermost 渠道止住循环；修复版 `v2.24.6` 已在同一 Profile 加载并通过本地浏览器版本核验。当前 Profile 中销售部已在频道白名单，测试联系人的 DM 已授权，但销售部频道权限仍显示待批准。Mattermost 仍保持停用；先由用户重新启用并批准已有的销售部频道权限，再发送新的 `@ajiu` 测试帖。旧帖不会作为新测试重放。

### Mattermost 验收用例

请使用已配置的测试 bot 和已批准的测试联系人，不要把令牌放入命令、截图或 Plane 评论。以下用例均在 `dsh-partner-dev` 中完成：

1. **既有 DM**：私聊中发送唯一测试词，确认获准 DM 仍按联系人授权执行并回复同一 DM。
2. **允许频道显式 @**：若旧配置未显示频道复选框，先点“读取机器人已加入的 Mattermost 频道”，随后勾选测试频道并保存。顶层帖子或线程回复明确 `@机器人`；未审批发言人应只产生待审批记录；批准后由该发言人发送新的测试帖子，确认进入 Agent。
3. **频道拒绝条件**：普通未提及帖子、未 @机器人的线程回复、`@机器人名` 的前缀相似名字、白名单外频道，以及已撤销授权的发言人都不写入 Inbox、不执行 Agent，也不发送处理确认。
4. **Thread 上下文与隔离**：对允许频道的顶层帖子明确 @机器人，再在同一 Thread 明确 @机器人补充；另开 Thread 并明确 @机器人询问不同内容。确认各自历史不混用，回复都落在各自原 Thread；机器人自己的回复不能重新入队。
5. **多人 Thread 授权**：同一 Thread 中让另一个未审批成员 @机器人，确认先进入独立审批；批准后才可执行，并继续使用同一 Thread 会话。另一个 Thread 的 Session/记忆应独立。
6. **附件回归**：在允许频道/Thread 发一张图片或文件；确认只读取来源频道中的文件 ID。让 Agent 回传一个允许的附件，确认消息包含 file ID 且落到原 Thread。
7. **授权撤回**：撤销一个已批准成员后，让该成员发新的 @ 帖子；确认不会调用 Agent 或回复。恢复授权须由新的审批明确完成。
8. **执行中连续消息**：在同一已批准 DM 中启动一个耗时任务，Agent 仍运行时从同一用户连续发送两条普通消息（不加“补充/更正/追加”前缀）；频道 Thread 则在每条后续消息中明确 @机器人。确认 Console 显示对应 `inbox-steered`，来源 message ID 与批次数量可关联，当前 DSH 不为其另开 FIFO turn。由 Agent 结合对话决定是修改当前目标还是新增目标，并把结果送回原来源。另从不同用户、另一个 DM 和另一个 Thread 发独立消息，确认均不插入该活跃任务。

### 通过标准与诊断证据

- Mattermost DM 和允许频道的指定提及都能收到；频道普通消息和白名单外消息被忽略。
- 不同 Thread 的会话上下文互相隔离；同一 Thread 的回复始终使用源 channel ID 和 root ID。
- 未批准/撤销成员不能触发 Agent；不同成员的配对状态互不继承。
- 入站与出站附件只属于原授权频道；进度卡与最终正文都回到正确来源。
- Mattermost 执行中消息只在精确 DM/Thread 来源和同一获准发言人范围内 Steer；普通措辞也会交给当前 Agent，不用连接器猜测语义。
- 浏览器 Console 中可按 post ID 找到收件、持久化、授权、Agent 调用和回复阶段；验证过程中不得暴露机器人令牌。

真实 Mattermost 和浏览器验收尚未由本次自动化代替。以上人工用例全部通过后，再在 Plane P5 issue 下附上不含密钥的测试标记、对应帖子/Thread ID、Console 阶段证据、复用的 Profile 和结果，并把 P5 状态改为完成；如有失败，先记录失败阶段和可复现用例，不进入 Phase 6。

## 2026-11-05 防回环补丁（2.24.7）

- Mattermost 频道传输层在构造 `DirectMessage` 前筛选原始帖子：仅允许其他用户明确 @机器人的帖子继续处理；机器人自己的帖子和普通频道消息都不构造为 DSH 入站消息。
- ChannelManager 再核验发言人不是机器人账号，`mattermostInboxItem` 也拒绝机器人自己的作者 ID，避免上游误标绕过入口过滤。
- 新增回归：普通频道帖子和机器人自身即使带有 `@ajiu` 与 mention 元数据，也不会进入 Durable Inbox、读取 thread、发送确认或启动 Agent；频道游标仍向前推进。
- 验证：`npm run build` 通过；Phase 5 定向测试命令 107 项通过。
- 打包：`npm run pack:check` 与 `npm run pack:verify -- <2.24.7 tgz>` 通过；归档约 8.37 MB。精确字节数与 SHA-256 保存在 `.agent-mm` 与 Plane 评论中。
- **Mattermost 的 `/channels/:id/posts?since=` 会把时间范围内修改的帖子返回给客户端，官方参数中没有“仅机器人提及”的服务端过滤条件。** 插件在收到 REST 响应后立刻过滤，非提及正文不会进入 Durable Inbox 或 Agent。若要求服务器层完全不向插件传送普通帖子，需要部署 Mattermost 服务端过滤/推送集成；当前 DSH 插件遵循现有官方 REST 路由，不声称实现了网络层零读取。
- 当前运行的 DSH Profile 尚未为 2.24.7 重启加载；浏览器和真实 Mattermost 回环验收未完成。继续复用 `dsh-partner-dev`，不要新建 Profile。Mattermost 保持停用，待版本核对后再进行人工验收。

## 2026-11-05 启停与重连入口（2.24.8）

- 停用渠道时，在连接状态旁显示“启用并连接”；启用但已停止或报错时显示“重连”，让恢复入口与状态放在一起。
- 显式重连先停止旧的接收任务，再启动新任务，避免旧任务尚未清理时 `start()` 因任务登记仍存在而直接返回。
- 保持 DSH 插件现有 `/channels/:id/enabled` 路由规范不变。
- 验证：`npm run build` 通过；同一 `dsh-partner-dev` Profile 已重启，浏览器标题和伙伴面板显示 `v2.24.8`，停用状态旁可见“启用并连接”。安装包检查通过。真实 Mattermost 当前保持停用，实际启用与重连后的实时收件仍待人工验收。

## 2026-11-05 历史上下文与当前 USER 焦点（2.24.11）

- Mattermost Thread API 请求显式携带 `perPage` 和 `direction=up`，限制服务端读取数量；本批触发帖子预留在排除数量内，最终只向 Agent 提供最近最多五条历史。
- 历史编排过滤机器人处理中回执、聊天状态提示和重复 BOT 正文；USER 历史与 BOT 历史有明确标记，当前批次最新 USER 正文单独作为主要回应焦点。
- 入站结构仍作为一条 DSH 原生 USER 消息提交；消息解释规则只加入 DSH 隐藏 system prompt，工具协议与可见工具仍由 DSH 原生组装。伙伴身份、长期行为准则和能力授权保持既有逻辑。
- 运行中的 Agent 使用原生 `steer` 排入下一步；若当前模型/工具调用尚未结束，渠道会立即确认已收到，但 Agent 不会抢占正在执行的工具。浏览器诊断现在区分“收到/排队”与“完成回复”。
- 自动化验证：`npm run build`；Mattermost/DM/Thread/附件/权限/steer 定向回归 114 项通过。2.24.12 附加提示词与回执过滤用例包含在该组中。
- 真实 Mattermost/浏览器人工验收仍待在同一个 `dsh-partner-dev` Profile 重启后进行；该项未通过人工验收前不关闭 Phase 5。

## 2026-11-05 当前请求焦点与连续 steer 说明（2.24.12）

- DSH 的 `Agent.steer(message)` 使用其原生 `next-step` 收件目标。若 Agent 正在运行，DSH 会保留当前模型或工具步骤，步骤结束后再进入下一步读取插入消息；它不承诺抢占式立即回复。插件不会取消正在执行的任务来制造“立即响应”，以免中断或重复外部副作用。
- 插件对每条获准入站消息立即发送收件确认。执行中新增消息会在来源验证后插入同一精确会话的 DSH 原生 USER 消息；原执行返回前，Inbox dispatcher 会等待已接受的 steer 完成入账，因此最终渠道答复仍由原任务持有者统一发送。
- 每次 Mattermost REST 收件页只有明确提及机器人的帖子会进入 Inbox；Thread API 只读该 Thread 最近最多五条旧帖子，并排除当前批次来源。当前帖子、同批较早消息和历史引用分别标注。SYSTEM 指导在隐藏 system prompt 中，不伪造 DSH 的事件角色、工具目录、工具权限或身份规则。
- 隐藏指导明确说明：当前 DSH 会话中只把最新 USER 消息作为当前请求；旧 DSH 消息、BOT 答复、SYSTEM 状态和插件确认仅作有限上下文，不作为新任务。历史中的机器人确认及投递状态按模板剔除，重复 BOT 正文按 post ID 与规范化文本去重；USER 的重复原文保留。
- `Agent.steer` 的行为依据当前开发机安装的 `@deepseek-ai/dsh-agent-loop` 实现核实：`steer` 写入 `next-step` 并唤醒 driver；已有 running phase 时不会中止该 phase，主循环在当前 step 返回后检查 next-step Inbox。真实 Mattermost 中“当前步骤结束后处理”的时延仍需人工验收。
- 自动化和打包结果见本节最后更新；真实 Mattermost 连续输入、工具执行中补充及正确原线程回复仍是 Phase 5 人工验收门槛。
