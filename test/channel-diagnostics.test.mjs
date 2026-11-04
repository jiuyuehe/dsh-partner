import test from 'node:test'
import assert from 'node:assert/strict'
import { ChannelDiagnosticBuffer } from '../lib/channels/diagnostics.js'

test('channel diagnostics bound recent entries and redact common token formats', () => {
  const buffer = new ChannelDiagnosticBuffer()
  buffer.record({ level: 'error', platform: 'weixin', channelId: 'wx', phase: 'poll-error', detail: 'Bearer abc-secret token=xyz-secret', textPreview: 'context_token=route-secret 正常正文' }, 10)
  const [entry] = buffer.after()
  assert.equal(entry.sequence, 1)
  assert.equal(entry.at, 10)
  assert.equal(entry.detail, 'Bearer [redacted] token=[redacted]')
  assert.equal(entry.textPreview, 'context_token=[redacted] 正常正文')
  assert.doesNotMatch(JSON.stringify(entry), /abc-secret|xyz-secret|route-secret/)

  for (let index = 0; index < 205; index++) buffer.record({ level: 'log', platform: 'mattermost', channelId: 'mm', phase: 'message-received', detail: String(index) })
  assert.equal(buffer.after().length, 200)
  assert.equal(buffer.recent(2).map(item => item.detail).join(','), '203,204')
  assert.equal(buffer.after(206).length, 0)
})
