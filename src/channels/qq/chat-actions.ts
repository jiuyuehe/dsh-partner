/** Public conversation housekeeping; unrelated QQ APIs remain private. */
export const QQ_PUBLIC_STICKER_ACTIONS = new Set([
  'fetch_custom_face_detail', 'add_custom_face', 'modify_custom_face', 'move_custom_face_to_front', 'delete_custom_face',
])

/** Public reads/reactions stay inside the current conversation, never account administration. */
export const QQ_PUBLIC_SCOPED_ACTIONS = new Set([
  'set_msg_emoji_like', 'get_msg_emoji_likes', 'get_emoji_likes',
  'get_group_info', 'get_group_member_info', 'get_group_member_list',
])
export const QQ_PUBLIC_CHAT_ACTIONS = new Set([...QQ_PUBLIC_STICKER_ACTIONS, ...QQ_PUBLIC_SCOPED_ACTIONS])
