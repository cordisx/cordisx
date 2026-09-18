export interface NativeSubmissionLaunchPolicyInput {
  readonly platform: NodeJS.Platform
  readonly adapterId: string
  readonly preference?: string | undefined
}

/** Native submission is the default for the audited macOS Codex host, with an explicit opt-out. */
export function shouldEnableNativeSubmission(input: NativeSubmissionLaunchPolicyInput): boolean {
  return input.platform === 'darwin' && input.adapterId === 'codex' && input.preference !== '0'
}
