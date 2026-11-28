import { readFile, writeFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { ownerAdapterConfiguredHistoryIdentity } from '../packages/cli/src/cli/owner-adapter-configured-history.js'
import { createOwnerAdapterPermissionHistory } from '../packages/cli/src/cli/owner-adapter-permission-history.js'
import { PermissionDecisionJournal } from '../packages/cli/src/cli/permission-decision-journal.js'
import { withManagerDomAskPolicies } from '../packages/cli/src/cli/permission-decision-history.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'

const archive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE

it.skipIf(!archive)(
  'lets an admitted native client read Web decisions for the exact configured archive',
  async () => {
    const f = await fixture({ channelArchive: archive })
    try {
      const config = await loadConfig(f.configPath, { profileId: f.profileId, projectRoot: f.homeDir })
      const context = { secret: 'fixture', current: () => true }
      const controller = new AbortController()
      const input = {
        homeDir: f.homeDir,
        profileId: f.profileId,
        generation: f.generation,
        pluginId: 'channel',
        context,
        lifecycle: f.lifecycle,
        config,
        signal: controller.signal,
      }
      const target = await ownerAdapterConfiguredHistoryIdentity(input)
      expect(target.identity.source).toBe(f.configuredChannel!.plugin.source)
      const journal = new PermissionDecisionJournal({ homeDir: f.homeDir, profileId: f.profileId })
      const record = withManagerDomAskPolicies([], f.profileId, target.identity)[0]!
      const receipt = await journal.begin({
        client: 'web',
        requestId: 'fixture-web',
        records: [record],
        onceDecision: 'allow-once',
      })
      await receipt.commit()
      const history = createOwnerAdapterPermissionHistory({
        profileId: f.profileId,
        journal,
        loadPolicies: async () => [],
        reviewIdentity: async () => await ownerAdapterConfiguredHistoryIdentity(input).catch(() => undefined),
      })
      expect(await history({ kind: 'permission-history', pluginId: 'channel' }, context)).toMatchObject([{
        record,
        client: 'web',
        decision: 'allow-once',
        committedAt: expect.any(String),
      }])

      const document = JSON.parse(await readFile(f.configPath, 'utf8'))
      document.plugins[0].enabled = false
      await writeFile(f.configPath, JSON.stringify(document))
      expect(await target.verifyCurrent()).toBe(false)
      await expect(history({ kind: 'permission-history', pluginId: 'channel' }, context)).rejects.toThrow(
        'permission-history-unavailable',
      )
      controller.abort()
    } finally {
      await f.close()
    }
  },
)
