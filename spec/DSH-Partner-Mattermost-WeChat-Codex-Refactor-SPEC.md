# DSH Partner 二次开发完整 AI 开发 SPEC

## Mattermost + 微信消息体系、会话隔离、持久化收件箱与 Codex 子 Agent 执行

> 文档类型：可执行工程开发规格（Engineering SPEC）
>
> 项目：`lemoncat7/dsh-partner`
>
> 基线：GitHub `main` 分支当前读取到的 `@lemoncat7/dsh-partner` 版本为
> `2.23.55`；`package.json` 声明 DSH 兼容范围
> `^0.2.1-rc.2`。开发开始时必须重新核对本地工作区实际版本、分支、未提交修改和锁文件。
>
> 目标读者：GPT-6 Luna、Codex CLI 或其他 AI 编程 Agent。
>
> 重要：本文是开发约束，不是允许一次性大改的授权。必须先完成现状核对、规划和架构确认，再分阶段开发、测试和验收。

------------------------------------------------------------------------

# 0. 给 AI 开发 Agent 的最高优先级指令

你正在修改一个已经运行的 DSH Partner
项目，不是在创建一个新项目。你的首要任务是保护已有功能和用户数据。

## 0.1 必须遵守的工作顺序

严格按以下顺序执行：

1.  **只读检查**：读取项目结构、`package.json`、锁文件、Git
    状态、当前分支、当前提交、现有测试和关键代码。
2.  **现状报告**：列出已经实现的能力、缺失能力、代码与文档不一致处、潜在回归风险。
3.  **实施规划**：把本 SPEC
    拆成可独立验收的任务，明确依赖、文件范围、测试和回滚方式。
4.  **架构设计**：先提交数据模型、状态机、消息路由、Session 路由、Codex
    执行链路设计，不先写实现代码。
5.  **阶段实施**：一次只完成一个阶段；阶段测试通过后才进入下一阶段。
6.  **代码审查**：检查 diff、权限边界、异常路径、资源释放、重试与幂等。
7.  **完整验收**：运行构建、类型检查、单元测试、集成测试和回归测试。
8.  **交付报告**：只报告真实执行过的命令、测试结果、未完成事项和风险。

## 0.2 禁止事项

-   禁止未读取相关代码就修改。
-   禁止一次性重写 `agent-runtime.ts`、`channels/manager.ts`
    或整个渠道系统。
-   禁止为实现相同能力重复造一套 DSH Agent Runtime、Subagent Manager 或
    Job Registry。
-   禁止把整个 Mattermost
    频道历史、整个微信历史或无关历史拼接到当前用户消息。
-   禁止默认让不同微信联系人、Mattermost DM、不同频道线程共享同一个短期
    Session。
-   禁止用显示名称代替用户 ID、频道 ID、线程 ID或消息 ID。
-   禁止把 `SessionId`、`subagentId`、`JobId`、`GoalId`、Partner `runId`
    混用。
-   禁止把 `subagentId` 传给 `job_output`、`job_list` 或 `job_kill`。
-   禁止 Codex 不可用时静默退回本地 DSH Agent，伪装成已经委派给 Codex。
-   禁止用 Prompt 代替真正的程序化委派。
-   禁止自动重放状态不明的外部消息或回复，造成重复执行或重复发送。
-   禁止删除或覆盖用户现有配置、凭据、Session、附件和历史数据。
-   禁止为了让测试通过而删除、跳过或弱化原有测试。
-   禁止声称"恰好一次"投递，除非远端 API 确实提供并验证了幂等保证。
-   禁止提交密钥、Token、Cookie、微信 context token、Mattermost Personal
    Access Token 或本地配置文件。

## 0.3 每个开发任务必须提交的内容

每个任务结束时，必须给出：

  项目       必须说明
  ---------- -------------------------------------------
  修改目标   本任务解决哪个明确问题
  修改文件   文件路径及每个文件的修改目的
  设计依据   对应 SPEC 章节和原有代码位置
  实现方式   关键流程、状态变化、异常处理
  测试       执行的命令和真实结果
  回归       受影响的原有功能
  风险       未解决的问题和兼容性风险
  结论       `PASS`、`FAIL` 或 `BLOCKED`，不得模糊表述

------------------------------------------------------------------------

# 1. 项目目标与范围

## 1.1 总体目标

基于 `https://github.com/lemoncat7/dsh-partner`
二次开发，重点完成四件事：

1.  建立可靠的 Mattermost 私聊、频道、@ 机器人和线程消息接入能力。
2.  保留并强化微信个人联系人消息能力，确保消息续读、上下文隔离和回复路由可靠。
3.  建立持久化消息收件箱，实现消息去重、续读、连续消息合并、补充插入和独立任务排队。
4.  让 DSH 主 Agent 能通过真实 Subagent Provider 将代码开发任务交给
    Codex 执行，而不是创建另一个 DSH Agent 后继续自己执行。

## 1.2 本次范围

### P0：必须交付

-   Mattermost DM 私聊。
-   Mattermost 频道消息。
-   Mattermost 顶层消息 @ Bot。
-   Mattermost 线程内对话和线程回复。
-   Mattermost 消息来源、发送人和回复目标准确关联。
-   微信私聊按联系人隔离 Session。
-   微信 `get_updates_buf` 续读状态持久化。
-   消息 Inbox 持久化、事件去重、游标安全提交。
-   文字消息短窗口合并。
-   消息补充、Steer、Queue 三种行为分离。
-   不同会话并行，同一会话 FIFO。
-   DSH Session History 作为短期上下文。
-   Long-term Memory 按需检索，不主动拼接无关历史。
-   Codex 子 Agent 真实启动、执行、完成通知、取消和资源释放。
-   失败状态可诊断，不能伪造成功。
-   原有微信、DM、附件、审批、工具权限、主动通知和伙伴能力回归测试通过。

### P1：本次应尽量交付

-   Mattermost 频道级白名单。
-   Mattermost 发送人白名单。
-   频道内多人在同一线程协作。
-   线程级 Session 历史隔离。
-   消息和回复的持久化审计。
-   运行任务和 Codex 子 Agent 状态可查询。
-   服务重启后的 Inbox 恢复。

### 明确不做

-   不重写 DSH 核心 Agent Loop。
-   不自研完整 Subagent Runtime。
-   不重写微信协议。
-   不在第一阶段引入新的向量数据库。
-   不自动读取 Mattermost 全频道历史。
-   不自动读取微信客户端历史。
-   不把所有联系人、所有频道或所有线程合并成一个会话。
-   不实现不受控的群聊自主接话。
-   不让 Codex 绕过审批、授权、沙箱和工作目录约束。
-   不宣称远端消息的端到端 exactly-once。

------------------------------------------------------------------------

# 2. 当前代码基线与已知问题

以下是对仓库公开 `main` 分支代码的检查结论。开发 Agent
必须在本地再次核实，不能把本节当成当前工作区的绝对事实。

## 2.1 当前项目基本信息

-   项目：`@lemoncat7/dsh-partner`
-   本次读取到的 main 分支版本：`2.23.55`
-   Node 要求：`^22.19.0 || >=24.0.0`
-   DSH 声明兼容范围：`^0.2.1-rc.2`
-   构建：`npm run build`
-   测试：`npm test`
-   项目为 TypeScript / ESM。
-   现有状态由 `PartnerStore` 管理，支持 JSON 文件和 Split State
    Persistence。
-   现有微信使用 iLink Bot 接口。
-   Mattermost 与 Matrix 由 `DirectTransport` 处理。

## 2.2 Mattermost 当前限制

重点检查：

-   `src/channels/direct/transport.ts`
-   `src/channels/direct/inbound-batch.ts`
-   `src/channels/direct/dispatcher.ts`
-   `src/channels/manager.ts`
-   `docs/direct-channels.md`

当前公开代码中：

1.  `DirectMessage` 主要包含
    `id`、`sender`、`text`、`targetId`、附件和时间戳，缺少统一的
    `channelId`、`rootId`、`threadRootId`、`actorId` 和 conversation
    key。
2.  Mattermost `validate()` 对固定目标要求
    `room.type === 'D'`，并验证恰好两个成员。
3.  Mattermost 消息读取主要面向双人 DM。
4.  读取时过滤 `root_id`
    非空的帖子，因此线程回复没有形成完整的消息输入链路。
5.  发送时通过固定 DM `targetId` 发送，不具备通用频道/线程目标。
6.  `docs/direct-channels.md` 仍明确说明 Mattermost 线程和群聊不支持。
7.  `groupDirectMessages()`
    主要处理含附件的相邻消息，纯文字消息不会通用合并。
8.  当前 `DirectDispatcher` 是进程内队列，不是持久化队列。

因此，本次不能只增加 `@bot`
字符串识别。必须增加消息来源模型、频道授权模型、线程会话路由和线程回复目标。

## 2.3 微信当前限制

重点检查：

-   `src/channels/weixin/poll.ts`
-   `src/channels/weixin/types.ts`
-   `src/channels/weixin/api.ts`
-   `src/channels/weixin/connect.ts`
-   `src/channels/manager.ts`
-   `src/agent-runtime.ts`

当前微信消息包含：

-   `from_user_id`
-   `message_id` / `msg_id`
-   `seq`
-   `create_time_ms`
-   `context_token`
-   `item_list`

当前 `pollWeixin()` 中的 `get_updates_buf`
主要保存在轮询函数的局部变量中。必须核对实际消息处理回调是否在游标更新前完成持久化。目标是让新消息和新
buffer 的提交具备原子性，避免进程退出时丢消息。

