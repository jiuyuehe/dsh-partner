/** Mattermost Thread 历史默认和上限；历史轮数为 0 时只传本轮消息。 */
export const DEFAULT_MATTERMOST_HISTORY_ROUNDS = 3
export const MAX_MATTERMOST_HISTORY_ROUNDS = 10

/** 校验配置界面提交的历史轮数，避免无界读取 Thread。 */
export function validateMattermostHistoryRounds(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_MATTERMOST_HISTORY_ROUNDS) {
    throw new Error(`Mattermost Thread 历史轮数必须是 0–${MAX_MATTERMOST_HISTORY_ROUNDS} 的整数`)
  }
  return value as number
}

/** 旧版渠道配置没有历史轮数字段时继续使用兼容默认值。 */
export function effectiveMattermostHistoryRounds(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_MATTERMOST_HISTORY_ROUNDS
    ? value as number
    : DEFAULT_MATTERMOST_HISTORY_ROUNDS
}
