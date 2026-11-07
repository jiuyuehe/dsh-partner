import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractMattermostCurrentTask,
  extractMattermostSessionConstraint,
  nextMattermostContinuity,
  renderMattermostSessionContinuity,
} from '../lib/inbox/mattermost-continuity.js'
import {
  DEFAULT_MATTERMOST_HISTORY_ROUNDS,
  effectiveMattermostHistoryRounds,
  validateMattermostHistoryRounds,
} from '../lib/channels/direct/mattermost-settings.js'

test('Mattermost current task extraction ignores the history section', () => {
  const prompt = '【本轮任务｜优先处理】\n【本轮实质任务】\n你再歌颂下你的mother\n【/本轮实质任务】\n\n【历史参考】\nUSER：旧任务'
  assert.equal(extractMattermostCurrentTask(prompt), '你再歌颂下你的mother')
})

test('explicit remember correction is persisted as a session-scoped constraint', () => {
  assert.equal(extractMattermostSessionConstraint('你没有被停用。你记住'), '你没有被停用。')
  assert.equal(extractMattermostSessionConstraint('写一首诗'), undefined)
  const next = nextMattermostContinuity({ mattermostSessionConstraints: [], mattermostTaskChain: [] }, '你没有被停用。你记住')
  assert.deepEqual(next.mattermostSessionConstraints, ['你没有被停用。'])
  assert.deepEqual(next.mattermostTaskChain, [], '纠正只作为 SESSION_CONSTRAINTS 持久化，不伪装成任务')
  assert.match(renderMattermostSessionContinuity(next), /SESSION_CONSTRAINTS/)
})

test('Mattermost task chain keeps only the latest three substantive tasks', () => {
  const first = nextMattermostContinuity({}, '大海诗')
  const second = nextMattermostContinuity(first, '深圳秋诗')
  const third = nextMattermostContinuity(second, '深圳冬诗')
  const fourth = nextMattermostContinuity(third, '歌颂mother')
  assert.deepEqual(fourth.mattermostTaskChain, ['深圳秋诗', '深圳冬诗', '歌颂mother'])
  assert.match(renderMattermostSessionContinuity(fourth), /TASK_CHAIN（最近 3 个实质任务/)
})

test('Mattermost Thread history rounds default to three and validate a configurable range', () => {
  assert.equal(DEFAULT_MATTERMOST_HISTORY_ROUNDS, 3)
  assert.equal(effectiveMattermostHistoryRounds(undefined), 3)
  assert.equal(validateMattermostHistoryRounds(0), 0)
  assert.equal(validateMattermostHistoryRounds(10), 10)
  assert.throws(() => validateMattermostHistoryRounds(11), /0–10/)
  assert.throws(() => validateMattermostHistoryRounds(2.5), /整数/)
})
