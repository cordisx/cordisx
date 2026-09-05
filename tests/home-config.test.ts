import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createDefaultHomeConfig,
  DEFAULT_MARKETPLACE_TRUST_SOURCE,
  ensureHomeConfig,
  loadHomeConfig,
  parseHomeConfig,
  resolveHomeConfigPath,
  updateHomeConfigAtomic,
} from '../packages/cli/src/config/home-config.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'

async function fixturePath(): Promise<{ root: string; configPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-home-config-'))
  return { root, configPath: path.join(root, '.cordisx', 'config.json') }
}

describe('CordisX home configuration', () => {
  it('resolves CORDISX_HOME ahead of the platform home without consulting cwd', () => {
    expect(resolveHomeConfigPath({
      env: { CORDISX_HOME: '/var/tmp/cordisx-test-home' },
      homedir: '/Users/example',
    })).toBe('/var/tmp/cordisx-test-home/config.json')
    expect(resolveHomeConfigPath({ env: {}, homedir: '/Users/example' }))
      .toBe('/Users/example/.cordisx/config.json')
    expect(() => resolveHomeConfigPath({ env: { CORDISX_HOME: './relative' }, homedir: '/Users/example' }))
      .toThrow('CORDISX_HOME must be an absolute path')
  })

  it('creates deterministic plugin-free defaults with private permissions', async () => {
    const { configPath } = await fixturePath()
    const config = await ensureHomeConfig(configPath)
    expect(config).toEqual(createDefaultHomeConfig())
    expect(config.plugins).toEqual([])
    expect(config.marketplaceTrustSources).toEqual([{ url: DEFAULT_MARKETPLACE_TRUST_SOURCE, enabled: true }])
    expect(config.apps.codex?.profiles.default?.dataMode).toBe('shared')
    expect((await stat(path.dirname(configPath))).mode & 0o777).toBe(0o700)
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
    expect(await readdir(path.dirname(configPath))).toEqual(['config.json'])
  })

  it('is idempotent and returns an existing valid configuration without rewriting it', async () => {
    const { configPath } = await fixturePath()
    await ensureHomeConfig(configPath)
    const custom = {
      ...createDefaultHomeConfig(),
      apps: {
        codex: {
          defaultProfile: 'work',
          profiles: {
            default: { displayName: 'Default', dataMode: 'shared' as const },
            work: { displayName: 'Work', dataMode: 'host-isolated' as const },
          },
        },
      },
    }
    const original = `${JSON.stringify(custom)}\n`
    await writeFile(configPath, original, { mode: 0o644 })
    const loaded = await ensureHomeConfig(configPath)
    expect(loaded.apps.codex?.defaultProfile).toBe('work')
    expect(await readFile(configPath, 'utf8')).toBe(original)
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
  })

  it('reads the legacy isolated host-root spelling without rewriting the user configuration', async () => {
    const { configPath } = await fixturePath()
    await ensureHomeConfig(configPath)
    const legacy = {
      ...createDefaultHomeConfig(),
      apps: {
        codex: {
          defaultProfile: 'legacy',
          profiles: {
            default: { displayName: 'Default', dataMode: 'shared' },
            legacy: { displayName: 'Legacy', dataMode: 'isolated' },
          },
        },
      },
    }
    const original = `${JSON.stringify(legacy)}\n`
    await writeFile(configPath, original, { mode: 0o600 })
    const loaded = await ensureHomeConfig(configPath)
    expect(loaded.apps.codex?.profiles.legacy?.dataMode).toBe('host-isolated')
    expect(await readFile(configPath, 'utf8')).toBe(original)
  })

  it('normalizes an exact profile icon-theme preference and drops only a corrupted preference', () => {
    const base = createDefaultHomeConfig()
    const exact = {
      revision: 3,
      providerId: 'plugin:aurora:aurora' as const,
      namespace: 'aurora',
      providerVersion: '2.1.0',
      providerGeneration: 'aurora-3',
    }
    const parsed = parseHomeConfig({
      ...base,
      apps: {
        codex: {
          ...base.apps.codex,
          profiles: { default: { ...base.apps.codex!.profiles.default, iconTheme: exact } },
        },
      },
    })
    expect(parsed.apps.codex?.profiles.default?.iconTheme).toEqual(exact)

    for (
      const iconTheme of [
        { ...exact, revision: -1 },
        { ...exact, providerId: 'plugin:spoof' },
        { ...exact, providerGeneration: '../private/path' },
        { ...exact, descriptors: [] },
        'corrupted',
      ]
    ) {
      const recovered = parseHomeConfig({
        ...base,
        apps: {
          codex: { ...base.apps.codex, profiles: { default: { ...base.apps.codex!.profiles.default, iconTheme } } },
        },
      })
      expect(recovered.apps.codex?.profiles.default?.iconTheme).toBeUndefined()
      expect(recovered.apps.codex?.profiles.default?.dataMode).toBe('shared')
    }
  })

  it('strictly rejects unsupported, unknown, and inconsistent fields', () => {
    expect(() => parseHomeConfig({ ...createDefaultHomeConfig(), version: 2 }))
      .toThrow('config.version must be 1')
    expect(() => parseHomeConfig({ ...createDefaultHomeConfig(), extra: true }))
      .toThrow('config.extra is not supported')
    expect(() =>
      parseHomeConfig({
        ...createDefaultHomeConfig(),
        apps: { codex: { defaultProfile: 'missing', profiles: {} } },
      })
    ).toThrow('references missing profile')
    expect(() =>
      parseHomeConfig({
        ...createDefaultHomeConfig(),
        plugins: [
          { id: 'demo', entry: './demo.ts' },
          { id: 'demo', entry: './other.ts' },
        ],
      })
    ).toThrow('duplicate plugin id: demo')
    expect(() =>
      parseHomeConfig({
        ...createDefaultHomeConfig(),
        permissions: [{
          ...createPermissionPolicyRecord({
            profileId: 'default',
            identity: { source: 'file:///plugins/demo.js', id: 'demo' },
            capability: 'models.read',
            scope: {},
            policy: 'allow',
          }),
          policy: 'allow-once',
        }],
      })
    ).toThrow('policy is unsupported')
    expect(() =>
      parseHomeConfig({
        ...createDefaultHomeConfig(),
        marketplaceTrustSources: [{ url: DEFAULT_MARKETPLACE_TRUST_SOURCE, enabled: true, certified: true }],
      })
    ).toThrow('certified is not supported')
    expect(() =>
      parseHomeConfig({
        ...createDefaultHomeConfig(),
        marketplaceTrustSources: [{ url: 'http://marketplace.example/feed.json', enabled: true }],
      })
    ).toThrow('must be an HTTPS URL')
    expect(() =>
      parseHomeConfig({
        ...createDefaultHomeConfig(),
        marketplaceTrustSources: [
          { url: DEFAULT_MARKETPLACE_TRUST_SOURCE, enabled: true },
          { url: DEFAULT_MARKETPLACE_TRUST_SOURCE, enabled: false },
        ],
      })
    ).toThrow('duplicate Marketplace trust source')
    expect(() =>
      parseHomeConfig({
        ...createDefaultHomeConfig(),
        marketplaceTrustSources: Array.from({ length: 9 }, (_, index) => ({
          url: `https://marketplace.example/${index}.json`,
          enabled: true,
        })),
      })
    ).toThrow('at most 8 sources')
  })

  it('migrates a legacy config to the Launcher-owned official trust root without consulting renderer state', () => {
    const legacy = { ...createDefaultHomeConfig() } as Record<string, unknown>
    delete legacy.marketplaceTrustSources
    expect(parseHomeConfig(legacy).marketplaceTrustSources).toEqual([{
      url: DEFAULT_MARKETPLACE_TRUST_SOURCE,
      enabled: true,
    }])
    expect(parseHomeConfig({ ...legacy, marketplaceTrustSources: [] }).marketplaceTrustSources).toEqual([])
  })

  it('keeps persistent policies separated by profile, identity, capability, and exact scope', async () => {
    const { configPath } = await fixturePath()
    await ensureHomeConfig(configPath)
    const base = {
      identity: { source: 'file:///plugins/demo.js', id: 'demo' },
      capability: 'models.read' as const,
      policy: 'allow' as const,
    }
    const policies = [
      createPermissionPolicyRecord({ ...base, profileId: 'default', scope: { providers: ['codex'] } }),
      createPermissionPolicyRecord({ ...base, profileId: 'work', scope: { providers: ['codex'] } }),
      createPermissionPolicyRecord({ ...base, profileId: 'default', scope: { providers: ['codex', 'zcode'] } }),
      createPermissionPolicyRecord({
        ...base,
        profileId: 'default',
        identity: { source: 'file:///plugins/other.js', id: 'demo' },
        scope: { providers: ['codex'] },
      }),
    ]
    await updateHomeConfigAtomic(current => ({ ...current, permissions: policies }), configPath)
    const readback = await loadHomeConfig(configPath)
    expect(readback.permissions).toEqual(policies)
    expect(new Set(readback.permissions.map(item => JSON.stringify(item.key))).size).toBe(4)
  })

  it('treats prototype-looking app and profile ids as ordinary own keys', () => {
    expect(() =>
      parseHomeConfig({
        version: 1,
        defaultApp: 'constructor',
        plugins: [],
        apps: {},
      })
    ).toThrow('config.defaultApp references missing app: constructor')
    expect(() =>
      parseHomeConfig({
        version: 1,
        defaultApp: 'codex',
        plugins: [],
        apps: { codex: { defaultProfile: 'constructor', profiles: {} } },
      })
    ).toThrow('defaultProfile references missing profile: constructor')
    const parsed = parseHomeConfig({
      version: 1,
      defaultApp: 'codex',
      plugins: [],
      apps: {
        codex: {
          defaultProfile: 'constructor',
          profiles: JSON.parse('{"constructor":{"displayName":"Constructor","dataMode":"host-isolated"}}'),
        },
      },
    })
    expect(Object.hasOwn(parsed.apps.codex?.profiles ?? {}, 'constructor')).toBe(true)
    const pluginConfig = JSON.parse('{"__proto__":{"enabled":true}}') as unknown
    const withPlugin = parseHomeConfig({
      ...createDefaultHomeConfig(),
      plugins: [{ id: 'prototype-config', entry: './plugin.ts', config: pluginConfig }],
    })
    const normalized = withPlugin.plugins[0]?.config
    expect(normalized !== null && typeof normalized === 'object' && Object.hasOwn(normalized, '__proto__')).toBe(true)
  })

  it('does not overwrite an invalid existing file', async () => {
    const { configPath } = await fixturePath()
    await ensureHomeConfig(configPath)
    const invalid = '{ this is not JSON }\n'
    await writeFile(configPath, invalid)
    await expect(ensureHomeConfig(configPath)).rejects.toThrow('invalid JSON in home config')
    expect(await readFile(configPath, 'utf8')).toBe(invalid)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a symbolic-link target without following or replacing it',
    async () => {
      const { root, configPath } = await fixturePath()
      await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 })
      await chmod(path.dirname(configPath), 0o700)
      const targetPath = path.join(root, 'outside-config.json')
      const targetContents = `${JSON.stringify(createDefaultHomeConfig())}\n`
      await writeFile(targetPath, targetContents)
      await symlink(targetPath, configPath)

      await expect(loadHomeConfig(configPath)).rejects.toThrow('must be a regular file')
      await expect(ensureHomeConfig(configPath)).rejects.toThrow('must be a regular file')
      await expect(updateHomeConfigAtomic((current) => current, configPath))
        .rejects.toThrow('must be a regular file')

      expect((await lstat(configPath)).isSymbolicLink()).toBe(true)
      expect(await readFile(targetPath, 'utf8')).toBe(targetContents)
    },
  )

  it('rejects a directory target without replacing it', async () => {
    const { configPath } = await fixturePath()
    await mkdir(configPath, { recursive: true })
    await chmod(path.dirname(configPath), 0o700)
    await expect(ensureHomeConfig(configPath)).rejects.toThrow('must be a regular file')
    await expect(updateHomeConfigAtomic((current) => current, configPath))
      .rejects.toThrow('must be a regular file')
    expect((await lstat(configPath)).isDirectory()).toBe(true)
  })

  it('never changes permissions on an existing broad CordisX home directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-home-directory-'))
    const cordisxHome = path.join(root, 'shared')
    await mkdir(cordisxHome, { mode: 0o755 })
    await expect(ensureHomeConfig(path.join(cordisxHome, 'config.json')))
      .rejects.toThrow('CordisX home must already be private (0700)')
    expect((await stat(cordisxHome)).mode & 0o777).toBe(0o755)
  })

  it.skipIf(process.platform === 'win32')(
    'tightens an explicit user-owned CORDISX_HOME without touching its parents',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-home-directory-'))
      const cordisxHome = path.join(root, 'ui-demos')
      await chmod(root, 0o755)
      await mkdir(cordisxHome, { mode: 0o755 })
      await ensureHomeConfig({ env: { CORDISX_HOME: cordisxHome } })
      expect((await stat(cordisxHome)).mode & 0o777).toBe(0o700)
      expect((await stat(root)).mode & 0o777).not.toBe(0o700)
      expect((await stat(path.join(cordisxHome, 'config.json'))).mode & 0o777).toBe(0o600)
    },
  )

  it('tightens only the canonical default ~/.cordisx directory for legacy migration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-home-directory-'))
    const cordisxHome = path.join(root, '.cordisx')
    await mkdir(cordisxHome, { mode: 0o755 })
    await ensureHomeConfig({ env: {}, homedir: root })
    expect((await stat(cordisxHome)).mode & 0o777).toBe(0o700)
    expect((await stat(path.join(cordisxHome, 'config.json'))).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('rejects a symlinked CordisX home without changing its target', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-home-directory-'))
    const target = path.join(root, 'target')
    const link = path.join(root, 'link')
    await mkdir(target, { mode: 0o755 })
    await symlink(target, link)
    await expect(ensureHomeConfig(path.join(link, 'config.json')))
      .rejects.toThrow('CordisX home must be a real directory')
    expect((await stat(target)).mode & 0o777).toBe(0o755)
  })

  it('serializes concurrent atomic updates without losing named profiles', async () => {
    const { configPath } = await fixturePath()
    await ensureHomeConfig(configPath)
    const addProfile = (profileId: string, delayMs: number) =>
      updateHomeConfigAtomic(async (current) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        const codex = current.apps.codex
        if (codex === undefined) throw new Error('missing codex app')
        return {
          ...current,
          apps: {
            ...current.apps,
            codex: {
              ...codex,
              profiles: {
                ...codex.profiles,
                [profileId]: { displayName: profileId, dataMode: 'host-isolated' },
              },
            },
          },
        }
      }, configPath)
    await Promise.all([
      addProfile('work', 30),
      addProfile('personal', 5),
      addProfile('testing', 1),
    ])
    const result = await loadHomeConfig(configPath)
    expect(Object.keys(result.apps.codex?.profiles ?? {}).sort())
      .toEqual(['default', 'personal', 'testing', 'work'])
    expect(await readdir(path.dirname(configPath))).toEqual(['config.json'])
  })

  it('bounds lock waiting and diagnoses stale locks without modifying config', async () => {
    const { configPath } = await fixturePath()
    await ensureHomeConfig(configPath)
    const before = await readFile(configPath, 'utf8')
    const lockPath = `${configPath}.lock`
    await writeFile(lockPath, 'abandoned\n', { mode: 0o600 })
    const old = new Date(Date.now() - 5_000)
    await chmod(lockPath, 0o600)
    const { utimes } = await import('node:fs/promises')
    await utimes(lockPath, old, old)
    await expect(updateHomeConfigAtomic((current) => current, {
      configPath,
      lockTimeoutMs: 10,
      lockRetryMs: 1,
      lockStaleMs: 100,
    })).rejects.toThrow('home config lock appears stale')
    expect(await readFile(configPath, 'utf8')).toBe(before)
  })
})
