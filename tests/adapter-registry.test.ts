import { describe, expect, it } from 'vitest'
import { resolveHostAdapter } from '../packages/cli/src/adapters/registry.js'

describe('host adapter registry', () => {
  it('provides Codex without falling back for another host id', () => {
    expect(resolveHostAdapter('codex').id).toBe('codex')
    expect(() => resolveHostAdapter('claude-code')).toThrow('host adapter is not installed: claude-code')
    expect(() => resolveHostAdapter('unknown')).toThrow('host adapter is not installed: unknown')
  })
})
