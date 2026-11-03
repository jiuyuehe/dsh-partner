import type { ChatPart } from './protocol.js'

type Sender = (parts: ChatPart[], routeId: string, receipt: string) => Promise<void>
const senders = new WeakMap<object, Sender>()
/** Bound to the active drive only; shared receipt ledger handles retries and unknown sends. */
export function installIntermediateDelivery(agent: object, sender: Sender): () => void {
  senders.set(agent, sender)
  return () => { if (senders.get(agent) === sender) senders.delete(agent) }
}
export async function deliverIntermediate(agent: object, parts: ChatPart[], routeId: string, receipt: string): Promise<void> {
  const sender = senders.get(agent)
  if (!sender) throw Error('当前会话不支持中途消息投递；未发送、未结束回合，可继续执行后用最终回复交付。')
  await sender(parts, routeId, receipt)
}
