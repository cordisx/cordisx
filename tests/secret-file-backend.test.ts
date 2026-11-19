import { chmod, link, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LauncherSecretStore } from '../packages/cli/src/launcher/secret-store.js'
import { resolveLauncherSecret } from '../packages/cli/src/launcher/secret-resolver.js'
import { ChannelCredentialDraftBroker } from '../packages/cli/src/launcher/channel-credential-drafts.js'

const homes: string[] = []
async function home() {
  const value = await mkdtemp(path.join(os.tmpdir(), 'cordisx-linux-secrets-'))
  homes.push(value)
  return value
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map(value => rm(value, { recursive: true, force: true })))
})
const target = { profileId: 'work', connectionId: 'feishu-prod' }

describe.skipIf(process.platform === 'win32')('Linux Host-private credential storage', () => {
  it('saves, reopens, rotates and deletes without plaintext or references in renderer results', async () => {
    const homeDir = await home()
    const store = new LauncherSecretStore({ platform: 'linux', homeDir })
    const { captureId } = store.beginCapture(target)
    const reference = store.referenceFor(captureId)!
    expect(reference).toBe('host-secret:channel/work/feishu-prod')
    expect(await store.status(captureId)).toMatchObject({ state: 'unset' })
    const saved = await store.capture({ captureId, secret: 'first-test-secret' })
    expect(saved).toMatchObject({ state: 'set' })
    expect(JSON.stringify(saved)).not.toMatch(/first-test-secret|host-secret/)
    const directory = path.join(homeDir, 'credentials', 'channel')
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    for (const name of await readdir(directory)) {
      const file = path.join(directory, name)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
      expect((await readFile(file)).includes(Buffer.from('first-test-secret'))).toBe(false)
    }
    const reopened = new LauncherSecretStore({ platform: 'linux', homeDir })
    const capture = reopened.beginCapture(target)
    expect(await reopened.status(capture.captureId)).toMatchObject({ state: 'set' })
    // A fresh resolver models a separately started headless service; no injected backend.
    await expect(resolveLauncherSecret(reference, { platform: 'linux', homeDir })).resolves.toBe('first-test-secret')
    await reopened.capture({ captureId: capture.captureId, secret: 'rotated-test-secret' })
    await expect(resolveLauncherSecret(reference, { environment: { CORDISX_HOME: homeDir } }))
      .resolves.toBe('rotated-test-secret')
    const otherHome = await home()
    await expect(resolveLauncherSecret(reference, { homeDir: otherHome })).rejects.toMatchObject({
      code: 'SECRET_MISSING',
    })
    await expect(resolveLauncherSecret('host-secret:channel/other/feishu-prod', { homeDir }))
      .rejects.toMatchObject({ code: 'SECRET_MISSING' })
    expect(await reopened.remove(capture.captureId)).toMatchObject({ state: 'unset' })
    expect(await reopened.remove(capture.captureId)).toMatchObject({ state: 'unset' })
    await expect(resolveLauncherSecret(reference, { homeDir })).rejects.toMatchObject({ code: 'SECRET_MISSING' })
  })

  it.each(['permissions', 'symlink', 'hardlink', 'tampered', 'key-missing'] as const)(
    'fails closed on %s instead of exposing a secret or misreporting an unset field',
    async fault => {
      const homeDir = await home()
      const store = new LauncherSecretStore({ platform: 'linux', homeDir })
      const { captureId } = store.beginCapture(target)
      expect(await store.capture({ captureId, secret: 'test-only' })).toMatchObject({ state: 'set' })
      const directory = path.join(homeDir, 'credentials', 'channel')
      const file = path.join(directory, (await readdir(directory)).find(name => name.endsWith('.enc'))!)
      if (fault === 'permissions') await chmod(file, 0o644)
      if (fault === 'symlink') {
        const other = path.join(homeDir, 'other')
        await writeFile(other, 'outside', { mode: 0o600 })
        await rm(file)
        await symlink(other, file)
      }
      if (fault === 'hardlink') await link(file, path.join(homeDir, 'other'))
      if (fault === 'tampered') await writeFile(file, Buffer.alloc(32))
      if (fault === 'key-missing') await rm(path.join(directory, 'master-key'))
      expect(await store.status(captureId)).toMatchObject({ state: 'unavailable' })
      await expect(resolveLauncherSecret(store.referenceFor(captureId), { homeDir })).rejects.toMatchObject({
        code: 'SECRET_UNAVAILABLE',
      })
      if (fault === 'key-missing') {
        expect(await store.capture({ captureId, secret: 'replacement-test' })).toMatchObject({ state: 'unavailable' })
      }
    },
  )

  it('rejects unsafe paths and linked credential directories', async () => {
    const homeDir = await home()
    const outside = await home()
    await symlink(outside, path.join(homeDir, 'credentials'))
    const store = new LauncherSecretStore({ platform: 'linux', homeDir })
    const capture = store.beginCapture(target)
    expect(await store.capture({ captureId: capture.captureId, secret: 'test-only' })).toMatchObject({
      state: 'unavailable',
    })
    expect(await readdir(outside)).toEqual([])
    for (const reference of ['host-secret:channel/../outside', 'host-secret:channel/work/../../key']) {
      await expect(resolveLauncherSecret(reference, { homeDir })).rejects.toMatchObject({ code: 'SECRET_REF_INVALID' })
    }
  })

  it('commits the Manager credential draft and resolves its saved configuration after reopening', async () => {
    const homeDir = await home()
    let configuration: unknown
    const descriptor = {
      identity: { source: 'file:///channel', pluginId: 'channel', serviceId: 'runtime' },
      scope: { profileId: 'work', generation: '1' },
      revision: 0,
      writable: true,
      configuration: { contract: 'cordisx.channel-service-config/v2', schemaVersion: 2, connections: [] },
    }
    const broker = new ChannelCredentialDraftBroker({
      profileId: 'work',
      store: new LauncherSecretStore({ platform: 'linux', homeDir }),
      discoverTenant: async () => 'tenant',
      service: {
        descriptor: async () => descriptor,
        mutate: async (mutation: { configuration: unknown }) => {
          configuration = mutation.configuration
          return { status: 'applied', revision: 1 }
        },
      } as never,
    })
    try {
      const captured = await broker.handle({
        operation: 'capture',
        owner: 'owner',
        purpose: 'create',
        account: { adapterId: 'feishu', accountId: 'cli_test', tenantId: 'tenant' },
        secret: 'manager-test-secret',
      }, 'document')
      expect(captured).toMatchObject({ status: 'applied' })
      const committed = await broker.handle({
        operation: 'commit',
        owner: 'owner',
        draftId: captured.draftId,
        draft: { displayName: 'Test', selectors: ['direct', 'mentions'] },
      }, 'document')
      expect(committed).toMatchObject({ status: 'applied' })
      expect(JSON.stringify([captured, committed])).not.toMatch(/manager-test-secret|host-secret/)
      const connection = (configuration as { connections: { secretRef: string }[] }).connections[0]!
      expect(connection.secretRef).toMatch(/^host-secret:channel\/work\//)
      await expect(resolveLauncherSecret(connection.secretRef, { platform: 'linux', homeDir }))
        .resolves.toBe('manager-test-secret')
    } finally {
      await broker.dispose()
    }
  })
})