微信 `context_token` 是渠道回复协议数据，不是 AI
对话上下文。必须严格隔离，不得传给模型，也不得跨联系人使用。

## 2.4 当前 Session 共享问题

重点检查：

-   `src/agent-runtime.ts`
-   `src/memory-scope.ts`
-   `src/conversation-history-recall.ts`
-   `src/companions/session-configuration.ts`
-   `src/domain.ts`

当前公开文档描述：同一伙伴的本地和多个渠道可共用主对话。`ensureSession()`
中非 QQ 渠道存在使用主 Session 的路径。

这会导致多个微信联系人、Mattermost DM
或不同渠道的消息可能共享短期对话历史。

`conversationMemoryScope()` 和 `recallConversationHistory()`
不能解决同一 Session 已经混入的原始消息。Memory Scope 与 Session
Isolation 是两个不同问题。

本次必须将短期 Session
隔离作为第一原则，长期记忆共享作为独立的显式配置。

## 2.5 当前回执和队列问题

重点检查：

-   `src/channels/manager.ts`
-   `src/channels/direct/dispatcher.ts`
-   `src/store.ts`
-   `src/domain.ts`

当前有：

-   `DirectDispatcher` 的进程内 lane。
-   `PartnerState.recentReceipts`，长度有限。
-   `directLoop()` 持久化渠道 cursor。
-   `markInbound()` 和 `rememberReceipts()` 的回执提交逻辑。

开发 Agent 必须逐行核对：消息是否在真正进入 DSH Session
前就被标记为已处理；进程在"回执已写入、任务尚未提交"之间崩溃时是否会丢消息。

不要仅凭注释或文档认定队列具有持久化和恰好一次保证。

## 2.6 当前工作执行器不是 Codex

重点检查：

-   `src/execution/service.ts`
-   `src/execution/work-tool.ts`
-   `src/execution/domain.ts`

当前 `EphemeralExecutionService` 通过 `ctx.agents.create()` 创建临时 DSH
Agent，并通过 `partner_work_tools` 桥接工具执行工作。

它不是 Codex CLI，也不是 Codex Subagent Provider。

本次必须保留 DSH 业务工具执行能力，同时增加真实 Codex 执行后端。

------------------------------------------------------------------------

# 3. 总体目标架构

## 3.1 逻辑架构

``` mermaid
flowchart TD
    A["微信 iLink Bot"] --> B["Channel Adapter"]
    C["Mattermost REST API"] --> B
    B --> D["Inbound Envelope Normalizer"]
    D --> E["Durable Inbox"]
    E --> F["Deduplication + Cursor Commit"]
    F --> G["Message Coalescer"]
    G --> H["Conversation Router"]
    H --> I["Session History"]
    I --> J["DSH Main Agent"]
    J --> K["Task Router"]
    K --> L["DSH Business Executor"]
    K --> M["Codex Subagent Provider"]
    L --> N["Execution Result"]
    M --> N
    N --> O["Reply Outbox"]
    O --> P["Outbound Adapter"]
    P --> A
    P --> C
```

## 3.2 分层职责

  ---------------------------------------------------------------------------------
  层                      职责                           禁止承担的职责
  ----------------------- ------------------------------ --------------------------
  Channel Adapter         协议读取、消息发送、附件传输   决定长期记忆和 Agent 策略

  Envelope Normalizer     统一事件结构                   调用 LLM

  Durable Inbox           去重、持久化、游标和重试       生成 AI 回复

  Message Coalescer       连续消息收集与合并             猜测复杂语义

  Conversation Router     选择 Session、线程和 Memory    把不同会话合并
                          Scope                          

  DSH Main Agent          理解任务、规划、答复           假装自己就是 Codex

  Task Router             选择 DSH 或 Codex 执行器       静默降级

  Codex Executor          启动和跟踪 Codex 子任务        越权操作用户工作区

  Reply Outbox            回复持久化、路由、发送状态     自动重复发送不确定的回复
  ---------------------------------------------------------------------------------

## 3.3 核心原则

### 原则 A：消息事件和聊天文本分离

所有渠道先产生标准化事件，再由路由器选择会话。

### 原则 B：同一会话有稳定 Session，不同会话有独立 Session

Mattermost 不同线程必须隔离。微信不同联系人必须隔离。Mattermost DM
与微信联系人也不能默认共享短期历史。

### 原则 C：Session History 和 Long-term Memory 分离

-   Session History：当前对话的短期上下文，由 DSH Session 自身维护。
-   Long-term Memory：跨会话的长期知识，按需检索。
-   Channel Context：渠道 ID、线程
    ID、发送人和回复目标，只是路由元数据，不是聊天历史。

### 原则 D：Inbox 和 DSH 执行分离

渠道接收不能等待 AI 执行结束。收件箱必须持续接收消息，任务执行由独立
worker 消费。

### 原则 E：Codex 是真实执行后端

代码开发任务必须进入 Codex Provider/Executor 的真实执行链路。不能只在
Prompt 中写"请委托 Codex"。

------------------------------------------------------------------------

# 4. 核心数据模型

以下接口是目标模型。允许根据项目命名规范调整，但语义和字段必须保留。

## 4.1 InboundEnvelope

``` typescript
type ChannelPlatform = 'weixin' | 'mattermost';

type ConversationType =
  | 'dm'
  | 'channel'
  | 'thread';

interface InboundEnvelope {
  platform: ChannelPlatform;
  accountId: string;
  channelConfigId: string;

  externalEventId: string;
  externalMessageId: string;

  conversationType: ConversationType;
  conversationId: string;
  conversationKey: string;

  channelId?: string;
  threadRootId?: string;
  replyToMessageId?: string;

  actorId: string;
  actorName?: string;

  text: string;
  mentions: string[];
  isBotMentioned: boolean;
  isBotMessage: boolean;

  attachments: InboundAttachment[];

  platformTimestamp: number;
  receivedAt: number;

  // 微信专用：仅用于回复路由，绝不进入模型上下文。
  replyContextToken?: string;

  rawEventVersion?: string;
}
```

约束：

-   `externalEventId` 必须稳定，作为渠道事件去重键。
-   `conversationKey` 必须由稳定 ID 生成，不得由显示名称生成。
-   `actorId` 必须是真实平台用户 ID。
-   `threadRootId` 为空代表没有线程。
-   `replyContextToken` 只允许在 Channel Adapter 和 Reply Adapter
    中使用。
-   `rawEventVersion` 用于识别编辑或更新事件，不得将编辑误认为新消息。

## 4.2 OutboundTarget

``` typescript
type OutboundTarget =
  | {
      platform: 'weixin';
      channelConfigId: string;
      toUserId: string;
      contextToken?: string;
    }
  | {
      platform: 'mattermost';
      channelConfigId: string;
      channelId: string;
      conversationType: 'dm' | 'thread';
      rootId?: string;
      directUserId?: string;
    };
```

禁止再只用一个 `userId` 字符串代表所有回复目标。

Mattermost 频道回复必须使用 `channelId + rootId`。Mattermost DM 必须使用
DM channel ID，并校验 peer 身份。

## 4.3 ConversationRoute

``` typescript
interface ConversationRoute {
  id: string;
  companionId: string;

  conversationKey: string;
  platform: 'weixin' | 'mattermost';
  conversationType: 'dm' | 'channel' | 'thread';

  channelConfigId: string;
  accountId: string;

  externalConversationId: string;
  channelId?: string;
  peerId?: string;
  threadRootId?: string;

  sessionId: string;
  cwd?: string;

  memoryScopeId: string;
  memorySharingMode: 'isolated' | 'channel' | 'companion';

  lastActorId?: string;
  lastMessageAt: number;
  createdAt: number;
  updatedAt: number;
}
```

如果继续复用 `ChannelSession`，必须增加等价字段，并处理 `PartnerState`
Schema Migration。不要让 `userId` 同时承担"真实发言人"和"频道会话
ID"两个含义。

## 4.4 消息批次

``` typescript
type InboxStatus =
  | 'received'
  | 'filtered'
  | 'buffered'
  | 'ready'
  | 'processing'
  | 'completed'
  | 'retryable_failed'
  | 'dead_letter'
  | 'interrupted';

interface MessageBatch {
  id: string;
  conversationKey: string;
  sessionId?: string;

  eventIds: string[];
  status: InboxStatus;

  firstReceivedAt: number;
  lastReceivedAt: number;
  readyAt: number;

  attemptCount: number;
  leaseOwner?: string;
  leaseUntil?: number;

  createdAt: number;
  updatedAt: number;
  lastError?: string;
}
```

## 4.5 执行任务 ID

必须区分：

  ID                  含义                    所属系统
  ------------------- ----------------------- -------------------
  `sessionId`         对话身份                DSH Session
  `subagentId`        子 Agent Session 身份   DSH Subagent
  `jobId`             后台任务身份            DSH Jobs
  `goalId`            目标任务身份            DSH Goal
  `runId`             Partner 业务执行记录    DSH Partner
  `externalEventId`   外部渠道消息身份        Mattermost / 微信
  `batchId`           合并消息批次身份        Partner Inbox

任何跨系统调用都必须明确传递对应 ID，禁止混用。

------------------------------------------------------------------------

# 5. 持久化 Inbox 和消息续读机制

## 5.1 技术选型

首选 SQLite 独立数据库，不把高频消息事件写入 `PartnerState` 大 JSON。

实施前必须验证运行环境支持情况：

