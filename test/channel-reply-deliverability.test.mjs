import test from 'node:test'
import assert from 'node:assert/strict'
import { hasDeliverableChannelReply } from '../lib/channels/reply-deliverability.js'

test('empty or whitespace-only Agent output is not considered a completed channel reply', () => {
  assert.equal(hasDeliverableChannelReply({ text: '', attachments: [] }), false)
  assert.equal(hasDeliverableChannelReply({ text: '  \n ', attachments: [], chatParts: [] }), false)
})

test('text, attachments, chat parts, and confirmed tool delivery are deliverable', () => {
  assert.equal(hasDeliverableChannelReply({ text: '你好', attachments: [] }), true)
  assert.equal(hasDeliverableChannelReply({ text: '', attachments: [{ path: 'image.png' }] }), true)
  assert.equal(hasDeliverableChannelReply({ text: '', attachments: [], chatParts: [{ type: 'text', text: '你好' }] }), true)
  assert.equal(hasDeliverableChannelReply({ text: '', attachments: [], alreadyDelivered: true }), true)
})
