const boundedText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const plain = value.replace(/\p{Cc}/gu, ' ').trim()
  return plain.length === 0 ? undefined : plain.length > 4000 ? `${plain.slice(0, 3999)}…` : plain
}

/** Describe only native-supplied facts; missing justification never bypasses human approval. */
export function nativeApprovalReason(params: Record<string, unknown>, toolName: string): string {
  const reason = boundedText(params.reason)
  if (reason !== undefined) return reason
  const command = boundedText(params.command)
  const cwd = boundedText(params.cwd)
  return [
    `Native ${toolName} requested approval.`,
    ...(command === undefined ? [] : [`Command: ${command}`]),
    ...(cwd === undefined ? [] : [`Working directory: ${cwd}`]),
    'No reason was supplied by the native request.',
  ].join('\n')
}
