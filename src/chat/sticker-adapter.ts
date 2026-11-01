import type { Sticker, StickerLibrary } from './stickers.js'
import type { ChannelSession, WeixinChannel } from '../domain.js'
export interface NativeEmoji { provider:string; id:string; channelId:string; accountId:string; label:string; previewUrl?:string }
export type ResolvedSticker = {item:Sticker;data:Buffer;native?:never} | {item:Sticker;native:NativeEmoji;data?:never}
export interface StickerAdapter {
  list(owner:string,query:string,signal:AbortSignal,kind?:'image'|'all'):Promise<Sticker[]>
  resolve(owner:string,id:string,signal:AbortSignal):Promise<ResolvedSticker>
}
/** Default library remains usable without any channel. Providers override only their route. */
export class StickerAdapters {
  readonly fallback:StickerAdapter
  private readonly factories=new Map<string,(channel:WeixinChannel)=>StickerAdapter>()
  constructor(library:StickerLibrary) {
    this.fallback={list:(owner,query)=>library.list(owner,query),resolve:(owner,id)=>library.image(owner,id)}
  }
  register(platform:string,factory:(channel:WeixinChannel)=>StickerAdapter):void {this.factories.set(platform,factory)}
  forRoute(route:ChannelSession|undefined,channels:readonly WeixinChannel[]):StickerAdapter {
    const channel=route&&channels.find(c=>c.id===route.channelId&&c.companionId===route.companionId&&c.enabled)
    return channel&&this.factories.get(channel.platform??'weixin')?.(channel)||this.fallback
  }
}
export function validNativeEmoji(value:unknown):value is NativeEmoji {
  if(!value||typeof value!=='object')return false
  const e=value as NativeEmoji
  return (e.provider==='qq'?typeof e.id==='string'&&/^\d{1,6}$/.test(e.id):e.provider==='qq-custom'&&typeof e.id==='string'&&e.id.length>0&&e.id.length<=512&&!/[\x00-\x1f]/.test(e.id))&&typeof e.channelId==='string'&&typeof e.accountId==='string'&&typeof e.label==='string'&&e.label.length<=100
    &&(e.previewUrl===undefined||validEmojiPreview(e.previewUrl))
}

export function validEmojiPreview(value:string):boolean {
 try {const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.port&&['qpic.cn','gtimg.cn','multimedia.nt.qq.com'].some(h=>url.hostname===h||url.hostname.endsWith('.'+h))}catch{return false}
}
