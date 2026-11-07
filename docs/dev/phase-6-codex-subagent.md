# Phase 6 — Codex 子 Agent 接入验收记录

日期：2026-11-07\
分支：`yly-mm-wx-up`\
插件源码版本：`2.24.29`\
验收 Profile：`dsh-partner-dev`（`127.0.0.1:43128`）

## 当前结论

**Phase 6：进行中，真实 DSH 模型选路尚未通过。更正：** 用户指出先前看到的是另起的 Codex 会话，不是 DSH 会话内由 `dsh-partner` 调用插件工具得到的结果。早先把用户的简短确认记成插件路由成功，是错误归因，现撤回；用户任务中的“你现在能让 Codex 写诗了吗？”没有对应的 `partner_code_execute` 本轮调用证据。Profile Run Ledger 中另有一次通过插件工具读取当前工作区 `package.json` 的记录（`9fd8c438-6647-4376-bd44-33d36a5ab3c7`），但任务不同，不能用来证明该诗歌请求或模型选路成功。

2.24.24–2.24.26 的旧浏览器记录曾选中 DSH 宿主的异步 `subagent_codex`，`job_output` 返回 `unknown job`；2.24.27 删除冲突别名，建立插件自有 `partner_code_execute`，统一工具模式由 `partner_tools action=call` 转发。2.24.29 修正了互相冲突的工具路由提示，并加强 Mattermost 当前 USER 消息与旧 DSH 历史的边界。代码和单元测试只证明调用入口、参数转发与提示约束，不证明真实模型本轮确实选中该工具。用户将进行 DSH/MM/微信联调；Provider 缺失、认证失败、异常退出及 Host 关闭清理等门槛也仍待验收。

本 Profile 按用户授权使用官方 `approve-for-me`，仅限隔离的 `dsh-partner-dev` 配置。Profile 的 Codex 模型固定为 `gpt-5.6-luna`，避免本机全局默认模型 `gpt-6-luna` 与当前登录/Provider 组合不兼容。没有改动全局 Codex 配置，也没有使用绕过审批或沙箱的模式。DSH Host 保持运行，避免中断正在使用该 Profile 的会话。

## 实现和 DSH 规范对照

- 代码执行使用 DSH 当前 Agent context 中的官方 `subagents` 服务和 Codex Provider，通过 `startActivation({ delivery: 'caller' })` 启动；插件不自行启动 Codex，也不接受模型提供的工作目录。
- 工作目录由 DSH Session/伙伴持久化会话路由确定。`toolDiscovery=true` 时一般伙伴内部工具通过 `partner_tools` list/describe/call 访问；Codex 具体任务是例外，直接经 `partner_tools action=call` 调用 `partner_code_execute`，不先查目录。该工具参数不包含工作目录。
- 2.24.25–2.24.26 尝试使用与宿主相同的 `subagent_codex` 名称并做作用域限制，真实 UI 证实宿主工具仍可能被模型直接选中。因此 2.24.27 删除同名适配器和限制尝试，按 DSH 工具发现约定保留宿主工具原入口，插件 Codex 工作统一使用 `partner_code_execute`；开启统一目录时经 `partner_tools` 调用。不得把宿主异步 Job ID 当成本插件 Run Ledger 的 ID。
- `partner_code_status` 从持久化 Run Ledger 查询真实执行状态。Provider 不可用或执行失败时，不回退到 DSH Agent 伪装成功。
- 取消、超时、重启恢复等自动化测试检查终态和清理行为。实现中新增的代码注释使用中文。

## 真实环境信息

