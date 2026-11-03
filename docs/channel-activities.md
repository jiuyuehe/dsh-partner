# 渠道自主活动扩展

自主调度属于伙伴：空闲唤起、意图续接、睡眠与新消息优先保持统一。
渠道只注册可发现的活动，返回自己当前配置下可用的入口、公开/私有分类和简短说明。
注册不增加权限、不安装工具、不执行操作、不自动发送消息，也不新增唤起定时器。

## 注册接口

伙伴启动后提供 Cordis 服务 `dshPartnerChannelActivities`。
类型从 `@lemoncat7/dsh-partner/channel-activities` 导入，避免加载插件主模块。
注册返回取消函数；扩展卸载时必须调用。每个 provider 的 id 唯一，重复注册会报错。
一个平台可注册多个 provider；省略平台的旧微信渠道归一为 `weixin`。

下面的示例假设扩展已实现并注册 `matrix_feed` 工具，其执行器会校验当前渠道、房间和调用者权限。
活动注册本身不会创建这个工具，也不会把它纳入 `partner_tools`。

```ts
import type { ChannelActivityRegistry } from '@lemoncat7/dsh-partner/channel-activities'

ctx.inject(['dshPartnerChannelActivities'], scoped => {
  const registry = scoped.get('dshPartnerChannelActivities') as ChannelActivityRegistry
  scoped.effect(() => registry.register({
    id: 'my-matrix.feeds',
    platform: 'matrix',
    discover({ channel, sessions }) {
      // sessions 仅含此渠道、此伙伴已批准的会话。
      // 可在这里结合扩展自己的实时开关；关闭时返回 []。
      if (!sessions.length) return []
      return [{
        id: 'read-feeds',
        title: '浏览已授权频道',
        tool: 'matrix_feed',
        visibility: 'public',
        description: `先通过 matrix_feed 查询频道 ${channel.id} 的可用房间，再选择读取；不要转发私密内容。`,
        operations: ['list', 'read'],
      }]
    },
  }))
})
```

`discover` 必须同步、轻量、无对外副作用；它提供目录，不在此联网抓取或执行活动。
每次自主唤起重新读取注册表和当前渠道配置。渠道关闭、移除或不属于该伙伴时不会调用 provider。
注册/卸载下一次唤起即生效；已经进入模型上下文的旧目录不能替代执行时的实时校验。

失败或格式错误只隔离对应 provider，记录错误，不隐藏其他渠道的正常活动。
目录中的公开/私有是分类说明，不是授权凭证。工具执行器必须重新检查当前开关、账号、目标、审批及取消状态。
工具不存在或已撤回时不得执行；不要根据注册元数据提升权限。

## 内置实现

- 通用 `conversation` provider：各渠道已有批准会话时，提供交流发现入口；具体投递仍走原渠道适配器。
- `qq.capabilities` provider：从 QQ 当前开关生成空间、表情、语音等分类，保留原公开/私有边界。私有总开关关闭时不提供私有活动；可独立开放的公开收藏能力遵循原工具规则。
- Matrix、Mattermost、微信可通过相同注册接口扩展专有能力，无须修改自主提示生成器或调度器。

当前接口扩展的是既有传输渠道的活动，不负责新增传输协议、凭据或账号绑定。
