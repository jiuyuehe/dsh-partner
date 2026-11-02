import type { SessionEvent } from '@deepseek-ai/dsh-session'

export const SHORT_EXPRESSION_CHARS = 20
export const SHORT_EXPRESSION_TOTAL = 48
const feedback = new WeakMap<object, {input: string; phases: Set<string>}>()
/** One advisory rewrite per phase/input; never truncate, edit facts or loop on style. */
export function checkShortExpression(agent:object,events:readonly SessionEvent[],texts:readonly string[],phase:'speech'|'final',enabled:boolean,expanded=false):void {
  if(!enabled||expanded||!texts.length)return
  const sizes=texts.map(text=>[...text.trim()].length)
  if(sizes.every(size=>size<=SHORT_EXPRESSION_CHARS)&&sizes.reduce((n,size)=>n+size,0)<=SHORT_EXPRESSION_TOTAL)return
  const start=[...events].reverse().find(e=>e.type==='turn/start')
  const user=[...events].reverse().find(e=>e.type==='user/message'&&e.data.source.kind==='user')
  const input=JSON.stringify([start?.seq??0,user?.type==='user/message'?user.data.id:''])
  let state=feedback.get(agent)
  if(state?.input!==input){state={input,phases:new Set()};feedback.set(agent,state)}
  if(state.phases.has(phase))return
  state.phases.add(phase)
  throw Error(`短句接话：这段话尚未发送。请按当前人设重新写，普通每条以 ${SHORT_EXPRESSION_CHARS} 字以内为目标，一次最终回复以 ${SHORT_EXPRESSION_TOTAL} 字以内为目标。先回应眼前一点，不把完整报告压成一句；必要补充可另发一条，不截掉事实。明确要求详细或原文时用 inlineDetails。只提醒本阶段一次，不为风格反复重试。`)
}