| 项目 | 结果 |
| --- | --- |
| DSH Profile | `dsh-partner-dev`，端口 `43128` |
| 当前 Profile 启动 | PID `44804`；DSH Host `0.2.1-rc.5`；插件依赖是 `link:D:/yliyun_project/dsh-partner-yly-mm-wx-up`，真实链接目标与该工作树一致 |
| 当前 Profile 插件包 | 重启后从该链接工作树加载 `2.24.29`；浏览器 UI 标题尚未在本次复核中确认，交由用户联调时核对 |
| 当前伙伴工具发现模式 | `toolDiscovery=true`；因此本次预期轨迹是同一 DSH 回合中的 `partner_tools → partner_code_execute` |
| 上次浏览器验证时的插件 | `2.24.24`，来自 `yly-mm-wx-up` 工作树；已通过 UI 确认插件标题版本 |
| 上次重启后浏览器确认的版本 | `2.24.25`；UI 轨迹仍调用全局异步工具，验证失败 |
| 2.24.26 真实浏览器验收 | `FAIL`；两次调用宿主异步工具，`job_output` 返回 `unknown job`，未取得调用方可用的同步结果 |
| 当前源码/待交付版本 | `2.24.29`；统一工具模式增加 Codex 具体任务直接路由与真实回执约束；等待用户验证 DSH 轨迹是否出现 `partner_tools → partner_code_execute` |
| Codex Provider 插件 | `@deepseek-ai/dsh-subagent-codex` `0.2.1-rc.5` |
| Provider 使用的 Codex 包 | `0.153.4` |
| Provider 发现 | 真实伙伴会话中 `partner_tools` 可 list/describe `partner_code_execute` |
| Tool Schema | 真实 describe 返回 `task` 必填、`acceptanceCriteria` 可选、`timeoutSeconds` 1–900 |
| 只读认证 smoke test | 真实 DSH activation completed，读取测试工作区 `harness/package.json`，确认 `name=harness`、`version=1.0.0` |
| 默认模型问题 | 未固定模型时真实 activation 返回 `product-error`；Profile 单独固定为 `gpt-5.6-luna` 后真实 turn 成功 |

## 真实 DSH Host 执行证据

以下 Run ID 来自真实伙伴会话和真实 `partner_code_status` 查询。临时文件只在专用 DSH 验收工作区中创建，没有改动插件仓库。

| 验收 | Run ID / 结果 |
| --- | --- |
| 官方 Provider 只读读取 | `74430e80-332c-4f6f-a12d-30d805b19680`，`provider=codex`、`status=completed`；读取 `harness/package.json` |
| 创建、修改临时测试文件并运行指定测试 | `2eddb6c0-7477-4ca7-861f-aa2c474ae4ac`，`provider=codex`、`status=completed`；`node --test p6-provider-probe.test.mjs` 返回 1 pass、0 fail、exit code 0。测试含中文断言注释 `// 版本必须为 1.0.0`，验证包名和版本 |
| DSH 取消正在执行的无副作用等待任务 | `cd432806-7043-44d6-bd00-6f338ee9c708`，真实 UI 停止后 Ledger 为 `status=canceled`，诊断为 `DSH request canceled`；未自动重试 |
| 真实超时 | `06d0b0db-fdf6-4497-9d75-2ab033bc2f79`，`timeoutSeconds=1`；Ledger 返回 `status=timeout`、诊断 `Codex task timed out`；等待任务被提前终止，未自动重试 |
| 默认模型不兼容失败 | `81a4260b-b0ac-491c-ba5f-7b359ec1a7f4`，Provider 明确返回 `product-error`，没有被报告为成功；之后只在隔离 Profile 固定兼容模型 |

取消和超时的 DSH UI 结果与 Run Ledger 终态一致。由于运行机器上原本已有多个 Codex 进程，本次没有用全局进程计数推断资源释放；报告仅记录 DSH activation 的取消/超时和 Ledger 证据。

## 自动化与打包验证

