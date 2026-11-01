import type {PairingView} from '../client-api.js'
import {boundQqIds, type QqSettings} from '../channels/qq/settings.js'

export function QqIdentityBindingEditor({value,disabled,onChange}: {
  value:QqSettings['identityBinding']; disabled:boolean; pairings:PairingView[]; onChange(value:QqSettings['identityBinding']):void
}): JSX.Element {
  return <section className="dsh-partner-qq-identity-binding" aria-label="归属账号">
    <label className="dsh-partner-qq-field"><span>归属 QQ 号</span><textarea value={(value.qqIds ?? boundQqIds(value)).join('\n')} rows={4} autoComplete="off" disabled={disabled} placeholder="每行一个 QQ 号，也可用逗号分隔" onChange={e=>{const qqIds=e.target.value.split(/[\n,，]/);onChange({enabled:qqIds.some(id=>id.trim()),qqIds})}}/><small>可以添加多个账号，同一账号在私聊和群聊中均适用。只有这些账号加载身份里的关系设定，并可在已配置权限范围内使用工具与自主能力。</small></label>
    <p className="dsh-partner-qq-hint">其他账号可使用已开启的文字、表情包发送与收藏整理、当前会话语音回复、消息表情回应与当前群信息查询，不能修改人设、访问私有资料、操作空间或发起任务。留空时所有 QQ 用户均只有聊天回复能力。系统发起的自主任务仍遵守能力开关与原有授权；白名单群放行所有成员；其他群与私聊分别审批账号。填写归属账号不会自动通过审批或开放私聊。</p>
  </section>
}