-   当前 Node 版本是否支持 `node:sqlite`。
-   构建 TypeScript 的 `@types/node` 是否包含对应类型。
-   DSH 打包和部署环境是否包含相同 Node Runtime 能力。
-   数据库文件目录是否可写，是否能设置安全文件权限。

如果 `node:sqlite`
在实际打包环境不可用，先提交选型报告，再决定使用项目已有 SQLite
能力或引入依赖。不得偷偷更换成内存队列。

SQLite 建议：

-   WAL 模式。
-   `busy_timeout`。
-   单进程单写入入口。
-   短事务。
-   数据库文件权限限制。
-   版本化 migration。
-   关闭时等待事务完成。

## 5.2 表结构

建议最少创建以下表。

### `inbox_events`

  字段                  类型           说明
  --------------------- -------------- ---------------------
  id                    TEXT PK        内部事件 ID
  channel_config_id     TEXT           Partner 渠道 ID
  platform              TEXT           weixin / mattermost
  account_id            TEXT           Bot 账号 ID
  external_event_id     TEXT           外部事件 ID
  external_message_id   TEXT           外部消息 ID
  conversation_key      TEXT           会话 Key
  actor_id              TEXT           发送人
  payload_json          TEXT           标准化事件 JSON
  status                TEXT           处理状态
  batch_id              TEXT           所属批次
  attempt_count         INTEGER        执行次数
  received_at           INTEGER        接收时间
  processed_at          INTEGER NULL   处理时间
  last_error            TEXT NULL      错误

唯一约束：

`UNIQUE(channel_config_id, external_event_id)`

### `message_batches`

  字段                类型           说明
  ------------------- -------------- ----------------
  id                  TEXT PK        Batch ID
  conversation_key    TEXT           会话 Key
  session_id          TEXT NULL      DSH Session
  status              TEXT           批次状态
  event_ids_json      TEXT           事件 ID 列表
  first_received_at   INTEGER        首条时间
  last_received_at    INTEGER        末条时间
  ready_at            INTEGER        最早可执行时间
  attempt_count       INTEGER        尝试次数
  lease_owner         TEXT NULL      消费者
  lease_until         INTEGER NULL   租约到期
  last_error          TEXT NULL      最近错误
  created_at          INTEGER        创建时间
  updated_at          INTEGER        更新时间

### `channel_cursors`

  字段                类型           说明
  ------------------- -------------- ---------------------------
  channel_config_id   TEXT PK        渠道 ID
  platform            TEXT           平台
  cursor_type         TEXT           timestamp / opaque-buffer
  cursor_json         TEXT           游标内容
  high_watermark      INTEGER NULL   时间水位
  updated_at          INTEGER        更新时间

### `outbound_deliveries`

  字段                  类型        说明
  --------------------- ----------- -------------------------------------
  id                    TEXT PK     deliveryId
  conversation_key      TEXT        会话
  target_json           TEXT        原始回复目标
  batch_id              TEXT        来源批次
  content_hash          TEXT        回复内容摘要
  status                TEXT        pending/sending/sent/unknown/failed
  external_message_id   TEXT NULL   远端消息 ID
  attempt_count         INTEGER     发送尝试
  created_at            INTEGER     创建时间
  updated_at            INTEGER     更新时间
  last_error            TEXT NULL   最近错误

## 5.3 Inbox 状态机

``` mermaid
stateDiagram-v2
  [*] --> received
  received --> filtered
  received --> buffered
  buffered --> ready
  ready --> processing
  processing --> completed
  processing --> retryable_failed
  retryable_failed --> processing
  processing --> interrupted
  interrupted --> ready
  retryable_failed --> dead_letter
  filtered --> [*]
  completed --> [*]
  dead_letter --> [*]
```

状态解释：

-   `received`：事件已经持久化。
-   `filtered`：不需要响应，例如普通频道聊天、Bot 自己发言。
-   `buffered`：正在收集连续消息。
-   `ready`：已达到执行条件。
-   `processing`：某个 worker 已领取并持有租约。
-   `completed`：已完成处理。
-   `retryable_failed`：可以安全重试。
-   `interrupted`：进程退出或租约异常中断，需要恢复判断。
-   `dead_letter`：超过重试上限或需要人工处理。

任何消息不能只存在内存中而没有持久化记录。

## 5.4 消息入库和游标提交必须原子化

### Mattermost

使用服务端帖子时间作为增量同步水位，并设置重叠窗口，例如 3～5 秒。

每次读取：

1.  读取已持久化水位 `high_watermark`。
2.  查询 `since = high_watermark - overlapMs`。
3.  按 `create_at`、post ID 稳定排序。
4.  通过 `external_event_id` 去重。
5.  把本次所有有效消息写入 Inbox。
6.  在同一个 SQLite 事务中提交新水位。
7.  事务成功后才允许下一轮以新水位继续。

必须考虑：

-   多条消息拥有相同 `create_at`。
-   API 返回顺序不稳定。
-   查询结果达到服务端分页上限。
-   服务端超时。
-   进程在入库和游标提交之间退出。
-   消息被编辑或删除。
-   频道积压超过单批限制。

如果 API
结果可能被截断，必须继续分页或缩小查询窗口；不能直接推进水位跳过剩余消息。

首次连接默认建立当前水位，不自动执行历史消息。历史回放作为显式配置，不允许默认开启。

### 微信

微信的 `get_updates_buf` 是不透明续读游标。

要求：

1.  从持久化 `channel_cursors` 读取旧 buffer。
2.  调用 `getUpdates(oldBuffer)`。
3.  标准化本次 `msgs`。
4.  把所有事件和新 buffer 在同一事务中持久化。
5.  事务成功后才把新 buffer 作为下一次请求游标。
6.  任何持久化失败都保留旧 buffer。
7.  事件重复时依赖唯一约束去重。

修改 `pollWeixin()` 的回调契约，使消息接收持久化可以被
`await`，不要在尚未确认 Inbox 写入时就不可逆地推进本地游标。

## 5.5 重试与恢复

-   每个 Inbox 事件最多允许配置的重试次数。
-   失败时记录错误类型、时间和 attempt。
-   使用指数退避和随机抖动。
-   HTTP 401/403 等认证或授权错误不能无限重试。
-   附件下载失败不能执行不完整的原始请求。
-   重启后扫描过期 lease。
-   对 `processing` 状态不能简单全部改回 `ready`，必须检查是否已经进入
    DSH Session。
-   使用 `batchId`、稳定的 DSH user message ID（若当前 DSH API 支持）和
    Session 事件检查，尽量避免重复 followup。
-   如果无法确认上次执行是否已发生，标记
    `interrupted`，不要伪造完成，也不要无条件重复执行有副作用的工具。
-   对 Codex 代码任务，重试前必须检查 Git diff 和工作区状态。

本系统保证"可恢复的至少一次接收"和"基于状态的去重"，不承诺所有外部副作用恰好执行一次。

------------------------------------------------------------------------

# 6. 消息合并、补充和排队

## 6.1 三种行为必须分离

  ----------------------------------------------------------------------------------
  行为              发生时机             目的                 产生几次回答
  ----------------- -------------------- -------------------- ----------------------
  Coalesce          Agent 尚未开始处理   把连续输入合成一个   一次
                                         User Message         

  Steer             Agent                给当前任务追加补充   原任务完成后尽量一次
                    正在处理同一个任务                        

  Queue             新的独立任务到达     等待前一个任务结束   每个任务分别回答
  ----------------------------------------------------------------------------------

不能把三种机制都叫"消息合并"。

## 6.2 默认参数

初始值可配置，后续根据真实使用情况调整：

  参数                                初始值
  ---------------------------- -------------
  微信短消息收集窗口                  1200ms
  Mattermost DM 收集窗口              1200ms
  Mattermost Thread 收集窗口          1200ms
  最大收集时间                        4000ms
  单批最大消息数                           8
  单批最大文本长度                      32KB
  单批附件数量                             8
  单批附件总大小                        64MB
  每会话待处理批次上限                    50
  全局待处理批次上限                     200
  Inbox lease                    30s，可续租

以上是初始工程参数，不是平台强制限制。

## 6.3 Coalesce 规则

同一个 `conversationKey` 内：

-   微信：同一个 `from_user_id`，在收集窗口内的连续消息可以合并。
-   Mattermost DM：同一个 DM channel、同一
    actor，在窗口内的消息可以合并。
-   Mattermost Thread：同一个
    `threadRootId`，窗口内的消息可以合并；多人补充时保留每条消息的 actor
    信息。
-   不同联系人不能合并。
-   不同频道不能合并。
-   不同线程不能合并。
-   超出窗口的消息必须形成新批次。
-   不能只因为消息文本相似就合并。
-   不使用 LLM 对每条入站消息进行分类，以免增加延迟、成本和不可预测性。

合并后的文本必须保留原始消息顺序和发送人：

``` text
[消息 1 | actor: user-1001 | 10:00:01]
帮我分析这个项目

[消息 2 | actor: user-1001 | 10:00:02]
重点关注消息接入和 Codex 委派
```

合并只生成一个 DSH User Message，不得分别触发两次模型请求。

## 6.4 Steer 规则

Mattermost：

-   当前任务与新消息属于同一个 `threadRootId`，才允许自动考虑 Steer。
-   新线程绝不能插入旧线程。
-   如果当前 Agent 已经完成当前轮次，不再 Steer，改为新一轮 Queue。
-   如果 DSH 当前运行状态不允许插入，转为 Queue，不丢消息。

微信：