- `npm run build`：2.24.24、2.24.25、2.24.26 源码均通过构建。
- `node --test --test-reporter=spec test/code-execution.test.mjs test/task-dispatch.test.mjs test/partner-prompt-readiness.test.mjs`：2.24.27 插件工具路由与 Provider 用例通过，47/47。
- `npm run pack:check`：2.24.24 和 2.24.25 打包检查通过；2.24.28 本次执行 `npm pack` 并通过 `npm run pack:verify`。
- 自动化覆盖 Provider/服务缺失且禁止 fallback、认证/初始化失败、异常结果判定、取消/超时 abort 与 dispose、清理失败、重启恢复和 Run Ledger 状态。

## 2026-11-06 显式 Codex 请求的错误工作目录

- 用户截图中全局 `subagent_codex` 在 Provider 启动前报 `working-directory: directory does not exist`，后续才显示通用的 `stage: initialize; category: unknown`。因此本次失败没有到达 Codex App Server，也不是 Codex 认证失败。
- DSH Provider 配置仍是 `approve-for-me` 和隔离 Profile 的 `gpt-5.6-luna`。Profile 的伙伴状态文件中，当前 `channel-sessions` 路由目录真实存在且不包含制表符；截图传入的 `tpartners` / `tchannel-sessions` 不在该已验证路由上。
- 2.24.24 的第一次提示词修正没有改变真实工具选择：浏览器轨迹仍显示直接调用全局 `subagent_codex`，随后 `job_output` 返回 `unknown job`，`job_list` 和 `list_agents` 都为空。Agent 最终自行生成另一首诗，并错误声称该诗来自 Codex。这次复现实锤了提示词不能作为路由隔离。
- 2.24.25 仅注册同名 Agent 作用域适配器不足以覆盖 DSH 全局工具；2026-11-07 重启浏览器实测仍进入异步全局实现，并再次得到 `unknown job`。因此该版本不算修复。
- 2.24.26 在 `dsh-partner-dev` 重启后仍调用宿主异步 `subagent_codex`。浏览器记录显示两次调用分别创建 Job ID，但两次 `job_output wait=true` 都返回 `unknown job`，`job_list` 为空。之后 UI 单独出现的子会话结果不能证明本轮调用已同步取回，原 Agent 报告“无输出”与 UI 卡片输出互相矛盾。此版本验收失败。
- 2.24.27 删除同名工具注册及宿主工具 deny，系统提示按插件自身入口路由：`toolDiscovery=true` 使用 `partner_tools` 的 `action=call`、`name=partner_code_execute`；未启用时直接使用插件 `partner_code_execute`。这遵循 DSH 对宿主工具与插件内部工具入口的边界。
- 新单测验证统一工具入口可以发现并执行插件 `partner_code_execute`，运行通过 `partner_tools` 网关且不会调用宿主全局工具。构建和目标测试 47/47 通过；本版打包与浏览器验收仍待完成。
- **成功标准：** 同一 DSH 用户回合的工具轨迹必须显示插件 `partner_tools → partner_code_execute`（或非统一目录模式下的顶层插件 `partner_code_execute`）；同一伙伴会话的 Run Ledger 出现对应新 `provider=codex`、`status=completed` 记录；该次父工具调用收到真实 Codex 输出。不能把新开的 Codex 会话、宿主全局 `subagent_codex` 卡片、其他请求的 Run Ledger 或助手文字自述当作本请求成功证据。

## 未通过项与下一门槛

1. 在真实 DSH Host 中暂时不可发现 Provider，确认给 Agent 明确错误且不启动 DSH fallback。
2. 在安全可恢复的认证失效条件下验证真实 DSH 错误分类；不修改或破坏用户认证凭据。
3. 在真实 Provider 路径中制造受控异常退出并核实 Run Ledger 不是 `completed`，且不 fallback。
4. 用户在同一个 `dsh-partner-dev` 新会话中确认 UI 标题为 `v2.24.29`、本轮轨迹为 `partner_tools → partner_code_execute`，并检查对应 Run Ledger；随后完成 Mattermost 与微信人工验收。
5. 在安全可恢复条件下验收 Provider 缺失、认证失败、异常退出、Host 关闭清理和重启恢复行为；不破坏用户凭据，不自动重试不确定的副作用。

