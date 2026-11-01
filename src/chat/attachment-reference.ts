/** A local Markdown image is not a channel image receipt. Reject before ending
 * the turn so the model can use the existing explicit, permission-checked sender. */
export function assertChatImageDelivery(text: string): void {
  const prose = text.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  const images = prose.matchAll(/!\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+"[^"\n]*")?\s*\)/g)
  for (const match of images) {
    const path = match[1] ?? match[2] ?? ''
    if (/^(?:https?:|data:|\/\/)/i.test(path)) continue
    throw Error('图片尚未交付，本次聊天未发送、未结束回合。本地 Markdown 图片地址不能在 QQ 中显示。请通过 partner_tools describe/call 调用 partner_send_attachment，path 填真实生成文件路径；确认 channel=sent 后再按人物设定简短接话，不再次粘贴图片路径。失败按回执 deliveryId 重试，勿重新生图；不要把本错误发给用户当作最终答案。')
  }
}