-   微信没有 Mattermost 那样可靠的线程语义。
-   默认不把任何新消息都插入正在执行的任务。
-   默认先 Coalesce；任务开始后，新消息进入 Queue。
-   只有用户明确使用 `补充:`、`更正:`、`追加:`
    等显式标记，或项目已经可靠解析出引用关系时，才允许配置为 Steer。
-   不允许仅凭"同一联系人"就认为新消息一定是上一条任务的补充。

Steer 必须使用项目已有 `agents.steer()` 或 DSH
支持的等价接口。不要自行修改 DSH Agent 内部队列。

## 6.5 Queue 规则

-   同一个 `conversationKey` 按 FIFO 执行。
-   不同 conversationKey 可以并行。
-   队列满时保留 Inbox 数据，不丢弃。
-   Queue 中的消息不能提前标记为 completed。
-   已经排队的消息不因设置变化而重新排序。
-   用户取消某条任务时，只取消对应 batch，不影响同一频道其他线程。
-   交互提问的答案优先级沿用现有机制，但必须验证不会破坏 FIFO
    和消息续读。

## 6.6 单批回答约束

一个 Coalesced Batch 只能调用一次 `agent.followup()`。

Steer 的补充输入必须关联当前活跃 batch。完成时只发送一个最终回复；若 DSH
实际产生了多个独立 turn，必须由测试明确记录，不得在代码中简单吞掉结果。

Queue 的每个 Batch 都是独立任务，必须各自有独立结果和回复记录。

------------------------------------------------------------------------

# 7. Mattermost 接入详细设计

## 7.1 连接与账号验证

保留现有 Token/账号登录凭据管理，不把 Token 交给模型。

验证：

-   `/api/v4/users/me` 获取 Bot user ID、username。
-   校验 Bot 账号身份与配置一致。
-   校验频道确实存在。
-   校验 Bot 已加入目标频道。
-   DM 校验真实 peer。
-   频道校验不能再要求只有两个成员。
-   频道访问必须经过明确白名单。
-   禁止根据频道显示名称推断频道 ID。

## 7.2 支持的消息类型

  -----------------------------------------------------------------------
  类型                    是否处理                规则
  ----------------------- ----------------------- -----------------------
  Bot DM                  是                      走 DM 授权和独立
                                                  Session

  顶层频道普通消息        否                      默认忽略

  顶层频道 @ Bot          是                      建立或使用对应线程
                                                  Session

  已接入 Thread 中的回复  是                      允许无须每次重新
                                                  @，但必须验证 Thread
                                                  已由 Bot 接入

  未接入 Thread           否                      除非明确 @ Bot
  的普通回复                                      

  Bot 自己的消息          否                      防止循环

  其他 Bot/Webhook 消息   默认否                  可配置明确白名单

  删除消息                否                      不执行

  编辑消息                第一版不重新执行        记录 edit
                                                  状态，避免重复执行
  -----------------------------------------------------------------------

## 7.3 @ Bot 识别

启动时读取 Bot 的真实 `userId` 和 `username`。

识别策略：

1.  优先使用 Mattermost API/事件中可验证的 mention
    元数据（如果当前服务器版本提供）。
2.  如果使用文本解析，必须使用 Bot username 精确匹配。
3.  不能使用 Bot display name 模糊匹配。
4.  不能把 `@all`、`@here` 自动视为 @ Bot。
5.  不能把普通字符串中的邮箱或代码片段误判为 mention。
6.  对大小写、标点和 Markdown 格式增加测试。

## 7.4 Thread 路由

规则：

-   顶层频道消息 `root_id` 为空。
-   顶层消息明确 @ Bot 时，`threadRootId = post.id`。
-   Thread 回复 `root_id` 非空时，`threadRootId = post.root_id`。
-   已经登记为 Bot 活跃 Thread 的后续回复，可以继续进入该 Thread。
-   未登记 Thread 的普通回复不能触发 Bot。
-   所有回复必须带原 `channelId` 和 `rootId`。
-   Bot 回复默认使用 Thread，不在频道顶层另开一条消息。

会话 Key 示例：

``` text
mattermost:<accountId>:dm:<dmChannelId>
mattermost:<accountId>:thread:<channelId>:<rootPostId>
```

Key 必须使用稳定 ID，不得使用频道名称、用户名或消息正文。

## 7.5 Mattermost API 适配

优先复用当前 REST Transport，不在本阶段同时引入 WebSocket 架构。

至少覆盖：

-   `GET /api/v4/users/me`
-   `GET /api/v4/channels/{channel_id}`
-   `GET /api/v4/channels/{channel_id}/members`
-   `GET /api/v4/channels/{channel_id}/posts`
-   `POST /api/v4/posts`

具体参数、分页和服务器版本差异必须以实际 Mattermost 版本及 API
响应验证。不要根据猜测硬编码分页语义。

读取帖子时必须保留：

-   `id`
-   `channel_id`
-   `user_id`
-   `message`
-   `create_at`
-   `edit_at`
-   `delete_at`
-   `root_id`
-   `file_ids`
-   `type`

## 7.6 Mattermost 回复

DM：

-   回复目标是已验证 DM channel。
-   发送前重新校验账号、channel 和 peer。
-   不得向任意 user ID 猜测创建新的 DM。

Thread：

-   使用原 `channel_id`。
-   使用原 `root_id`。
-   通过 `POST /api/v4/posts` 发送 Thread 回复。
-   不允许回复到其他 Thread。
-   回复发送失败时保留 Outbox 记录。

## 7.7 频道授权

新增频道级授权配置，不能复用 DM 的 PairingRequest 逻辑。

至少支持：

-   `allowedChannelIds`
-   `allowedUserIds`（可选）
-   `requireBotMention`
-   `replyInThread`
-   `allowThreadContinuation`
-   `enabled`

安全默认：

-   未明确配置的频道不接入。
-   频道内普通消息不处理。
-   Bot 自己的消息不处理。
-   用户身份以 Mattermost `user_id` 为准。
-   敏感工具权限仍由当前 actor 的授权和审批策略决定。
-   频道白名单不等于所有成员拥有所有工具权限。

## 7.8 Mattermost 附件

复用现有附件安全机制，不能因为支持频道就绕过校验。

-   根据 post `file_ids` 读取附件。
-   校验文件确实属于当前 post/channel。
-   校验 Bot/当前 actor 有权读取。
-   限制单条最多 8 个附件、总大小 64MB（或更严格的管理员配置）。
-   下载不跟随不可信重定向。
-   下载失败时整批标记失败，不执行不完整任务。
-   记录附件原始 file ID 和下载结果。
-   不把文件 URL 直接交给模型作为可访问地址。

------------------------------------------------------------------------

# 8. 微信接入详细设计

## 8.1 微信会话隔离

微信联系人 Session Key：

``` text
weixin:<accountId>:contact:<from_user_id>
```

每个 `from_user_id` 对应一个独立 Session。

要求：

-   联系人 A 的消息不能进入联系人 B 的 Session。
-   微信消息不能默认进入本地 DSH 主 Session。
-   不同微信机器人账号之间隔离。
-   不同 Partner Companion 之间隔离。
-   同一联系人后续消息继续使用同一个 Session。
-   联系人授权撤销后，不再接收和执行该联系人消息。

对于升级前已经共用主 Session 的旧渠道：

-   不删除旧 Session。
-   不自动复制整份历史。
-   新版本首次接收消息时，为联系人创建隔离 Session。
-   保留旧历史可在 DSH 本地会话查看。
-   如需迁移上下文，只允许显式选择"摘要迁移"，不得复制无关原始对话。
-   提供回滚说明。

## 8.2 微信 context_token

`context_token` 只负责微信协议回复上下文：

-   与 `from_user_id` 绑定。
-   只由微信 Adapter 和 Reply Adapter 使用。
-   不写入 LLM Prompt。
-   不用于 DSH Memory。
-   不跨联系人共享。
-   不在日志中输出完整值。
-   如果持久化，按敏感凭据处理。

## 8.3 微信消息 ID

优先使用稳定的 `message_id` 或 `msg_id`。

如果字段缺失：

-   评估 `seq` 是否在同一账号/联系人范围内稳定。
-   使用组合键生成外部事件 ID。
-   不得仅使用消息正文 hash 作为唯一
    ID，因为相同文本可能是用户合法发送的两条消息。

## 8.4 微信消息回复

回复目标必须来自原始消息：

-   `to_user_id` = 原始 `from_user_id`。
-   `context_token` = 对应联系人最近有效 token。
-   不能使用最近活跃的其他联系人。
-   不允许默认广播或向未知联系人发送。
-   附件发送沿用现有加密、上传、大小和可信域名校验。

## 8.5 微信续读测试

必须覆盖：

1.  正常收到消息并提交 buffer。
2.  Inbox 入库成功、进程退出。
3.  Inbox 入库失败、进程退出。
4.  相同 buffer 重放。
5.  相同消息 ID 重复返回。
6.  联系人 A/B 同时发消息。
7.  回复 context token 变化。
8.  认证失效和重试。
9.  长轮询超时。
10. 附件下载失败。

------------------------------------------------------------------------

# 9. Conversation Router 与 Session History

## 9.1 会话映射

建立唯一的 `conversationKey -> sessionId` 映射。

建议规则：

  ------------------------------------------------------------------------------------------
  来源                    Conversation Key                           Session
  ----------------------- ------------------------------------------ -----------------------
  微信联系人              `weixin:account:contact:user`              每联系人一个

  Mattermost DM           `mattermost:account:dm:channel`            每个 DM 一个

  Mattermost Thread       `mattermost:account:thread:channel:root`   每个 Thread 一个

  Mattermost 顶层 @       转成以当前 post 为 root 的 Thread          每个 @ 请求一个 Thread

  本地 DSH                沿用原有 local Session                     不改变
  ------------------------------------------------------------------------------------------

