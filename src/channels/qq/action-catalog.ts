/** Reviewed SnowLuma OneBot actions. Source: https://snowluma.github.io/zh/docs/guide/connect-bot
 * Generated from the deployed server OpenAPI catalog; no raw API/credential passthrough. */
export interface ApiSchema {type?:string|string[];properties?:Record<string,ApiSchema>;required?:string[];items?:ApiSchema;enum?:unknown[];minimum?:number;maximum?:number;minLength?:number;maxLength?:number;maxItems?:number;default?:unknown;description?:string;additionalProperties?:boolean;not?:{const:unknown}}
export interface QqAction {id:string;category:string;title:string;description:string;effect:'read'|'write'|'destructive';schema:ApiSchema;media?:string[];messageScope?:boolean}
export const QQ_ACTION_CATEGORIES = [
  {id:"stickers",title:"收藏表情",description:"收藏图片、整理备注与排序、清理重复表情"},
  {
    "id": "space",
    "title": "QQ 空间",
    "description": "浏览动态、发表说说、点赞与评论"
  },
  {
    "id": "voice",
    "title": "语音",
    "description": "发送音频文件，或使用 QQ 群 AI 音色"
  },
  {
    "id": "interact",
    "title": "聊天互动",
    "description": "拍一拍、资料点赞、消息表情回应"
  },
  {
    "id": "history",
    "title": "消息与记录",
    "description": "查询授权会话的记录、语音转文字与撤回"
  },
  {
    "id": "profile",
    "title": "账号与好友资料",
    "description": "资料、头像、签名、状态和好友备注"
  },
  {
    "id": "groups",
    "title": "群资料",
    "description": "成员列表、荣誉、签到与群资料"
  },
  {
    "id": "notices",
    "title": "公告与待办",
    "description": "群公告、精华消息、待办事项"
  },
  {
    "id": "moderation",
    "title": "群管理",
    "description": "禁言、成员管理与入群设置；需要 QQ 群权限"
  },
  {
    "id": "files",
    "title": "文件",
    "description": "授权会话的文件上传、群文件夹和整理"
  },
  {
    "id": "albums",
    "title": "群相册",
    "description": "查看、上传图片或视频、点赞和评论"
  }
]
export const QQ_ACTIONS:readonly QqAction[] = [
{
  "id": "fetch_custom_face_detail",
  "category": "stickers",
  "title": "获取自定义表情详情",
  "description": "获取自定义表情详情",
  "effect": "read",
  "schema": {
    "type": "object",
    "properties": {
      "count": {
        "type": "integer",
        "minimum": 0,
        "default": 100,
        "maximum": 200
      }
    },
    "additionalProperties": false
  }
},
{
  "id": "add_custom_face",
  "category": "stickers",
  "title": "添加收藏表情",
  "description": "收藏工作目录内的表情图片到当前 QQ 账号；先查看图片是否适合当前人格，已收藏的相同图片不重复添加。成功后可备注情绪关键词，再用 partner_stickers 查找发送。",
  "effect": "write",
  "schema": {
    "type": "object",
    "properties": {
      "file": {
        "type": "string",
        "minLength": 1,
        "maxLength": 2000,
        "description": "当前伙伴工作目录中的表情图片路径，PNG/JPEG/GIF/WebP，最多 2 MB；收到的聊天图片先使用已经落盘的附件路径"
      }
    },
    "required": [
      "file"
    ],
    "additionalProperties": false
  },
  "media": [
    "file"
  ]
},
{
  "id": "modify_custom_face",
  "category": "stickers",
  "title": "修改收藏表情备注",
  "description": "修改收藏表情备注",
  "effect": "write",
  "schema": {
    "type": "object",
    "properties": {
      "emoji_id": {
        "type": "string",
        "minLength": 1
      },
      "desc": {
        "type": "string",
        "default": "",
        "maxLength": 80,
        "description": "简短名称和情绪关键词，例如 得意 开心 嘿嘿，便于以后按场景检索"
      }
    },
    "required": [
      "emoji_id"
    ],
    "additionalProperties": false
  }
},
{
  "id": "move_custom_face_to_front",
  "category": "stickers",
  "title": "收藏表情移到最前",
  "description": "收藏表情移到最前",
  "effect": "write",
  "schema": {
    "type": "object",
    "properties": {
      "emoji_id": {
        "type": "string",
        "minLength": 1
      }
    },
    "required": [
      "emoji_id"
    ],
    "additionalProperties": false
  }
},
{
  "id": "delete_custom_face",
  "category": "stickers",
  "title": "删除收藏表情",
  "description": "删除明确重复或不再需要的收藏表情；不批量清空，不因暂时没用到就删除。",
  "effect": "destructive",
  "schema": {
    "type": "object",
    "properties": {
      "emoji_id": {
        "type": "string",
        "minLength": 1
      }
    },
    "required": [
      "emoji_id"
    ],
    "additionalProperties": false
  }
},
  {
    "id": "get_qzone_feeds",
    "category": "space",
    "title": "获取 QQ 空间好友动态，支持结构化正文与游标分页",
    "description": "获取 QQ 空间好友动态，支持结构化正文与游标分页",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "page_num": {
          "type": "integer",
          "minimum": 1,
          "description": "页码（1 起）；不传 cursor 时从首页顺序定位，较深页可能耗时较长",
          "default": 1
        },
        "count": {
          "type": "integer",
          "minimum": 1,
          "maximum": 50,
          "description": "本页数量",
          "default": 10
        },
        "cursor": {
          "type": "string",
          "minLength": 1,
          "maxLength": 65536,
          "description": "上一次返回的 next_cursor；原样传递，省略 page_num 或传入对应页码"
        }
      },
      "additionalProperties": false
    }
  },
  {
    "id": "get_qzone_msg_list",
    "category": "space",
    "title": "获取 QQ 空间说说列表",
    "description": "获取 QQ 空间说说列表（默认机器人自己的空间）",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "target_uin": {
          "type": "integer",
          "minimum": 1,
          "description": "目标 QQ 号，省略则取机器人自己"
        },
        "pos": {
          "type": "integer",
          "minimum": 0,
          "description": "起始偏移",
          "default": 0
        },
        "num": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100,
          "description": "本页数量",
          "default": 20
        }
      },
      "additionalProperties": false
    }
  },
  {
    "id": "get_qzone_msg_detail",
    "category": "space",
    "title": "获取 QQ 空间说说详情与一页评论",
    "description": "获取 QQ 空间说说详情与一页评论（含服务端内联回复，需有访问权限）",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "tid": {
          "type": "string",
          "minLength": 1,
          "description": "说说 tid（来自 get_qzone_msg_list / send_qzone_msg）",
          "maxLength": 12000
        },
        "target_uin": {
          "type": "integer",
          "minimum": 1,
          "description": "说说所属 QQ 号，省略则取机器人自己"
        },
        "pos": {
          "type": "integer",
          "minimum": 0,
          "description": "一级评论起始偏移",
          "default": 0
        },
        "num": {
          "type": "integer",
          "minimum": 1,
          "maximum": 100,
          "description": "请求的一级评论数量，实际数量受服务端限制",
          "default": 20
        }
      },
      "required": [
        "tid"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "send_qzone_msg",
    "category": "space",
    "title": "发表说说",
    "description": "发表说说（QQ 空间，支持纯文字或带图；传 images 自动上传；可设置查看权限）",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "content": {
          "type": "string",
          "minLength": 1,
          "description": "说说正文",
          "maxLength": 12000
        },
        "images": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 12000
          },
          "description": "伙伴工作目录内的文件路径，由插件读取后上传；不接受远端容器路径或任意 URL。",
          "maxItems": 100
        },
        "ugc_right": {
          "type": "integer",
          "minimum": 1,
          "description": "查看权限：1=所有人可见，4=好友可见，16=部分好友可见，64=仅自己可见，128=部分好友不可见",
          "default": 1,
          "enum": [
            1,
            4,
            16,
            64,
            128
          ]
        },
        "target_uins": {
          "type": "array",
          "items": {
            "type": "integer",
            "minimum": 1
          },
          "description": "权限作用 QQ 号数组；ugc_right=16 时表示可见名单，128 时表示不可见名单",
          "maxItems": 100
        }
      },
      "required": [
        "content"
      ],
      "additionalProperties": false
    },
    "media": [
      "images"
    ]
  },
  {
    "id": "like_qzone",
    "category": "space",
    "title": "给一条说说点赞",
    "description": "给一条说说点赞（QQ 空间）",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "tid": {
          "type": "string",
          "minLength": 1,
          "description": "说说 tid",
          "maxLength": 12000
        },
        "target_uin": {
          "type": "integer",
          "minimum": 1,
          "description": "说说所属 QQ 号，省略则为机器人自己"
        },
        "abstime": {
          "type": "integer",
          "minimum": 0,
          "description": "说说发表时间（unix 秒），传真实值更可靠",
          "default": 0
        }
      },
      "required": [
        "tid"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "comment_qzone",
    "category": "space",
    "title": "评论说说或回复指定评论",
    "description": "评论说说或回复指定评论（普通评论支持带图，楼中楼仅支持文字）",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "tid": {
          "type": "string",
          "minLength": 1,
          "description": "说说 tid",
          "maxLength": 12000
        },
        "content": {
          "type": "string",
          "minLength": 1,
          "description": "评论内容",
          "maxLength": 12000
        },
        "target_uin": {
          "type": "integer",
          "minimum": 1,
          "description": "说说所属 QQ 号，省略则为机器人自己"
        },
        "comment_id": {
          "type": "string",
          "minLength": 1,
          "description": "一级父评论 ID，与 comment_uin 同时提供；编号 0 有效，不能传二级回复自身的 ID",
          "maxLength": 12000
        },
        "comment_uin": {
          "type": "integer",
          "minimum": 1,
          "description": "一级父评论作者 QQ 号，与 comment_id 同时提供；不是说说所属账号"
        },
        "reply_uin": {
          "type": "integer",
          "minimum": 1,
          "description": "楼中楼中要回复的用户 QQ 号，与 reply_name 同时提供，需指定父评论"
        },
        "reply_name": {
          "type": "string",
          "minLength": 1,
          "description": "要回复的用户昵称，来自评论详情的 name；与 reply_uin 同时提供",
          "maxLength": 12000
        },
        "images": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 12000
          },
          "description": "伙伴工作目录内的文件路径，由插件读取后上传；不接受远端容器路径或任意 URL。",
          "maxItems": 100
        }
      },
      "required": [
        "tid",
        "content"
      ],
      "additionalProperties": false
    },
    "media": [
      "images"
    ]
  },
  {
    "id": "set_qzone_msg_right",
    "category": "space",
    "title": "修改一条已发说说的查看权限",
    "description": "修改一条已发说说的查看权限（QQ 空间，按 tid）",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "tid": {
          "type": "string",
          "minLength": 1,
          "description": "说说 tid（来自 get_qzone_msg_list / send_qzone_msg）",
          "maxLength": 12000
        },
        "ugc_right": {
          "type": "integer",
          "minimum": 1,
          "description": "查看权限：1=所有人可见，4=好友可见，16=部分好友可见，64=仅自己可见，128=部分好友不可见",
          "enum": [
            1,
            4,
            16,
            64,
            128
          ]
        },
        "target_uins": {
          "type": "array",
          "items": {
            "type": "integer",
            "minimum": 1
          },
          "description": "权限作用 QQ 号数组；ugc_right=16 时表示可见名单，128 时表示不可见名单",
          "maxItems": 100
        }
      },
      "required": [
        "tid",
        "ugc_right"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "delete_qzone_msg",
    "category": "space",
    "title": "删除一条说说",
    "description": "删除一条说说（QQ 空间，按 tid）",
    "effect": "destructive",
    "schema": {
      "type": "object",
      "properties": {
        "tid": {
          "type": "string",
          "minLength": 1,
          "description": "说说 tid（来自 get_qzone_msg_list / send_qzone_msg）",
          "maxLength": 12000
        }
      },
      "required": [
        "tid"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_qzone_ban",
    "category": "space",
    "title": "拉黑或解除拉黑某人",
    "description": "拉黑或解除拉黑某人（修改机器人自身 QQ 空间黑名单；enable=true 拉黑，false 解除）",
    "effect": "destructive",
    "schema": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "integer",
          "minimum": 1,
          "description": "目标 QQ 号"
        },
        "enable": {
          "type": "boolean",
          "description": "true 拉黑，false 解除拉黑",
          "default": true
        }
      },
      "required": [
        "user_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "get_ai_characters",
    "category": "voice",
    "title": "获取 AI 语音角色",
    "description": "获取 AI 语音角色",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "chat_type": {
          "type": "integer",
          "minimum": 0,
          "default": 1
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "get_ai_record",
    "category": "voice",
    "title": "生成 AI 语音",
    "description": "生成 AI 语音",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "character": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "text": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "chat_type": {
          "type": "integer",
          "minimum": 0,
          "default": 1
        }
      },
      "required": [
        "group_id",
        "character",
        "text"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "send_group_ai_record",
    "category": "voice",
    "title": "发送 AI 语音到群",
    "description": "发送 AI 语音到群",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "character": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "text": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "chat_type": {
          "type": "integer",
          "minimum": 0,
          "default": 1
        }
      },
      "required": [
        "group_id",
        "character",
        "text"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "send_voice",
    "category": "voice",
    "title": "发送语音文件到私聊或群聊",
    "description": "发送语音文件到私聊或群聊",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "integer",
          "minimum": 1
        },
        "group_id": {
          "type": "integer",
          "minimum": 1
        },
        "file": {
          "type": "string",
          "minLength": 1,
          "description": "伙伴工作目录内的文件路径，由插件读取后上传；不接受远端容器路径或任意 URL。",
          "maxLength": 12000
        }
      },
      "required": [
        "file"
      ],
      "additionalProperties": false
    },
    "media": [
      "file"
    ]
  },
  {
    "id": "send_poke",
    "category": "interact",
    "title": "戳一戳 / 拍一拍",
    "description": "戳一戳 / 拍一拍；群内目标 user_id 不需要私聊审批，group_id 为所在群，当前群会话省略时自动补全；私聊仅限已授权联系人。当前聊天也可使用 partner_qq_reply action=poke",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "integer",
          "minimum": 1
        },
        "group_id": {
          "type": "integer",
          "minimum": 1
        }
      },
      "required": [
        "user_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "send_like",
    "category": "interact",
    "title": "点赞",
    "description": "点赞",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "integer",
          "minimum": 1
        },
        "times": {
          "type": "integer",
          "minimum": 0,
          "default": 1
        }
      },
      "required": [
        "user_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_msg_emoji_like",
    "category": "interact",
    "title": "设置消息表情回应",
    "description": "设置消息表情回应",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "message_id": {
          "type": "integer",
          "not": {
            "const": 0
          }
        },
        "emoji_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "set": {
          "type": "boolean",
          "default": true
        }
      },
      "required": [
        "message_id",
        "emoji_id"
      ],
      "additionalProperties": false
    },
    "messageScope": true
  },
  {
    "id": "get_msg_emoji_likes",
    "category": "interact",
    "title": "获取一条消息的全部表情回应",
    "description": "获取一条消息的全部表情回应",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "message_id": {
          "type": "integer",
          "not": {
            "const": 0
          }
        }
      },
      "required": [
        "message_id"
      ],
      "additionalProperties": false
    },
    "messageScope": true
  },
  {
    "id": "get_emoji_likes",
    "category": "interact",
    "title": "获取表情回应用户",
    "description": "获取表情回应用户",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "message_id": {
          "type": "integer",
          "not": {
            "const": 0
          }
        },
        "emoji_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        }
      },
      "required": [
        "message_id",
        "emoji_id"
      ],
      "additionalProperties": false
    },
    "messageScope": true
  },
  {
    "id": "get_msg",
    "category": "history",
    "title": "获取消息",
    "description": "获取消息",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "message_id": {
          "type": "integer",
          "not": {
            "const": 0
          }
        }
      },
      "required": [
        "message_id"
      ],
      "additionalProperties": false
    },
    "messageScope": true
  },
  {
    "id": "get_friend_msg_history",
    "category": "history",
    "title": "获取好友消息历史",
    "description": "获取好友消息历史（无锚点时从服务器获取最新双向记录）",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "integer",
          "minimum": 1
        },
        "message_id": {
          "type": "integer",
          "default": 0
        },
        "count": {
          "type": "integer",
          "minimum": 0,
          "description": "无锚点时从 QQ 服务器获取最新双向历史；服务器或身份解析失败时动作失败，不返回不完整的本地缓存",
          "default": 20,
          "maximum": 100
        },
        "reverse_order": {
          "type": "boolean",
          "description": "仅在 message_id 非 0 时生效；true 返回锚点及更旧消息，false 返回锚点及更新消息",
          "default": true
        }
      },
      "required": [
        "user_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "get_group_msg_history",
    "category": "history",
    "title": "获取群消息历史",
    "description": "获取群消息历史",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "message_id": {
          "type": "integer",
          "default": 0
        },
        "count": {
          "type": "integer",
          "minimum": 0,
          "default": 20,
          "maximum": 100
        },
        "reverse_order": {
          "type": "boolean",
          "description": "仅在 message_id 非 0 时生效；true 返回锚点及更旧消息，false 返回锚点及更新消息",
          "default": true
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "fetch_ptt_text",
    "category": "history",
    "title": "获取语音转文字结果",
    "description": "获取语音转文字结果",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "message_id": {
          "type": "integer",
          "not": {
            "const": 0
          }
        }
      },
      "required": [
        "message_id"
      ],
      "additionalProperties": false
    },
    "messageScope": true
  },
  {
    "id": "delete_msg",
    "category": "history",
    "title": "撤回消息",
    "description": "撤回消息",
    "effect": "destructive",
    "schema": {
      "type": "object",
      "properties": {
        "message_id": {
          "type": "integer",
          "not": {
            "const": 0
          }
        }
      },
      "required": [
        "message_id"
      ],
      "additionalProperties": false
    },
    "messageScope": true
  },
  {
    "id": "get_login_info",
    "category": "profile",
    "title": "get_login_info",
    "description": "get_login_info",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "id": "get_friend_list",
    "category": "profile",
    "title": "获取好友列表",
    "description": "获取好友列表",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  },
  {
    "id": "get_stranger_info",
    "category": "profile",
    "title": "获取陌生人信息",
    "description": "获取陌生人信息",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "integer",
          "minimum": 1,
          "description": "QQ 号"
        }
      },
      "required": [
        "user_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "get_profile_like",
    "category": "profile",
    "title": "获取资料点赞",
    "description": "获取资料点赞",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "integer",
          "minimum": 0,
          "default": 0
        },
        "start": {
          "type": "integer",
          "minimum": 0,
          "default": 0
        },
        "count": {
          "type": "integer",
          "minimum": 0,
          "default": 10,
          "maximum": 100
        }
      },
      "additionalProperties": false
    }
  },
  {
    "id": "set_qq_profile",
    "category": "profile",
    "title": "设置 QQ 资料",
    "description": "设置 QQ 资料",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "nickname": {
          "type": "string",
          "maxLength": 12000
        },
        "personal_note": {
          "type": "string",
          "maxLength": 12000
        },
        "sex": {
          "type": "integer",
          "minimum": 0,
          "maximum": 2,
          "description": "0 未知，1 男，2 女"
        }
      },
      "additionalProperties": false
    }
  },
  {
    "id": "set_qq_avatar",
    "category": "profile",
    "title": "设置 QQ 头像",
    "description": "设置 QQ 头像",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "file": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000,
          "description": "伙伴工作目录内的文件路径，由插件读取后上传；不接受远端容器路径或任意 URL。"
        }
      },
      "required": [
        "file"
      ],
      "additionalProperties": false
    },
    "media": [
      "file"
    ]
  },
  {
    "id": "set_self_longnick",
    "category": "profile",
    "title": "设置个性签名",
    "description": "设置个性签名（longNick/long_nick，严格 string）",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "longNick": {
          "type": "string",
          "maxLength": 12000
        },
        "long_nick": {
          "type": "string",
          "maxLength": 12000
        }
      },
      "additionalProperties": false
    }
  },
  {
    "id": "set_online_status",
    "category": "profile",
    "title": "设置在线状态",
    "description": "设置在线状态",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "status": {
          "type": "integer",
          "not": {
            "const": 0
          }
        },
        "ext_status": {
          "type": "integer",
          "minimum": 0,
          "default": 0
        },
        "battery_status": {
          "type": "integer",
          "minimum": 0,
          "default": 100
        }
      },
      "required": [
        "status"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_diy_online_status",
    "category": "profile",
    "title": "设置自定义在线状态",
    "description": "设置自定义在线状态",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "face_id": {
          "type": "integer",
          "minimum": 0
        },
        "face_type": {
          "type": "integer",
          "minimum": 0,
          "default": 1
        },
        "wording": {
          "type": "string",
          "default": "",
          "maxLength": 12000
        }
      },
      "required": [
        "face_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_friend_remark",
    "category": "profile",
    "title": "设置好友备注",
    "description": "设置好友备注",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "integer",
          "minimum": 1
        },
        "remark": {
          "type": "string",
          "maxLength": 12000
        }
      },
      "required": [
        "user_id",
        "remark"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "get_group_list",
    "category": "groups",
    "title": "获取群列表",
    "description": "获取群列表",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "no_cache": {
          "type": "boolean",
          "default": false
        }
      },
      "additionalProperties": false
    }
  },
  {
    "id": "get_group_info",
    "category": "groups",
    "title": "获取群信息",
    "description": "获取群信息",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "no_cache": {
          "type": "boolean",
          "default": false
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "get_group_detail_info",
    "category": "groups",
    "title": "获取群详细信息",
    "description": "获取群详细信息",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1
        },
        "no_cache": {
          "type": "boolean",
          "default": false
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "get_group_member_info",
    "category": "groups",
    "title": "获取群成员信息",
    "description": "获取群成员信息",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "user_id": {
          "type": "integer",
          "minimum": 1,
          "description": "QQ 号"
        },
        "no_cache": {
          "type": "boolean",
          "default": false
        }
      },
      "required": [
        "group_id",
        "user_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "get_group_member_list",
    "category": "groups",
    "title": "获取群成员列表",
    "description": "获取群成员列表",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "no_cache": {
          "type": "boolean",
          "default": false
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "get_group_honor_info",
    "category": "groups",
    "title": "获取群荣誉信息",
    "description": "获取群荣誉信息",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "type": {
          "type": "string",
          "maxLength": 12000
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "get_group_signed_list",
    "category": "groups",
    "title": "获取群今日打卡列表",
    "description": "获取群今日打卡列表",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "get_group_admin_settings",
    "category": "groups",
    "title": "获取群管理设置的当前值",
    "description": "获取群管理设置的当前值",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "get_group_shut_list",
    "category": "groups",
    "title": "获取群禁言列表",
    "description": "获取群禁言列表",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "get_group_at_all_remain",
    "category": "groups",
    "title": "获取群 @全体成员 剩余次数",
    "description": "获取群 @全体成员 剩余次数",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_group_sign",
    "category": "groups",
    "title": "群签到",
    "description": "群签到",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_group_card",
    "category": "groups",
    "title": "设置群名片",
    "description": "设置群名片（空字符串清除）",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "user_id": {
          "type": "integer",
          "minimum": 1,
          "description": "QQ 号"
        },
        "card": {
          "type": "string",
          "default": "",
          "maxLength": 12000
        }
      },
      "required": [
        "group_id",
        "user_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_group_special_title",
    "category": "groups",
    "title": "设置群头衔",
    "description": "设置群头衔",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "user_id": {
          "type": "integer",
          "minimum": 1,
          "description": "QQ 号"
        },
        "special_title": {
          "type": "string",
          "default": "",
          "maxLength": 12000
        }
      },
      "required": [
        "group_id",
        "user_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_group_name",
    "category": "groups",
    "title": "设置群名",
    "description": "设置群名",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "group_name": {
          "type": "string",
          "default": "",
          "maxLength": 12000
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_group_remark",
    "category": "groups",
    "title": "设置群备注",
    "description": "设置群备注",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1
        },
        "remark": {
          "type": "string",
          "maxLength": 12000
        }
      },
      "required": [
        "group_id",
        "remark"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_group_portrait",
    "category": "groups",
    "title": "设置群头像",
    "description": "设置群头像",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "file": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000,
          "description": "伙伴工作目录内的文件路径，由插件读取后上传；不接受远端容器路径或任意 URL。"
        }
      },
      "required": [
        "group_id",
        "file"
      ],
      "additionalProperties": false
    },
    "media": [
      "file"
    ]
  },
  {
    "id": "_get_group_notice",
    "category": "notices",
    "title": "获取群公告",
    "description": "获取群公告",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "_send_group_notice",
    "category": "notices",
    "title": "发送群公告",
    "description": "发送群公告（支持置顶、弹窗、新成员、群昵称引导与确认）",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "content": {
          "type": "string",
          "minLength": 1,
          "description": "公告正文",
          "maxLength": 12000
        },
        "image": {
          "type": "string",
          "description": "伙伴工作目录内的文件路径，由插件读取后上传；不接受远端容器路径或任意 URL。",
          "default": "",
          "maxLength": 12000
        },
        "pinned": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1,
          "description": "是否置顶：1=置顶，0=不置顶",
          "default": 0
        },
        "type": {
          "type": "integer",
          "description": "发布类型：1=普通公告，20=新成员公告；建议使用 send_to_new_members"
        },
        "send_to_new_members": {
          "type": "boolean",
          "description": "是否在成员新加入群时发送（与 type=20 等价）"
        },
        "is_show_edit_card": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1,
          "description": "是否引导群成员修改群昵称：1=是，0=否",
          "default": 1
        },
        "tip_window_type": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1,
          "description": "弹窗展示：0=开启弹窗，1=关闭弹窗（QQ 原始字段为反向语义）",
          "default": 1
        },
        "confirm_required": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1,
          "description": "是否需要群成员确认收到：1=是，0=否",
          "default": 1
        }
      },
      "required": [
        "group_id",
        "content"
      ],
      "additionalProperties": false
    },
    "media": [
      "image"
    ]
  },
  {
    "id": "_del_group_notice",
    "category": "notices",
    "title": "删除群公告",
    "description": "删除群公告（fid 或 notice_id 二选一）",
    "effect": "destructive",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "fid": {
          "type": "string",
          "maxLength": 12000
        },
        "notice_id": {
          "type": "string",
          "maxLength": 12000
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "get_essence_msg_list",
    "category": "notices",
    "title": "获取精华消息列表",
    "description": "获取精华消息列表",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_essence_msg",
    "category": "notices",
    "title": "设置精华消息",
    "description": "设置精华消息",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "message_id": {
          "type": "integer",
          "not": {
            "const": 0
          }
        }
      },
      "required": [
        "message_id"
      ],
      "additionalProperties": false
    },
    "messageScope": true
  },
  {
    "id": "delete_essence_msg",
    "category": "notices",
    "title": "移除精华消息",
    "description": "移除精华消息",
    "effect": "destructive",
    "schema": {
      "type": "object",
      "properties": {
        "message_id": {
          "type": "integer",
          "not": {
            "const": 0
          }
        }
      },
      "required": [
        "message_id"
      ],
      "additionalProperties": false
    },
    "messageScope": true
  },
  {
    "id": "get_group_todo_list",
    "category": "notices",
    "title": "获取群待办列表",
    "description": "获取群待办列表",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_group_todo",
    "category": "notices",
    "title": "设置群待办",
    "description": "设置群待办",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "message_id": {
          "type": "integer",
          "not": {
            "const": 0
          }
        }
      },
      "required": [
        "group_id",
        "message_id"
      ],
      "additionalProperties": false
    },
    "messageScope": true
  },
  {
    "id": "complete_group_todo",
    "category": "notices",
    "title": "完成群待办",
    "description": "完成群待办",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "message_id": {
          "type": "integer",
          "not": {
            "const": 0
          }
        }
      },
      "required": [
        "group_id",
        "message_id"
      ],
      "additionalProperties": false
    },
    "messageScope": true
  },
  {
    "id": "cancel_group_todo",
    "category": "notices",
    "title": "取消群待办",
    "description": "取消群待办",
    "effect": "destructive",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "message_id": {
          "type": "integer",
          "not": {
            "const": 0
          }
        }
      },
      "required": [
        "group_id",
        "message_id"
      ],
      "additionalProperties": false
    },
    "messageScope": true
  },
  {
    "id": "set_group_ban",
    "category": "moderation",
    "title": "禁言群成员",
    "description": "禁言群成员（duration=0 解除）",
    "effect": "destructive",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "user_id": {
          "type": "integer",
          "minimum": 1,
          "description": "QQ 号"
        },
        "duration": {
          "type": "integer",
          "minimum": 0,
          "default": 1800
        }
      },
      "required": [
        "group_id",
        "user_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_group_whole_ban",
    "category": "moderation",
    "title": "全员禁言开关",
    "description": "全员禁言开关",
    "effect": "destructive",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "enable": {
          "type": "boolean",
          "default": true
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_group_kick",
    "category": "moderation",
    "title": "踢出群成员",
    "description": "踢出群成员",
    "effect": "destructive",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "user_id": {
          "type": "integer",
          "minimum": 1,
          "description": "QQ 号"
        },
        "reject_add_request": {
          "type": "boolean",
          "default": false
        }
      },
      "required": [
        "group_id",
        "user_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_group_admin",
    "category": "moderation",
    "title": "设置/取消管理员",
    "description": "设置/取消管理员",
    "effect": "destructive",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "user_id": {
          "type": "integer",
          "minimum": 1,
          "description": "QQ 号"
        },
        "enable": {
          "type": "boolean",
          "default": true
        }
      },
      "required": [
        "group_id",
        "user_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_group_add_option",
    "category": "moderation",
    "title": "设置加群选项",
    "description": "设置加群选项",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "add_type": {
          "type": "integer",
          "minimum": 0,
          "default": 0
        },
        "group_question": {
          "type": "string",
          "maxLength": 12000
        },
        "group_answer": {
          "type": "string",
          "maxLength": 12000
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_group_member_invite_policy",
    "category": "moderation",
    "title": "设置群成员邀请策略",
    "description": "设置群成员邀请策略",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "policy": {
          "type": "string",
          "enum": [
            "disabled",
            "require_approval",
            "no_approval",
            "no_approval_under_100"
          ]
        }
      },
      "required": [
        "group_id",
        "policy"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_group_member_permissions",
    "category": "moderation",
    "title": "设置群成员权限",
    "description": "设置群成员权限（仅群主可改）",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "allow_member_upload_album": {
          "type": "boolean"
        },
        "allow_member_temporary_session": {
          "type": "boolean"
        },
        "allow_member_create_group": {
          "type": "boolean"
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_group_new_member_history_visibility",
    "category": "moderation",
    "title": "设置新成员是否可查看历史消息",
    "description": "设置新成员是否可查看历史消息",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "visible": {
          "type": "boolean"
        }
      },
      "required": [
        "group_id",
        "visible"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_group_search",
    "category": "moderation",
    "title": "设置群被搜索方式",
    "description": "设置群被搜索方式（群指纹 / 群号搜索开关）",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "no_finger_open": {
          "type": "integer",
          "minimum": 0
        },
        "no_code_finger_open": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "set_group_robot_add_option",
    "category": "moderation",
    "title": "设置群机器人加群选项",
    "description": "设置群机器人加群选项",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "robot_member_switch": {
          "type": "integer",
          "minimum": 0
        },
        "robot_member_examine": {
          "type": "integer",
          "minimum": 0
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "get_group_file_system_info",
    "category": "files",
    "title": "获取群文件系统信息",
    "description": "获取群文件系统信息",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "get_group_root_files",
    "category": "files",
    "title": "获取群根目录文件列表",
    "description": "获取群根目录文件列表",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "get_group_files_by_folder",
    "category": "files",
    "title": "获取群子目录文件列表",
    "description": "获取群子目录文件列表",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "folder_id": {
          "type": "string",
          "default": "",
          "maxLength": 12000
        },
        "folder": {
          "type": "string",
          "default": "",
          "maxLength": 12000
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "get_group_file_url",
    "category": "files",
    "title": "获取群文件下载链接",
    "description": "获取群文件下载链接",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "file_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "busid": {
          "type": [
            "string",
            "integer",
            "boolean"
          ]
        }
      },
      "required": [
        "group_id",
        "file_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "upload_group_file",
    "category": "files",
    "title": "上传群文件",
    "description": "上传群文件",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "file": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000,
          "description": "伙伴工作目录内的文件路径，由插件读取后上传；不接受远端容器路径或任意 URL。"
        },
        "name": {
          "type": "string",
          "default": "",
          "maxLength": 12000
        },
        "folder": {
          "type": "string",
          "default": "",
          "maxLength": 12000
        },
        "folder_id": {
          "type": "string",
          "default": "",
          "maxLength": 12000
        },
        "upload_file": {
          "type": "boolean",
          "default": true
        }
      },
      "required": [
        "group_id",
        "file"
      ],
      "additionalProperties": false
    },
    "media": [
      "file"
    ]
  },
  {
    "id": "upload_private_file",
    "category": "files",
    "title": "上传私聊文件",
    "description": "上传私聊文件",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "user_id": {
          "type": "integer",
          "minimum": 1
        },
        "file": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000,
          "description": "伙伴工作目录内的文件路径，由插件读取后上传；不接受远端容器路径或任意 URL。"
        },
        "name": {
          "type": "string",
          "default": "",
          "maxLength": 12000
        },
        "upload_file": {
          "type": "boolean",
          "default": true
        }
      },
      "required": [
        "user_id",
        "file"
      ],
      "additionalProperties": false
    },
    "media": [
      "file"
    ]
  },
  {
    "id": "create_group_file_folder",
    "category": "files",
    "title": "创建群文件夹",
    "description": "创建群文件夹",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "parent_id": {
          "type": "string",
          "default": "/",
          "maxLength": 12000
        }
      },
      "required": [
        "group_id",
        "name"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "rename_group_file",
    "category": "files",
    "title": "重命名群文件",
    "description": "重命名群文件",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "file_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "current_parent_directory": {
          "type": "string",
          "default": "/",
          "maxLength": 12000
        },
        "new_name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        }
      },
      "required": [
        "group_id",
        "file_id",
        "new_name"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "rename_group_file_folder",
    "category": "files",
    "title": "重命名群文件夹",
    "description": "重命名群文件夹",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "folder_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "new_folder_name": {
          "type": "string",
          "default": "",
          "maxLength": 12000
        },
        "name": {
          "type": "string",
          "default": "",
          "maxLength": 12000
        }
      },
      "required": [
        "group_id",
        "folder_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "move_group_file",
    "category": "files",
    "title": "移动群文件",
    "description": "移动群文件",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "file_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "parent_directory": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "target_directory": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        }
      },
      "required": [
        "group_id",
        "file_id",
        "parent_directory",
        "target_directory"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "delete_group_file",
    "category": "files",
    "title": "删除群文件",
    "description": "删除群文件",
    "effect": "destructive",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "file_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        }
      },
      "required": [
        "group_id",
        "file_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "delete_group_file_folder",
    "category": "files",
    "title": "删除群文件夹",
    "description": "删除群文件夹",
    "effect": "destructive",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "folder_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        }
      },
      "required": [
        "group_id",
        "folder_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "get_group_album_list",
    "category": "albums",
    "title": "get_group_album_list",
    "description": "get_group_album_list",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        }
      },
      "required": [
        "group_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "get_group_album_media_list",
    "category": "albums",
    "title": "get_group_album_media_list",
    "description": "get_group_album_media_list",
    "effect": "read",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "album_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "attach_info": {
          "type": "string",
          "default": "",
          "maxLength": 12000
        }
      },
      "required": [
        "group_id",
        "album_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "upload_image_to_qun_album",
    "category": "albums",
    "title": "upload_image_to_qun_album",
    "description": "upload_image_to_qun_album",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "album_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "album_name": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "file": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000,
          "description": "伙伴工作目录内的文件路径，由插件读取后上传；不接受远端容器路径或任意 URL。"
        }
      },
      "required": [
        "group_id",
        "album_id",
        "album_name",
        "file"
      ],
      "additionalProperties": false
    },
    "media": [
      "file"
    ]
  },
  {
    "id": "upload_video_to_qun_album",
    "category": "albums",
    "title": "上传视频到群相册",
    "description": "上传视频到群相册",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "album_id": {
          "type": "string",
          "minLength": 1,
          "description": "相册 id",
          "maxLength": 12000
        },
        "album_name": {
          "type": "string",
          "minLength": 1,
          "description": "相册名称",
          "maxLength": 12000
        },
        "file": {
          "type": "string",
          "minLength": 1,
          "description": "伙伴工作目录内的文件路径，由插件读取后上传；不接受远端容器路径或任意 URL。",
          "maxLength": 12000
        }
      },
      "required": [
        "group_id",
        "album_id",
        "album_name",
        "file"
      ],
      "additionalProperties": false
    },
    "media": [
      "file"
    ]
  },
  {
    "id": "set_group_album_media_like",
    "category": "albums",
    "title": "set_group_album_media_like",
    "description": "set_group_album_media_like",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "album_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "batch_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "lloc": {
          "type": "string",
          "maxLength": 12000
        }
      },
      "required": [
        "group_id",
        "album_id",
        "batch_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "cancel_group_album_media_like",
    "category": "albums",
    "title": "cancel_group_album_media_like",
    "description": "cancel_group_album_media_like",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "album_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "batch_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "lloc": {
          "type": "string",
          "maxLength": 12000
        }
      },
      "required": [
        "group_id",
        "album_id",
        "batch_id"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "do_group_album_comment",
    "category": "albums",
    "title": "do_group_album_comment",
    "description": "do_group_album_comment",
    "effect": "write",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "album_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "lloc": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "content": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        }
      },
      "required": [
        "group_id",
        "album_id",
        "lloc",
        "content"
      ],
      "additionalProperties": false
    }
  },
  {
    "id": "del_group_album_media",
    "category": "albums",
    "title": "删除群相册图片或视频",
    "description": "删除群相册图片或视频",
    "effect": "destructive",
    "schema": {
      "type": "object",
      "properties": {
        "group_id": {
          "type": "integer",
          "minimum": 1,
          "description": "群号"
        },
        "album_id": {
          "type": "string",
          "minLength": 1,
          "maxLength": 12000
        },
        "lloc": {
          "type": "string",
          "minLength": 1,
          "description": "图片长定位标识，或视频 id",
          "maxLength": 12000
        }
      },
      "required": [
        "group_id",
        "album_id",
        "lloc"
      ],
      "additionalProperties": false
    }
  }
]
export const QQ_ACTION_MAP=new Map(QQ_ACTIONS.map(action=>[action.id,action]))
