import { describe, expect, it } from 'vitest'
import { shouldEnableNativeSubmission } from '../packages/cli/src/cli/native-submission-launch-policy.js'

describe('native submission launch policy', () => {
  it('enables native submission by default for the macOS Codex host', () => {
    expect(shouldEnableNativeSubmission({ platform: 'darwin', adapterId: 'codex' })).toBe(true)
    expect(shouldEnableNativeSubmission({ platform: 'darwin', adapterId: 'codex', preference: '1' })).toBe(true)
  })

  it('honors the explicit opt-out', () => {
    expect(shouldEnableNativeSubmission({ platform: 'darwin', adapterId: 'codex', preference: '0' })).toBe(false)
  })

  it('does not enable the Codex-specific transport for other hosts or platforms', () => {
    expect(shouldEnableNativeSubmission({ platform: 'linux', adapterId: 'codex' })).toBe(false)
    expect(shouldEnableNativeSubmission({ platform: 'darwin', adapterId: 'other' })).toBe(false)
  })
})
