import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ensureHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { LauncherSecretStore } from '../packages/cli/src/launcher/secret-store.js'
import { ManagerChannelDraftJournal } from '../packages/cli/src/launcher/manager-channel-draft-journal.js'

const exec = promisify(execFile)
const reference = 'host-secret:channel/work/draft-0123456789abcdef0123456789abcdef01234567'

async function crashedFixture() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cx-channel-journal-'))
  const configPath = path.join(homeDir, 'config.json')
  await ensureHomeConfig(configPath)
  await exec(process.execPath, ['--import', 'tsx', 'tests/fixtures/manager-channel-journal-crash.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, CORDISX_FIXTURE_HOME: homeDir, CORDISX_FIXTURE_CONFIG: configPath },
  }).then(() => {
    throw new Error('fixture did not exit at crash point')
  }, error => {
    if (error.code !== 17) throw error
  })
  const store = new LauncherSecretStore({ homeDir, platform: 'linux' })
  const journal = new ManagerChannelDraftJournal({ homeDir, configPath, profileId: 'work', store })
  const directory = path.join(homeDir, 'credentials', 'manager-channel-drafts', 'work')
  return {
    homeDir,
    configPath,
    store,
    journal,
    directory,
    close: async () => await rm(homeDir, { recursive: true, force: true }),
  }
}

describe('manager Channel draft crash recovery', () => {
  it('removes only a journalled unreferenced draft after an abrupt process exit', async () => {
    const f = await crashedFixture()
    try {
      expect(await f.store.readChannelReference(reference, 'work')).toBe('synthetic-secret')
      expect(await readdir(f.directory)).toHaveLength(1)
      await f.journal.recover()
      await expect(f.store.readChannelReference(reference, 'work')).rejects.toThrow('CREDENTIAL_UNAVAILABLE')
      expect(await readdir(f.directory)).toEqual([])
    } finally {
      await f.close()
    }
  })

  it('preserves a committed or candidate reference anywhere in the validated original configuration', async () => {
    const f = await crashedFixture()
    try {
      await updateHomeConfigAtomic(config => ({
        ...config,
        plugins: [{
          id: 'other-plugin',
          entry: '/fixture',
          config: { nested: { future: reference } },
        }],
      }), f.configPath)
      await f.journal.recover()
      expect(await f.store.readChannelReference(reference, 'work')).toBe('synthetic-secret')
      expect(await readdir(f.directory)).toEqual([])
    } finally {
      await f.close()
    }
  })

  it.each(['committed', 'candidate', 'last-good'])('preserves a %s service reference', async location => {
    const f = await crashedFixture()
    try {
      const saved = { nested: { secretRef: reference } }
      const state = location === 'committed'
        ? { revision: 1, lastGoodRevision: 1, config: saved }
        : location === 'candidate'
        ? {
          revision: 0,
          lastGoodRevision: 0,
          config: {},
          candidate: {
            revision: 1,
            config: saved,
            applies: 'service-restart' as const,
            ownerToken: 'a'.repeat(64),
            generation: 'host-1',
            createdAt: new Date().toISOString(),
          },
        }
        : { revision: 1, lastGoodRevision: 0, config: {}, lastGoodConfig: saved, restartRequired: true as const }
      await updateHomeConfigAtomic(config => ({
        ...config,
        plugins: [{
          id: 'channel',
          entry: '/fixture',
          config: {},
          services: { runtime: { profiles: { other: state } } },
        }],
      }), f.configPath)
      await f.journal.recover()
      expect(await f.store.readChannelReference(reference, 'work')).toBe('synthetic-secret')
    } finally {
      await f.close()
    }
  })

  it('never deletes when configuration is unreadable or the ledger identity is inconsistent', async () => {
    const f = await crashedFixture()
    try {
      const originalConfig = await readFile(f.configPath, 'utf8')
      await writeFile(f.configPath, '{broken')
      await expect(f.journal.recover()).rejects.toThrow()
      expect(await f.store.readChannelReference(reference, 'work')).toBe('synthetic-secret')
      await writeFile(f.configPath, originalConfig)
      const [file] = await readdir(f.directory)
      await writeFile(path.join(f.directory, file!), JSON.stringify({ version: 1, profileId: 'other', reference }))
      await expect(f.journal.recover()).rejects.toThrow('DRAFT_RECOVERY_UNAVAILABLE')
      expect(await f.store.readChannelReference(reference, 'work')).toBe('synthetic-secret')
    } finally {
      await f.close()
    }
  })
})