## 9.2 Session 创建规则

-   先查 conversationKey。
-   找到且 Session 可恢复：复用。
-   找到但 Session 已归档/不可恢复：按现有 DSH Session Recovery
    机制处理。
-   没找到：创建新的 Session 和独立 cwd。
-   创建失败：不提交 Inbox 为 completed。
-   不允许多个不同 conversationKey 意外指向同一个 Session。
-   如果管理员显式开启共享
    Session，必须在配置中清楚标识，并增加回归测试。

## 9.3 Session History

短期上下文完全依赖当前 DSH Session。

禁止：

-   每条消息都调用远端渠道接口读取聊天历史。
-   把整个频道历史拼进 Prompt。
-   把其他联系人最近消息推给当前 Session。
-   每次都把旧对话摘要拼进用户消息正文。
-   将工具输出、其他线程的上下文作为当前用户指令。

允许：

-   DSH 原生 Session History。
-   DSH 原生压缩和历史恢复机制。
-   经过授权的长期记忆检索。
-   只与当前 `conversationKey` 相关的历史摘要。

## 9.4 记忆范围

默认：

  场景                               Memory Scope
  ---------------------------------- --------------------------------
  微信联系人                         联系人独立
  Mattermost DM                      DM 独立
  Mattermost Thread                  Thread 独立
  Mattermost Channel Shared Memory   默认关闭
  Companion Global Memory            只保存明确的长期偏好和稳定事实

`memoryScopeId` 可以显式共享长期记忆，但共享 Memory 不代表共享 Session。

## 9.5 消息来源记录

扩展 `recordInputOrigin()`，至少保存：

-   messageId
-   batchId
-   routeId
-   platform
-   accountId
-   channelId
-   conversationKey
-   actorId
-   threadRootId
-   externalMessageId

历史召回必须根据 origin 过滤，不允许把同一 Session
之外的其他渠道消息当成当前用户历史。

## 9.6 多人 Thread

同一 Mattermost Thread 允许多人补充：

-   每条消息都保存 actorId。
-   同一 Thread 使用一个 Session。
-   每条输入在内部保留发送人标记。
-   不能把 A 的身份伪装成 B。
-   工具授权按当前触发消息的 actorId 判断。
-   频道白名单不能自动授予所有成员敏感工具权限。

------------------------------------------------------------------------

# 10. Memory 机制

## 10.1 三层模型

``` text
Layer 1: Session History
  当前 conversationKey 的连续对话

Layer 2: Long-term Memory
  经过筛选、授权的跨会话事实和偏好

Layer 3: Channel Metadata
  channelId / threadRootId / actorId / contextToken / reply target
```

第三层是路由元数据，不是 AI 记忆。

## 10.2 检索规则

-   只有 `automation.memory.enabled` 或明确配置允许时才检索长期记忆。
-   当前问题与记忆无关时，不检索。
-   检索结果必须带来源。
-   不能将另一个用户的隐私内容带入当前会话。
-   Mattermost 频道共享记忆默认关闭。
-   微信联系人之间默认不共享记忆。
-   Companion Global Memory
    只放稳定的用户偏好、项目事实和长期约束，不存放整段原始聊天。

## 10.3 不要再采用的方案

-   每条消息主动读取上一段上下文并推送。
-   每次调用一个"读取 Mattermost 上下文"的 API。
-   把频道最近 N 条消息统一拼接。
-   用同一个主 Session 解决跨渠道上下文共享。
-   用显示名称或频道名作为 Memory Key。

## 10.4 验收

-   A 微信联系人提到的内容，B 联系人无法在短期上下文中看到。
-   Mattermost Thread A 的消息不会出现在 Thread B。
-   同一个 Thread 的下一轮能看到上一轮。
-   显式启用共享 Memory 后，只能召回允许共享的长期事实。
-   禁用 Memory 后仍然保留当前 Session History。
-   Context Token 从不进入模型消息。

------------------------------------------------------------------------

# 11. Codex 子 Agent 执行体系

## 11.1 当前问题

现有 `EphemeralExecutionService` 通过 `ctx.agents.create()` 创建 DSH
Agent。它是 DSH 临时工作 Agent，不是 Codex。

本次保留现有 DSH 执行器，用于 MCP、Skill、Partner 工具和业务操作；新增
Codex 执行后端，专门处理代码开发任务。

## 11.2 首选集成路线

优先检查当前安装的 DSH 版本是否兼容并提供：

-   `@deepseek-ai/dsh-subagent`
-   `@deepseek-ai/dsh-subagent-codex`
-   `@deepseek-ai/dsh-tool-subagent`
-   `@deepseek-ai/dsh-tool-subagent-control`

上游 DSH 当前公开实现中的 `@deepseek-ai/dsh-subagent-codex` 使用官方
Codex App Server 协议，在子进程中启动 Codex App
Server、创建临时线程并执行一次任务。

**重要区别：** 这不是简单执行宿主机 PATH 中的 `codex exec`
命令。它是通过 Codex 官方 App Server 运行 Codex
子任务。如果项目要求必须调用 `codex exec` CLI，则需要单独实现
`CodexCliProvider`，并按实际安装版本验证 `codex exec --help`、JSON
输出、权限参数和退出码。不得把 App Server 和 CLI 两种协议混写。

首选顺序：

1.  验证上游 Codex Provider 与当前 DSH 运行时兼容。
2.  如果兼容，优先复用上游 Provider。
3.  如果当前 DSH 版本不兼容，先给出兼容性报告。
4.  只有明确需要 `codex exec` CLI，才新增独立 CLI Provider。
5.  不得复制整个 DSH Subagent Runtime。

## 11.3 统一执行接口

建议抽象：

``` typescript
interface CodeExecutionRequest {
  runId: string;
  parentSessionId: string;
  cwd: string;
  task: string;
  acceptanceCriteria: string[];
  allowedPaths?: string[];
  testCommands?: string[];
  timeoutMs: number;
  signal: AbortSignal;
}

interface CodeExecutionResult {
  runId: string;
  subagentId?: string;
  status: 'completed' | 'partial' | 'failed' | 'canceled' | 'timed_out';
  summary: string;
  changedFiles: string[];
  testResults: string[];
  diagnostics?: string;
}
```

具体实现可以是：

-   `DshSubagentCodexExecutor`
-   `CodexCliExecutor`
-   `DshBusinessExecutor`

不要让业务层直接操作 app-server JSON-RPC 细节。

## 11.4 代码任务的强制路由

增加专用的 `partner_code_execute` 工具，或对现有工作执行工具增加明确的
`executor` 参数。

建议职责：

  工具                     执行后端
  ------------------------ --------------------------
  `partner_code_execute`   Codex
  `partner_work_execute`   现有 DSH Ephemeral Agent
  普通聊天                 当前 DSH Main Agent

代码任务包括：

-   读取/修改仓库代码。
-   Bug 修复。
-   重构。
-   编写单元测试。
-   运行构建。
-   分析 PR 和 Git Diff。
-   代码架构实现。

代码任务不能仅由 Prompt
告诉模型"你应该委派"。必须存在真实可调用的工具执行路径。

`partner_code_execute` 执行时：

1.  验证当前来源 Session。
2.  验证当前用户/actor 的权限。
3.  验证工作目录属于允许的工作区。
4.  验证 Codex Provider 已注册。
5.  验证任务文本非空，验收标准存在。
6.  创建 Partner `runId`。
7.  通过 DSH `ctx.subagents.startActivation()` 启动 `codex` Provider。
8.  选择合适的 delivery 模式。
9.  保存 `subagentId` 与 `runId` 的映射。
10. 收集结果并校验 `stopReason`。
11. 释放 activation 和外部进程资源。
12. 向原 Session 交付真实结果。

如果采用 `delivery: 'caller'`，调用方必须 await
`activation.result`，并在 finally 中执行 `activation.dispose()`。

如果采用 `delivery: 'parent'`，DSH Runtime 负责通知父 Agent；Partner
只维护自己的 run ledger，不要再额外向父 Agent 注入第二份完成通知。

## 11.5 Codex 结果判定

只有以下条件全部满足才允许标记 `completed`：

-   子进程/Provider 正常结束。
-   `stopReason === 'completed'`。
-   存在非空最终结果。
-   结果包含真实执行证据。
-   如果要求测试，必须有真实测试命令和退出结果。
-   不得把 `partial_answer` 或诊断文本当作成功结果。

失败状态至少区分：

-   provider_missing
-   auth_failed
-   startup_failed
-   process_failed
-   timeout
-   canceled
-   permission_denied
-   invalid_result
-   cleanup_failed

## 11.6 Codex 权限与安全

-   默认使用受限工作区。
-   优先采用 Provider 支持的自动审查权限模式，例如经过验证的
    `approve-for-me`。
-   不默认开启 `dangerously-bypass-approvals-and-sandbox`。
-   不把 API Key 放在 Prompt。
-   不将整个用户 HOME 目录作为工作目录。
-   不允许默认写入工作区之外的路径。
-   不允许通过环境变量泄漏凭据。
-   Codex 完成后，主 Agent 必须检查 Git Diff。
-   Codex 执行失败时，不得静默改用 DSH Agent 自己执行同一任务。

## 11.7 长任务处理

