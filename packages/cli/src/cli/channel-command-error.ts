const GUIDANCE: Readonly<Record<string, string>> = {
  CHANNEL_RUNTIME_NOT_RUNNING: 'Start the selected CordisX profile; this command never starts a second connection.',
  CHANNEL_RUNTIME_SCOPE_MISMATCH: 'Use the same CORDISX_HOME and profile as the running CordisX window.',
  CHANNEL_HOST_IDENTITY_UNVERIFIABLE:
    'This execution environment cannot verify the Host process. Check the chat execution permissions; no message was submitted.',
  CHANNEL_HOST_IDENTITY_STALE:
    'The saved endpoint belongs to a different process. Restart only the selected CordisX profile normally.',
  CHANNEL_RPC_PERMISSION_DENIED:
    'The execution environment denied access to the selected Host socket. No message was submitted.',
  CHANNEL_RPC_UNAVAILABLE: 'The selected Host connection is unavailable. Check its status before retrying.',
  CHANNEL_RPC_RESULT_UNKNOWN:
    'A request may have reached the Host. Query receipt with the same operationId; do not resend blindly.',
  INVALID_CHANNEL_OPERATION: 'Run cordisx channel help for supported operations.',
  INVALID_CHANNEL_OPTIONS: 'Run cordisx channel help <operation> for its arguments.',
  INVALID_CHANNEL_INPUT: 'The --input argument must contain valid JSON.',
  PROFILE_UNAVAILABLE: 'Select a profile configured in this CORDISX_HOME.',
}

/** Only fixed codes and advice leave this boundary; raw responses can contain credentials. */
export function channelCommandError(error: unknown): { code: string; message: string; submitted: boolean | 'unknown' } {
  const candidate = error instanceof Error ? error.message : ''
  const code = /^[A-Z][A-Z0-9_]{1,80}$/u.test(candidate) ? candidate : 'CHANNEL_COMMAND_FAILED'
  return {
    code,
    message: GUIDANCE[code] ?? 'Check the structured command result. No automatic retry was attempted.',
    submitted: code === 'CHANNEL_RPC_RESULT_UNKNOWN' || code === 'CHANNEL_OPERATION_REJECTED' ? 'unknown' : false,
  }
}
