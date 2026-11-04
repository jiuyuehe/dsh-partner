declare const entityIdBrand: unique symbol

export type EntityId<Kind extends string> = string & { readonly [entityIdBrand]: Kind }

export type SessionId = EntityId<'sessionId'>
export type SubagentId = EntityId<'subagentId'>
export type JobId = EntityId<'jobId'>
export type GoalId = EntityId<'goalId'>
export type RunId = EntityId<'runId'>
export type ExternalEventId = EntityId<'externalEventId'>
export type ExternalMessageId = EntityId<'externalMessageId'>
export type ExternalAttachmentId = EntityId<'externalAttachmentId'>
export type InboxEventId = EntityId<'inboxEventId'>
export type BatchId = EntityId<'batchId'>
export type DeliveryId = EntityId<'deliveryId'>
export type RouteId = EntityId<'routeId'>
export type ConversationKey = EntityId<'conversationKey'>
export type MemoryScopeId = EntityId<'memoryScopeId'>

function parseEntityId<Kind extends string>(value: string, kind: Kind): EntityId<Kind> {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`${kind} must be a non-empty stable identifier`)
  }
  return value as EntityId<Kind>
}

export const asSessionId = (value: string): SessionId => parseEntityId(value, 'sessionId')
export const asSubagentId = (value: string): SubagentId => parseEntityId(value, 'subagentId')
export const asJobId = (value: string): JobId => parseEntityId(value, 'jobId')
export const asGoalId = (value: string): GoalId => parseEntityId(value, 'goalId')
export const asRunId = (value: string): RunId => parseEntityId(value, 'runId')
export const asExternalEventId = (value: string): ExternalEventId => parseEntityId(value, 'externalEventId')
export const asExternalMessageId = (value: string): ExternalMessageId => parseEntityId(value, 'externalMessageId')
export const asExternalAttachmentId = (value: string): ExternalAttachmentId => parseEntityId(value, 'externalAttachmentId')
export const asInboxEventId = (value: string): InboxEventId => parseEntityId(value, 'inboxEventId')
export const asBatchId = (value: string): BatchId => parseEntityId(value, 'batchId')
export const asDeliveryId = (value: string): DeliveryId => parseEntityId(value, 'deliveryId')
export const asRouteId = (value: string): RouteId => parseEntityId(value, 'routeId')
export const asConversationKey = (value: string): ConversationKey => parseEntityId(value, 'conversationKey')
export const asMemoryScopeId = (value: string): MemoryScopeId => parseEntityId(value, 'memoryScopeId')
