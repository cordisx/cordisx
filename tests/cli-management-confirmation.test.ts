import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { confirmManagementMutation } from '../packages/cli/src/cli/management-confirmation.js'

describe('management CLI confirmation', () => {
  it('uses the injected confirmation seam for command tests', async () => {
    const confirm = vi.fn(async () => true)
    await expect(confirmManagementMutation('Apply?', { confirm })).resolves.toBe(true)
    expect(confirm).toHaveBeenCalledWith('Apply?')
  })

  it('fails closed on non-interactive input', async () => {
    const stdin = new PassThrough() as PassThrough & { isTTY?: boolean }
    stdin.isTTY = false
    await expect(confirmManagementMutation('Apply?', { stdin })).rejects.toThrow('use --yes')
  })
})