-   记录 `runId`、`subagentId`、cwd、开始时间、结束时间、状态和诊断。
-   监控 activation 的 `result`。
-   取消时调用对应 activation 的释放/取消机制。
-   服务关闭时清理所有活跃 activation。
-   重启后将未结算运行标记为 `interrupted`，不能假装仍在运行。
-   恢复任务前先检查工作区、Git Diff 和已有产物。
-   不把 `subagentId` 当作 `jobId`。
-   如果使用 DSH `job` 工具，必须使用真实 Job Registry 返回的 Job ID。

## 11.8 Prompt 指导

主 Agent 的系统提示中加入明确规则：

``` text
代码仓库修改、Bug 修复、重构和测试任务必须使用 partner_code_execute。
不得把这些任务交给普通 partner_work_execute 后再由 DSH Agent 自己完成。
只有 Codex Provider 不可用时才报告阻塞，不得静默降级。
子任务完成后，必须检查返回结果和 Git Diff，再向用户报告。
不能把启动成功当作任务完成。
```

提示词只是模型引导，真正的执行保证来自 `partner_code_execute`
的代码路径和运行时检查。

------------------------------------------------------------------------

# 12. 回复 Outbox 和消息发送可靠性

## 12.1 Outbox 流程

``` mermaid
stateDiagram-v2
  [*] --> pending
  pending --> sending
  sending --> sent
  sending --> unknown
  sending --> failed
  unknown --> sent
  unknown --> failed
  failed --> pending
```

状态：

-   `pending`：等待发送。
-   `sending`：正在请求远端 API。
-   `sent`：远端返回成功并记录外部 ID。
-   `unknown`：请求超时或连接断开，无法确认远端是否已经接收。
-   `failed`：明确失败。

## 12.2 防重复回复

-   发送前创建唯一 `deliveryId`。
-   记录 conversationKey 和 OutboundTarget。
-   发送成功后保存远端消息 ID。
-   失败后保存错误。
-   网络超时后标记 `unknown`，不要自动盲目重发。
-   如果远端 API 支持经过验证的幂等键，才可以按该机制重试。
-   不得因为进程重启就重新发送所有未确认消息。

## 12.3 回复路由

-   微信回复原始 `from_user_id`，使用对应 context token。
-   Mattermost DM 回复原始 DM channel。
-   Mattermost Thread 回复原始 `channelId + rootId`。
-   本地 DSH 发起的任务不应该默认向某个 Mattermost 频道发消息。
-   主动通知仍沿用用户显式配置的 delivery target。
-   不允许因为原始目标失效而静默切换到另一个联系人或频道。

------------------------------------------------------------------------

# 13. 权限和安全设计

## 13.1 身份校验

每条入站消息必须保留：

-   平台账号 ID。
-   频道配置 ID。
-   外部频道 ID。
-   actorId。
-   externalMessageId。
-   conversationKey。
-   threadRootId。

禁止只保留 displayName。

## 13.2 Mattermost 频道安全

-   频道必须在管理员 allowlist 中。
-   Bot 必须属于该频道。
-   用户身份必须通过 Mattermost user ID 验证。
-   默认只处理 @ Bot 或已接入 Thread。
-   不处理其他频道普通聊天。
-   不响应 Bot 自己的消息。
-   不执行未知 Bot/Webhook 发送的消息。

## 13.3 工具授权

当前 `work-tool.ts` 中的授权校验需要扩展为 actor-aware。

对于 Thread：

-   每条用户消息有自己的 actorId。
-   需要执行敏感工具时，以触发任务的 actorId 进行授权。
-   不得把 Thread 内任意一个成员的权限继承给其他成员。
-   频道白名单只代表允许 Bot
    接收该频道消息，不代表允许所有成员调用所有工具。

## 13.4 日志

日志允许记录：

-   eventId
-   batchId
-   conversationKey 的脱敏值
-   actorId
-   状态
-   耗时
-   错误分类

日志禁止记录：

-   Bot Token
-   Personal Access Token
-   完整微信 context token
-   Authorization Header
-   用户附件正文
-   无必要的完整聊天正文

------------------------------------------------------------------------

# 14. 推荐目录结构

这是目标目录，不要求一次性创建所有文件。开发 Agent
必须优先复用现有文件，避免重复抽象。

``` text
src/
  channels/
    core/
      inbound-envelope.ts
      outbound-target.ts
      conversation-key.ts
      message-policy.ts

    inbox/
      database.ts
      migrations/
      inbox-repository.ts
      cursor-repository.ts
      batch-repository.ts
      inbox-worker.ts
      inbox-recovery.ts
      coalescer.ts
      dispatcher.ts
      outbox-repository.ts

    mattermost/
      client.ts
      identity.ts
      poller.ts
      message-normalizer.ts
      mention-parser.ts
      channel-access.ts
      thread-router.ts
      reply-adapter.ts
      media-adapter.ts

    weixin/
      # 保留现有 api/poll/connect/types/media
      # 增加持久化游标和 Inbox handoff

  conversations/
    conversation-router.ts
    session-route.ts
    session-migration.ts
    memory-scope.ts
    input-origin.ts

  execution/
    service.ts
    work-tool.ts
    code-tool.ts
    code-executor.ts
    codex-subagent-executor.ts
    execution-ledger.ts
    execution-domain.ts
```

如果当前项目已有相同职责模块，优先扩展现有模块，不要为了符合目录示例强行搬迁文件。

------------------------------------------------------------------------

# 15. 分阶段实施计划

必须按顺序完成。不要并行修改互相依赖的模块。

## Phase 0：基线核对和问题复现

### 目标

确认实际工作区与 SPEC 中的代码现状一致，复现当前失败问题。

### 任务清单

  ----------------------------------------------------------------------------------------------------------------------
  ID                任务              解决办法                                              验收
  ----------------- ----------------- ----------------------------------------------------- ----------------------------
  P0-01             检查 Git 状态     `git status --short --branch`，保留本地未提交改动     输出分支和 dirty 文件

  P0-02             核对版本          检查 package.json、lockfile、DSH Runtime 版本         输出版本矩阵

  P0-03             关键代码定位      阅读                                                  输出真实调用链
                                      transport、manager、agent-runtime、execution、store   

  P0-04             当前测试基线      运行现有 build/test                                   记录通过/失败数量

  P0-05             Mattermost        使用真实或模拟服务器验证 DM、频道、Thread             输出请求/响应样本，脱敏
                    现状复现                                                                

  P0-06             微信续读复现      模拟 buffer 重启、重复消息                            记录是否丢失/重复

  P0-07             Codex 委派复现    检查 Provider、工具可见性、CLI/App Server             输出真实启动日志和失败阶段
  ----------------------------------------------------------------------------------------------------------------------

### 交付物

-   `docs/dev/phase-0-baseline.md`
-   当前架构图。
-   版本兼容矩阵。
-   原有测试基线。
-   失败复现记录。

### 通过条件

没有完成 Phase 0 报告，不允许修改核心代码。

## Phase 1：架构设计和数据模型

### 目标

先定义消息、会话、游标、批次、回复和执行记录的结构。

### 任务清单

  -----------------------------------------------------------------------------------
  ID                任务              解决办法                 验收
  ----------------- ----------------- ------------------------ ----------------------
  P1-01             InboundEnvelope   统一两种渠道事件         类型检查和序列化测试

  P1-02             ConversationKey   设计稳定 Key             相同来源生成相同 Key

  P1-03             OutboundTarget    统一回复目标             微信/DM/Thread
                                                               路由测试

  P1-04             Inbox Schema      设计 SQLite 表           migration 可创建和回滚

  P1-05             Session Route     扩展会话映射             不同会话不会共享
                                                               Session

  P1-06             Memory Scope      默认隔离，显式共享       Scope 测试通过

  P1-07             Execution         明确                     类型不能混用
                    Identity          runId/subagentId/jobId   
  -----------------------------------------------------------------------------------

### 交付物

-   `docs/dev/phase-1-data-model.md`
-   SQLite migration 文件。
-   TypeScript 类型定义。
-   状态机图。

### 通过条件

数据模型和迁移经审查通过后才开始 Phase 2。

## Phase 2：Durable Inbox 和续读

### 目标

先完成可靠消息入库和游标提交，不接入 AI 执行。

### 任务清单

  -------------------------------------------------------------------------------------
  ID                任务              解决办法                     验收
  ----------------- ----------------- ---------------------------- --------------------
  P2-01             SQLite Provider   WAL、短事务、migration       并发读写测试

  P2-02             Inbox Repository  insert/dedupe/claim/settle   重复 event
                                                                   不重复插入

  P2-03             Cursor Repository cursor 原子提交              入库失败不推进游标

  P2-04             Lease             领取和过期恢复               两个 Worker
                                                                   不同时处理同一 batch

  P2-05             WeChat Buffer     buffer 和消息原子保存        重启不丢消息

  P2-06             Mattermost Cursor since + overlap + 去重       同时间戳消息不遗漏

  P2-07             Dead Letter       失败记录和人工诊断           超过重试上限进入
                                                                   dead_letter
  -------------------------------------------------------------------------------------

### 测试重点

-   事务提交前进程退出。
-   事务提交后进程退出。
-   相同 event 重复 10 次。
-   游标回退。
-   API 返回空页。
-   API 返回上限数据。
-   两个 worker 同时 claim。
-   租约过期后恢复。

### 通过条件

所有续读、去重和崩溃恢复测试通过，才允许进入 Phase 3。

## Phase 3：消息 Coalescer 和 Dispatcher

### 目标

