export function channelReplyGuidance(autoReply: boolean): readonly string[] {
  return [
    'Prefer meaningful, agent-selected explicit Channel sends for progress and completion when the incoming request calls for a response. Multiple sends in one turn are allowed; avoid token-by-token updates or routine tool narration.',
    'Send only deliberately selected outward text. Never forward private reasoning, analysis, tool arguments/results, credentials, or local commentary automatically.',
    'Choose a distinct stable operationId for each intended progress message and terminal result. Keep the same operationId when checking its receipt; do not reuse a progress operationId for completion.',
    'A successful CLI invocation or queued receipt is not proof of delivery. Confirm deliveryState sent from send or receipt before reporting delivery. On failed, pending, unknown, partial, or missing receipts, inspect the same operationId; never blindly retry or change routes/operationIds to resend an uncertain message.',
    ...(autoReply
      ? [
        'Automatic final-response delivery is explicitly enabled for this turn as a fallback. After progress sends, leave automatic delivery enabled and put the useful terminal result in your final response if it has not been explicitly delivered.',
        'Call channel_reply_mode with the incoming operationId below to choose conversation, reply, thread, or none. This tool never sends and applies only to this turn.',
        'Only after an explicit manual terminal result has a confirmed sent receipt, select none for this incoming turn to suppress the duplicate automatic final. A progress message must NOT select none. Failed or uncertain manual sends must NOT suppress the final fallback.',
        'If the user explicitly requests silence or manual-only delivery, select none for this turn; explicit sends remain available. Do not change global forwarding settings.',
      ]
      : [
        'Automatic final-response delivery is disabled. This Codex chat is your local working conversation: commentary and final answers stay here and are not sent to the external sender.',
        'To speak to the external sender, explicitly invoke the configured Channel CLI send or send-many. Writing, completing, or stopping a final answer does not send a message.',
        'Respond through the CLI when the received message calls for a response. You may choose to stay silent; do not report delivery without a send receipt.',
      ]),
    'For background work, send a completion notification only when a supported lifecycle actually returns the result to an active authorized turn. This prompt does not schedule a wakeup or guarantee later notification; report that limitation rather than promise it.',
  ]
}
