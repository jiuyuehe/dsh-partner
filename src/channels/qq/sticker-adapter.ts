import { validEmojiPreview } from '../../chat/sticker-adapter.js'
import type { WeixinChannel } from '../../domain.js'
import type { StickerAdapter, ResolvedSticker } from '../../chat/sticker-adapter.js'
import type { QqFace } from './catalog.js'
import { qqSettings } from './settings.js'

export function qqStickerAdapter(channel:WeixinChannel,fallback:StickerAdapter,catalog:()=>Promise<QqFace[]>):StickerAdapter {
 const policy=qqSettings(channel.qq)
 const enabled=policy.stickerSource!=='default'
 const native=async()=>enabled?(await catalog().catch(()=>[])).filter(f=>f.kind==='custom'?policy.imagesEnabled:policy.facesEnabled):[]
 const terms=(s:string)=>s.replace(/^\//,'').normalize('NFKC').toLowerCase().split(/[\s,，、;；]+/).filter(Boolean)
 const score=(face:QqFace,query:string)=>terms(query).reduce((n,t)=>n+(terms(face.name+' '+(face.tags??[]).join(' ')).some(f=>f.includes(t)||(f.length>1&&t.includes(f)))?1:0),0)
 const key=(f:QqFace)=>(f.kind==='custom'?'qq-custom-':'qq-face-')+f.id
 const item=(f:QqFace)=>({id:key(f),name:f.name.replace(/^\//,''),tags:['QQ原生表情',f.category,...(f.tags??[])].slice(0,8),mediaType:'image/gif',size:0})
 const resolve=(face:QqFace):ResolvedSticker=>({item:item(face),native:{provider:face.kind==='custom'?'qq-custom':'qq',id:face.nativeId??face.id,channelId:channel.id,accountId:channel.accountId,label:face.name.replace(/^\//,''),...(validEmojiPreview(face.image??'')?{previewUrl:face.image}:{})}})
 return {
  async list(owner,query,signal,kind) {
   signal.throwIfAborted()
   const faces=(await native()).filter(f=>kind!=='image'||f.kind==='custom').map(f=>({f,score:score(f,query)})).filter(e=>!query.trim()||e.score>0).sort((a,b)=>Number(b.f.kind==='custom')-Number(a.f.kind==='custom')||b.score-a.score).slice(0,48).map(e=>item(e.f))
   // Channel mode never fills a failed QQ search with unrelated built-in images.
   if(enabled)return faces
   return policy.imagesEnabled?(await fallback.list(owner,query,signal)).slice(0,24):[]
  },
  async resolve(owner,id,signal) {
   signal.throwIfAborted()
   if((id.startsWith('qq-face-')||id.startsWith('qq-custom-'))) {
    if(!enabled)throw Error('QQ 原生表情已关闭，请重新查询默认表情库')
    const face=(await native()).find(f=>key(f)===id)
    if(!face)throw Error('QQ 表情目录已变化或不可用，请重新查询表情库')
    return resolve(face)
   }
   if(enabled)throw Error('当前使用 QQ 表情库，请查询 partner_stickers 并选择 qq-custom- 或 qq-face- ID；没有合适表情可只发文字，不使用内置表情替代')
   const original=await fallback.resolve(owner,id,signal)
   // An explicit sticker ID must identify the same image in preview and delivery.
   if(!policy.imagesEnabled)throw Error('QQ 图片与表情包发送已关闭')
   return original
  }
 }
}
