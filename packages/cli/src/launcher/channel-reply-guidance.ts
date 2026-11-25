export function channelReplyGuidance(autoReply: boolean): readonly string[] {
  return [
    'When the incoming request calls for a response, send the useful answer naturally through the configured Channel CLI, including when automatic final forwarding is enabled. Do not rely on the local final answer to reach the user. Multiple sends in one turn are allowed; avoid token-by-token updates or routine tool narration.',
    'Use ordinary conversational language in the outward answer. Explain delivery mechanics only if relevant or requested; do not append routine reliability disclaimers.',
    'Send only deliberately selected outward text. Never forward private reasoning, analysis, tool arguments/results, credentials, or local commentary automatically.',
    'Choose a distinct stable operationId for each intended progress message and terminal result. Keep the same operationId when checking its receipt; do not reuse a progress operationId for completion.',
    'For an explicit terminal result to this source conversation, use a single-target send with terminal:{contract:"cordisx.channel-terminal-intent/v1",schemaVersion:1,inputOperationId:<latest incoming operationId for this turn>}. Omit terminal for progress, questions and other destinations. The Host fences the exact terminal delivery; do not use send-many for this intent.',
    'If a terminal send is rejected because a follow-up input is still being steered or has superseded the old input, process the latest input and use its context before sending a terminal result.',
    'A successful CLI invocation or queued receipt is not proof of delivery. Confirm deliveryState sent from send or receipt before reporting delivery. On failed, pending, unknown, partial, or missing receipts, inspect the same operationId; never blindly retry or change routes/operationIds to resend an uncertain message.',
    ...(autoReply
      ? [
        'Automatic final-response delivery is enabled as a fallback, but send the terminal result explicitly through the Channel CLI when a response is needed. Keep automatic fallback for progress and use terminal intent for the terminal send.',
        'Call channel_reply_mode with the incoming operationId below to choose conversation, reply, thread, or none. This tool never sends and applies only to this turn.',
        'For a terminal-intent send the Host reconciles the exact receipt and fences automatic delivery while uncertain; do not select none for it. For a legacy send without terminal intent, select none only after a confirmed sent receipt. A progress message must NOT select none. An uncertain legacy terminal send can still duplicate the automatic final; inspect its receipt and never blindly resend.',
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