实现连续消息合并、Steer 和 Queue。

### 任务清单

  ID      任务               解决办法                  验收
  ------- ------------------ ------------------------- ------------------------
  P3-01   Debounce           基于数据库 readyAt        窗口内消息合并
  P3-02   同会话合并         按 conversationKey 分组   不同会话绝不合并
  P3-03   多人 Thread 合并   保留 actorId              多人消息顺序正确
  P3-04   Steer              复用 `agents.steer()`     同任务补充进入当前任务
  P3-05   Queue              每会话 FIFO               新任务独立回答
  P3-06   并行               不同会话独立 lane         A 阻塞不影响 B
  P3-07   限流               全局/会话上限             队列满不丢数据

### 通过条件

一个合并批次只产生一次 followup；独立批次分别执行；不同会话并行。

## Phase 4：微信会话隔离与回归

### 目标

微信每个联系人独立 Session，保留原有消息、附件和回复能力。

### 任务清单

  ------------------------------------------------------------------------------
  ID                任务              解决办法          验收
  ----------------- ----------------- ----------------- ------------------------
  P4-01             联系人 Session    accountId +       A/B Session 不同
                    Key               from_user_id      

  P4-02             Session           Conversation      重启后恢复同一 Session
                    持久化映射        Router            

  P4-03             Context Token     独立联系人状态    A 回复不使用 B token
                    路由                                

  P4-04             Buffer 持久化     Inbox 原子提交    重启续读

  P4-05             微信附件回归      复用原媒体传输    图片/文件正常

  P4-06             历史隔离迁移      不复制整份主      原历史保留，新消息隔离
                                      Session           
  ------------------------------------------------------------------------------

### 通过条件

微信私聊、附件、回复、重启续读、不同联系人隔离全部通过。

## Phase 5：Mattermost DM、频道和 Thread

### 目标

在保留 DM 的基础上增加频道和 Thread。

### 任务清单

  -------------------------------------------------------------------------
  ID                任务              解决办法           验收
  ----------------- ----------------- ------------------ ------------------
  P5-01             Bot 身份          获取真实           身份校验正确
                                      userId/username    

  P5-02             DM 保留           兼容原双人 DM      旧功能回归通过

  P5-03             频道校验          不再限制双人房间   多成员频道可连接

  P5-04             频道白名单        明确允许 channel   未授权频道不处理
                                      ID                 

  P5-05             @ 识别            userId/username    误触发测试通过
                                      精确识别           

  P5-06             Thread Root       规范化 root_id     Thread Key 稳定

  P5-07             Thread Session    每 Thread 独立     A/B Thread
                                      Session            历史隔离

  P5-08             Thread 回复       原 channelId +     回复位置正确
                                      rootId             

  P5-09             多人协作          每条消息保留       授权按 actor 判断
                                      actorId            

  P5-10             附件              校验 file_ids      不跨频道读取
  -------------------------------------------------------------------------

### 通过条件

DM、频道 @、Thread 连续对话、多人 Thread、附件和权限测试全部通过。

## Phase 6：Codex 子 Agent 接入

### 目标

代码任务真正交给 Codex，不再由临时 DSH Agent 自己完成。

### 任务清单

  ID      任务                解决办法                      验收
  ------- ------------------- ----------------------------- ------------------------
  P6-01   DSH Provider 兼容   核对版本和依赖                兼容报告
  P6-02   Codex 认证          检查真实账号状态              只读 smoke test
  P6-03   Provider 注册       注册 codex provider           `getProvider()` 可发现
  P6-04   Code Tool           新增 `partner_code_execute`   Tool Schema 可见
  P6-05   Activation          使用 `startActivation()`      真实 subagent 启动
  P6-06   Result              读取 SubagentResult           stopReason 判断正确
  P6-07   Cleanup             dispose/abort                 不残留子进程
  P6-08   Run Ledger          保存 runId/subagentId         状态可查询
  P6-09   Prompt Guidance     指示代码任务必须委派          Prompt 和 Tool 测试
  P6-10   No Fallback         Codex 不可用则明确失败        不会静默转 DSH

### 必须执行的真实测试

1.  Codex 只读读取项目 README。
2.  Codex 创建一个临时测试文件。
3.  Codex 修改该文件。
4.  Codex 执行指定测试。
5.  主 Agent 收到真实完成结果。
6.  Codex 任务取消。
7.  Codex Provider 不存在。
8.  Codex 认证失败。
9.  Codex 进程异常退出。
10. 任务超时。
11. 服务关闭时清理进程。

### 通过条件

必须证明真正启动了 Codex App Server 或经过批准的 Codex CLI
Provider。只看到 `started subagent`
不算完成；必须看到真实执行结果和工作区变化。

## Phase 7：集成、压力和发布

### 目标

验证多渠道并行、消息可靠性和部署兼容性。

### 任务清单

  ID      任务             解决办法                          验收
  ------- ---------------- --------------------------------- ------------------
  P7-01   双渠道并行       微信+Mattermost 同时发消息        互不阻塞
  P7-02   多 Thread 并行   多个 Thread 同时执行              Session 隔离
  P7-03   消息风暴         连续发送 100 条测试消息           无静默丢失
  P7-04   进程重启         执行期间强制重启                  状态可恢复
  P7-05   重复事件         重放外部消息                      不重复入库
  P7-06   Outbox           模拟发送超时                      unknown 状态正确
  P7-07   原功能回归       运行完整测试                      原测试通过
  P7-08   Package          build + pack verify               发布包完整
  P7-09   部署             真实 DSH 环境                     运行验收
  P7-10   文档             更新 direct-channels 和配置说明   文档与代码一致

------------------------------------------------------------------------

# 16. 完整验收矩阵

最终发布前必须逐项填写，不允许只写"基本正常"。

  ID          场景                       预期结果                 状态
  ----------- -------------------------- ------------------------ --------
  MSG-001     微信联系人 A 发消息        进入 A Session           待验收
  MSG-002     微信联系人 B 发消息        进入 B Session           待验收
  MSG-003     A/B 同时发消息             互不污染                 待验收
  MSG-004     微信连续 3 条短消息        合并成一个 Batch         待验收
  MSG-005     微信独立新请求             单独 Queue 和回答        待验收
  MSG-006     微信明确补充标记           按配置 Steer             待验收
  MSG-007     微信 buffer 重启恢复       不丢失未入库消息         待验收
  MSG-008     微信重复消息               不重复执行               待验收
  MM-001      Mattermost DM              正常回复                 待验收
  MM-002      Mattermost 频道普通聊天    默认不响应               待验收
  MM-003      顶层 @ Bot                 创建 Thread              待验收
  MM-004      Thread 内继续发言          进入原 Thread Session    待验收
  MM-005      Thread A/B                 两个 Session 隔离        待验收
  MM-006      两个人同一 Thread          保留两人 actorId         待验收
  MM-007      Bot 回复                   回复原 Thread            待验收
  MM-008      未授权频道 @ Bot           拒绝处理                 待验收
  MM-009      未授权用户触发敏感操作     权限拒绝/审批            待验收
  MM-010      Bot 自己发言               不触发循环               待验收
  QUEUE-001   同一会话短窗口消息         一个 Batch               待验收
  QUEUE-002   同一会话独立请求           FIFO 多次回答            待验收
  QUEUE-003   不同会话同时执行           并行                     待验收
  QUEUE-004   执行中同 Thread 补充       Steer                    待验收
  QUEUE-005   执行中不同 Thread 新任务   不插入旧任务             待验收
  QUEUE-006   队列满                     数据保留，不丢失         待验收
  MEM-001     同 Session 下一轮          能看到自己的历史         待验收
  MEM-002     不同联系人                 看不到对方短期历史       待验收
  MEM-003     不同 Thread                看不到对方 Thread 历史   待验收
  MEM-004     显式共享长期记忆           只召回允许内容           待验收
  MEM-005     微信 context token         不进入 Prompt            待验收
  CODE-001    Codex Provider 缺失        明确报错                 待验收
  CODE-002    Codex 只读任务             真实启动                 待验收
  CODE-003    Codex 修改任务             文件真实变化             待验收
  CODE-004    Codex 测试任务             返回真实退出结果         待验收
  CODE-005    Codex 完成                 主 Agent 收到结果        待验收
  CODE-006    Codex 取消                 进程和资源释放           待验收
  CODE-007    Codex 超时                 状态 timed_out           待验收
  CODE-008    Codex 失败                 不伪造 completed         待验收
  CODE-009    Codex 失败                 不静默退回 DSH Agent     待验收
  SEC-001     Token 日志检查             无敏感凭据               待验收
  SEC-002     跨联系人回复               不允许                   待验收
  SEC-003     跨 Thread 回复             不允许                   待验收
  SEC-004     actor 权限                 按真实 actor 判断        待验收
  REC-001     Inbox 写入失败             游标不推进               待验收
  REC-002     进程处理中断               可识别 interrupted       待验收
  REC-003     Outbox 发送超时            unknown，不盲目重发      待验收
  REG-001     原微信登录                 不回归                   待验收
  REG-002     原微信附件                 不回归                   待验收
  REG-003     原 Mattermost DM           不回归                   待验收
  REG-004     原本地 DSH 会话            不回归                   待验收
  REG-005     原 MCP/Skill/审批          不回归                   待验收

------------------------------------------------------------------------

# 17. 性能与资源要求

