import { useId } from 'react'
export function ExclusivePromptToggle({enabled,onChange}:{enabled:boolean;onChange(enabled:boolean):void}):JSX.Element {
 const id=useId()
 return <div>
  <div className="dsh-partner-persona-option"><div><span id={id}>独占系统提示</span><small>{enabled?'已开启':'默认关闭'}</small></div><button type="button" role="switch" className="dsh-partner-switch" aria-labelledby={id} aria-describedby={id+'-hint'} aria-checked={enabled} data-on={enabled} onClick={()=>onChange(!enabled)}><i aria-hidden="true"/></button></div>
  <p id={id+'-hint'} className="dsh-partner-character-hint">只用此伙伴的基本身份、角色设定与聊天偏好作为静态系统提示。关系、记忆和实时状态照常注入，工具权限不变。关闭角色聊天时不生效。</p>
 </div>
}