以上任一真实场景未验收前，Phase 6 和 Plane issue `d1f966bc-bfbe-4b9b-a246-c5e187c62073` 均保持进行中。

## 2026-11-07 2.24.29 定点修复与代码级验收

- Codex 意图规则现在明确：点名 Codex 且给出具体交付物，即使使用能力问句（如“你现在能让 Codex 写诗了吗？”），也要走本轮执行入口；统一工具入口不得先 list/describe/load。
- `partner_tools`、隐藏系统提示与 `partner_code_execute` 描述采用一致路由规则。模型声称之前已执行、另开的 Codex 会话、宿主 `subagent_codex` 或不同请求的 Run Ledger 都不能证明当前请求成功。
- Mattermost 隐藏提示明确区分插件追加的当前原生 USER 输入与 DSH 长会话里旧 USER/助手/工具事件。已有代码级测试继续确认当前任务置尾、纯 @ 不当任务、旧确认/失败状态不进入线程历史、Thread 历史按配置轮数限量且不跨来源。
- `npm run build`：通过。
- `node --test --test-reporter=spec test/code-execution.test.mjs test/task-dispatch.test.mjs test/partner-prompt-readiness.test.mjs test/durable-inbox.test.mjs test/mattermost-continuity.test.mjs test/mattermost-phase5.test.mjs`：112/112 通过。
- `npm pack --pack-destination D:\yliyun_project\packages` 与 `npm run pack:verify -- D:\yliyun_project\packages\lemoncat7-dsh-partner-2.24.29.tgz`：通过；校验包结构、内置资源和标题 `v2.24.29`。最终包大小与 SHA-256 在本次交付记录中报告。
- `git diff --check`：通过。
- 已重启同一 Profile：旧 PID `34352` 停止，新 PID `44804` 监听 `127.0.0.1:43128`；DSH Host 与 Codex Provider 仍为 `0.2.1-rc.5`，插件链接目标为本工作树，Profile 的 `toolDiscovery=true`。本次未做浏览器 UI 核验，也没有真实 LLM 轨迹证明模型选择了插件工具。
- **代码级状态：PASS。真实 DSH 模型路由状态：BLOCKED，等待用户新会话联调。** 下一门槛是同一 DSH 回合出现 `partner_tools → partner_code_execute`，并在同一父回合下看到对应 `provider=codex/status=completed` 与真实输出；随后再由用户验收 MM/微信。

## 2026-11-07 用户验收说法更正与 2.24.28 交付记录

- 更正：早前把用户的确认当作本轮插件主路径通过，用户现明确指出此前得到的是 Codex 另起的会话。该结论已撤回；本节之前的 2.24.28 发布包与测试记录仍是交付事实，但不代表诗歌请求走过 DSH 插件路由。
- Profile Run Ledger 现存独立的 `9fd8c438-6647-4376-bd44-33d36a5ab3c7` 记录，其任务是只读 `package.json`；它与用户指出的诗歌请求不同，不能作为该请求的成功证据。
- 2.24.28 是交付标记版本，未改动 MM/微信处理逻辑；本地重启后由用户继续验收两条消息通道。
- `npm run build`：通过。
- `npm pack --pack-destination D:\yliyun_project\packages`：生成 `lemoncat7-dsh-partner-2.24.28.tgz`，8,424,295 字节；npm pack 的 `prepare` 生命周期也再次构建成功。
- `npm run pack:verify -- D:\yliyun_project\packages\lemoncat7-dsh-partner-2.24.28.tgz`：通过；核对发布压缩包结构、内置资源、发布说明和 UI 标题 `v2.24.28`。
- `git diff --check`：通过，无空白错误（Git 提示 Markdown/JS 文件的 LF 将按仓库规则转为 CRLF）。
- MM/微信端到端消息收发与真实模型选中插件工具仍待用户在本地验收。