第一版目标值：

  指标                   目标
  ---------------------- ------------------------
  消息入 Inbox 延迟      正常网络下 1 秒级
  Coalesce 窗口          约 1.2 秒
  空闲 Mattermost 轮询   5～10 秒可配置
  有待处理任务时轮询     1～2 秒可配置
  单会话并发 Agent       1
  不同会话并发           配置控制
  Inbox 事件保留         可配置，默认至少 30 天
  已完成批次保留         可配置
  单批附件               最多 8 个
  单批附件总大小         默认 64MB
  单批文本               默认 32KB

性能测试必须同时覆盖：

-   100 条消息连续入库。
-   10 个不同 Thread 并行。
-   微信联系人与 Mattermost Thread 并行。
-   一个 Agent 长时间执行，其他会话继续接收。
-   SQLite 锁冲突和重试。
-   大附件和网络慢速传输。

不要为了提升吞吐而让同一 Session 同时运行两个相互竞争的 Agent Turn。

------------------------------------------------------------------------

# 18. 配置设计建议

以下是目标配置示意，必须根据项目现有 Settings Schema、UI
和配置加载方式实现，不要直接复制为未经校验的 YAML。

``` yaml
channels:
  mattermost:
    enabled: true
    requireBotMention: true
    replyInThread: true
    allowThreadContinuation: true
    allowedChannelIds: []
    allowedUserIds: []
    pollIntervalMs: 5000
    activePollIntervalMs: 1500

  weixin:
    enabled: true
    sessionMode: per-contact
    persistUpdateBuffer: true

inbox:
  enabled: true
  batchWindowMs: 1200
  maxBatchWaitMs: 4000
  maxBatchEvents: 8
  maxPendingPerConversation: 50
  maxPendingGlobal: 200
  leaseMs: 30000
  maxAttempts: 5

memory:
  defaultScope: conversation
  shareMattermostChannelMemory: false
  shareWeixinContactMemory: false

execution:
  codeExecutor: codex
  codexProviderName: codex
  failClosed: true
  maxConcurrentCodexRuns: 2
  defaultTimeoutMinutes: 30
```

配置要求：

-   所有参数有类型校验。
-   数值有上下限。
-   缺省行为安全。
-   不在前端展示 Token 明文。
-   运行中修改配置不能破坏正在处理的 Batch。
-   新配置只影响新进入的消息。
-   历史消息和已有 Session 不因配置变更而被静默重写。

------------------------------------------------------------------------

# 19. 数据迁移与兼容策略

## 19.1 PartnerState Migration

当前公开基线 `schemaVersion` 为 14。若需要给 `ChannelSession`
增加字段，按项目现有迁移机制提升版本。

迁移要求： 不用兼容旧版本，升级后不再回退。

## 19.2 SQLite Migration

-   独立维护 schema version。
-   每个 migration 可重复检测。
-   migration 失败必须回滚事务。
-   启动时先完成 migration，再启动渠道消费。
-   migration 失败时渠道进入 error 状态，不继续消费。
-   数据库备份后再执行破坏性迁移。

## 19.3 回滚

回滚前：

1.  停止新版本渠道消费。
2.  导出 Inbox、Cursor、Outbox 和执行记录。
3.  备份 PartnerState 和凭据。
4.  确认是否有未完成 Codex 任务。
5.  确认新 Session 已经写入 DSH Session Store。
6.  再回退代码。

旧版本不认识新 SQLite Inbox
时，不能直接恢复旧版本并继续消费同一个渠道，否则可能出现消息重复或丢失。

------------------------------------------------------------------------

# 20. 开发 Agent 执行纪律

## 20.1 任务粒度

每个 PR 或阶段尽量控制在一个明确主题：

-   PR 1：Inbox Schema 和 Repository。
-   PR 2：WeChat cursor durability。
-   PR 3：Message Coalescer。
-   PR 4：Conversation Router 和微信 Session 隔离。
-   PR 5：Mattermost Channel/Thread Adapter。
-   PR 6：Codex Executor。
-   PR 7：集成和回归。

不允许一个 PR 同时重写 Mattermost、微信、Memory 和 Codex。

## 20.2 修改前

必须先输出：

``` text
任务编号：
目标：
当前实现位置：
调用链：
准备修改的文件：
不会修改的文件：
数据结构变化：
兼容性影响：
测试计划：
回滚方式：
```

## 20.3 修改后

必须运行：

``` bash
npm run build
npm test
npm pack --dry-run
```

如果项目当前脚本与以上命令不同，先核对
package.json，再执行实际可用命令，不得声称运行了未执行的命令。

同时：

-   检查 Git diff。
-   检查未跟踪文件。
-   检查凭据和本地配置是否被意外提交。
-   检查测试是否有 skip/todo。
-   检查是否删除旧功能。
-   检查新增依赖和锁文件变化。
-   检查资源是否 dispose。
-   检查异常路径是否推进 cursor。
-   检查所有外部消息是否有 eventId。
-   检查每条回复是否有原始 OutboundTarget。

## 20.4 发现 SPEC 与代码不一致

如果发现：

-   DSH API 与本文示例不同；
-   当前依赖版本不支持某个接口；
-   当前项目结构与目标目录不同；
-   Mattermost 服务器 API 版本不同；
-   Codex Provider 不兼容；
-   Node Runtime 不支持所选 SQLite API；

必须暂停该任务，输出：

1.  现状证据。
2.  不兼容点。
3.  两种可行方案。
4.  推荐方案。
5.  对其他模块的影响。

未经确认不得用临时 hack 绕过。

## 20.5 真实测试和模拟测试

模拟测试不能代替真实联调。

最终至少需要：

-   一个真实微信联系人。
-   两个微信联系人隔离测试。
-   一个真实 Mattermost DM。
-   一个真实 Mattermost 多成员频道。
-   两个真实 Mattermost Thread。
-   一个真实 Codex 账号和 Provider。
-   一个实际代码修改任务。
-   一个实际测试任务。

凭据通过本地环境或安全凭据管理器提供，不写进测试样例和日志。

------------------------------------------------------------------------

# 21. 最终交付物

开发完成时必须交付：

  文件/产物                        内容
  -------------------------------- ------------------------------------
  `docs/architecture.md` 更新      新架构说明
  `docs/direct-channels.md` 更新   Mattermost/微信最新行为
  `docs/inbox.md`                  Inbox、cursor、batch、outbox 说明
  `docs/session-routing.md`        Session 与 Memory Scope 规则
  `docs/codex-execution.md`        Codex Provider、执行状态和故障处理
  SQLite migrations                可重复、可验证迁移
  测试代码                         单元、集成、恢复、真实联调
  配置 Schema                      新增配置和默认值
  发布说明                         兼容性、迁移、回滚和限制
  验收报告                         第 16 章所有验收项逐项结果

------------------------------------------------------------------------

# 22. 开发启动指令：先规划，不要直接写代码

把本 SPEC 交给 AI 开发 Agent 后，第一条任务必须使用以下指令：

``` text
你现在负责 DSH Partner 二次开发。

请先完整阅读本 SPEC，不要立即修改任何代码。

第一阶段只做只读检查和规划：

1. 检查当前 Git 分支、提交、未提交文件。
2. 阅读 package.json、lockfile、项目目录。
3. 阅读 Mattermost、微信、Inbox、Session、Memory、Execution 相关代码。
4. 阅读当前 DSH 依赖版本和 Subagent Provider 接口。
5. 检查当前 Codex Provider 是否可用、是否与当前 DSH 兼容。
6. 运行现有 build 和 test，建立基线。
7. 输出当前真实架构图。
8. 输出当前代码与 SPEC 的差异。
9. 输出分阶段任务清单，每个任务列出修改文件、解决办法、测试和验收条件。
10. 标记存在技术不确定性的地方，并给出验证方案。

本阶段禁止修改代码、升级依赖、创建 migration、删除文件或修改配置。

完成后等待用户确认，再开始 Phase 1。
```

用户确认后，第二条任务：

``` text
开始 Phase 1：架构设计和数据模型。

只完成数据模型、SQLite Schema、ConversationKey、OutboundTarget、
Inbox 状态机、Session Route 和 Codex 执行接口设计。

先提交设计文档和类型定义草案。
不要开始 Mattermost 或微信的完整实现。
不要修改现有业务流程。
完成类型检查和设计审查后等待验收。
```

每个阶段完成后，必须使用第 15 章的对应任务清单和第 16
章的验收矩阵进行验收。

------------------------------------------------------------------------

# 23. 最终架构验收原则

只有同时满足以下条件，才算本次改造完成：

1.  Mattermost DM、频道 @、Thread 回复工作正常。
2.  微信不同联系人具有独立短期上下文。
3.  Mattermost 不同 Thread 具有独立短期上下文。
4.  连续消息可以合并，独立任务可以分别回答。
5.  Steer 和 Queue 行为可解释、可测试。
6.  消息接收和 AI 执行分离。
7.  Inbox 和游标在进程重启后可恢复。
8.  不会因为已写回执但未执行而静默丢失消息。
9.  不会因为重连而无条件重复执行消息。
10. Reply 始终返回原始渠道、联系人或 Thread。
11. 长期记忆不会污染其他联系人或 Thread。
12. 代码任务真实进入 Codex 子 Agent。
13. Codex 失败时明确失败，不伪装成成功。
14. 主 Agent 能收到 Codex 的真实结果并检查产物。
15. 原有微信、DM、附件、审批、MCP、Skill 和本地 DSH 功能不回归。
16. 完整构建、测试、打包和部署验收通过。

**最重要的验收标准：系统必须从"能回复消息"升级为"消息不丢、上下文不串、任务不重复、代码执行确实委派、结果可追踪"。**
