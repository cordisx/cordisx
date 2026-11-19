import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ChannelGroupGuidance } from '../packages/cli/src/launcher/channel-group-guidance.js'

const account = { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant_a' }

describe('bounded Channel group guidance', () => {
  it('reserves once across simultaneous processes, restart and a UTC day boundary', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'channel-guidance-'))
    let now = 86_400_000 * 20000 + 86_399_000
    try {
      const first = new ChannelGroupGuidance(root, () => now)
      const second = new ChannelGroupGuidance(root, () => now)
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) => (index % 2 ? first : second).reserve(account, 'oc_group')),
      )
      expect(results.filter(Boolean)).toHaveLength(1)
      now += 2000
      expect(await new ChannelGroupGuidance(root, () => now).reserve(account, 'oc_group')).toBe(false)
      expect(await second.reserve(account, 'oc_other')).toBe(true)
      expect((await readdir(root)).join(' ')).not.toContain('oc_group')
      now += 2 * 86_400_000
      expect(await first.reserve(account, 'oc_group')).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
