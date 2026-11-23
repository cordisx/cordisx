export const CHANNEL_FORWARD_HELP: Readonly<Record<string, string>> = {
  forward:
    'Forward one original message, independently authorized from send. Input: {account:{adapterId,accountId,tenantId},source:{id:"oc_...",kind:"direct"|"group"},target:{id:"oc_...",kind:"direct"|"group"},messageIds:["om_..."],operationId}. Only the configured official Feishu/Lark adapter is supported; same account/tenant, conversation target only. No reply/thread, cross-account or SDK fallback. The source must be readable and every ID must belong to it. Keep operationId stable; unknown effects are never replayed.',
  'merge-forward':
    'Forward 2..100 unique original message IDs as one platform merge, preserving supplied order. Uses the same input as forward. Independently authorized from single forward and send. receipt.state=sent with externalMessageId proves full delivery; partial retains a real ID and invalidMessageIds, not full success. Never resend a partial/unknown operation blindly.',
  'forward-receipt':
    'Read only: use the exact original forwarding input plus operation:"forward"|"merge-forward". Reauthorizes source and target; returns the persisted caller-scoped receipt, never invokes a platform mutation. Missing receipt is not success. A changed request under the same operationId conflicts. Unknown operations require external investigation; there is no retry/reset in this version. A stale ledger lock fails closed; an operator must verify all owning processes are stopped before lock recovery, never automatically steal it.',
}
