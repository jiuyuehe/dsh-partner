# DSH Partner

面向 DeepSeek Harness 的长期 AI 伙伴与多渠道协作插件。每个伙伴有独立身份、预设、模型和能力授权，可按需启用记忆、持续关注与任务协作。

[![npm](https://img.shields.io/npm/v/%40lemoncat7%2Fdsh-partner)](https://www.npmjs.com/package/@lemoncat7/dsh-partner)

本次发布：[2.23.26 更新说明](docs/releases/2.23.26.md)，包含 [2.21.12 会话与自主活动改进](docs/releases/2.21.12.md)。

## 功能

- 伙伴身份、Agent Preset、模型与能力管理；可选人格卡、创建引导、角色记忆与独立试聊。
- 微信 iLink Bot、Matrix、Mattermost 私聊，支持附件与交互提问。
- Bark 单向结果通知，支持多个服务器及设备、持久投递队列和重试。
- 长期记忆、人物画像、每日回顾和持续关注，可查看依据、状态与失败原因。
- 每日上下文焕新默认开启、独立定时；开启记忆时整理成功后清空，关闭记忆时直接清空，保留聊天历史。
- 任务看板、伙伴委派、定时任务与长任务续接。
- Skill 市场、导入与按伙伴启用，以及 HTTP / stdio MCP 服务授权。
- 伙伴挂饰、消息收件箱、通知与交付重试。

## 安装

当前插件版本 **2.23.26**，最低支持 DeepSeek Harness **0.2.1-rc.2**，已在 **0.2.1-rc.5** 部署验证（宿主仍为 RC），需要 Node.js **^22.19.0 或 >=24.0.0**。其他宿主版本请先查阅[兼容说明](docs/dsh-021-compatibility.md)和对应版本的发布说明。

```bash
dsh plugin --profile web add @lemoncat7/dsh-partner@latest
```

安装或升级后重启对应的 DSH Profile；`web` 请按实际使用的 Profile 调整。

打开侧栏「伙伴」，创建伙伴并选择预设和模型，再按需开启能力、记忆与渠道。连接渠道后先完成联系人配对审批；MCP 和 Skill 也需按伙伴授权。

## 使用边界

新伙伴的能力、长期记忆、心跳、渠道和协作授权默认关闭。同一伙伴的本地与渠道共用主对话，已授权联系人共享上下文，不适合多人隐私隔离场景。渠道身份不授予工具权限，SSH、知识库等仍执行各自授权。存储迁移需手动确认并先备份，不能直接降级。

## 文档

- [使用与配置](docs/usage.md)
- [人格强化与每日上下文焕新](docs/character-cards-and-renewal.md)
- [渠道与附件](docs/direct-channels.md)
- [Bark 单向通知](docs/bark-notifications.md)
- [持续关注检查与执行流程](docs/concern-workflow.md)
- [MCP 服务](docs/mcp.md)
- [知识库与 SSH 统一工具入口兼容](docs/tool-entry-compatibility.md)
- [存储迁移](docs/storage-migration.md)
- [任务生命周期与交付](docs/lifecycle-recovery.md)
- [架构与隐私边界](docs/architecture.md)
- [版本与发布说明](https://github.com/lemoncat7/dsh-partner/releases)
- [发布维护约定](docs/releases/README.md)

QQ 接入说明见 [QQ 渠道（SnowLuma / OneBot v11）](docs/qq-channel.md)：正向 WebSocket 同时收发消息，填写 WS 地址与对应 Token 即可，无需单独填写 HTTP API。配置按连接、私聊、群聊、表情、权限和发送消息分层展示；群聊默认关闭，开启后选择群组及触发方式。
