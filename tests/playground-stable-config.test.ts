import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPlaygroundSession } from '../packages/cli/src/playground/session.js'
import { startVitePlayground } from '../packages/cli/src/playground/vite/server.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(config: unknown = { shortcutPolicy: 'enter' }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-playground-stable-config-'))
  roots.push(root)
  const sourcePath = path.join(root, 'source', 'playground.config.json')
  const homeDir = path.join(root, 'stable-home')
  await mkdir(path.dirname(sourcePath), { recursive: true })
  const writeSource = async (value: unknown) =>
    await writeFile(
      sourcePath,
      `${
        JSON.stringify(
          {
            version: 1,
            codex: { debugPort: 9229, agentLoopBackend: 'mock' },
            providers: [],
            plugins: [{ id: 'cli-proxy-api', entry: 'cordisx:cli-proxy-api', enabled: true, config: value }],
            futureLauncherField: { from: 'fixture' },
          },
          null,
          2,
        )
      }\n`,
    )
  await writeSource(config)
  return {
    root,
    sourcePath,
    homeDir,
    writeSource,
    launcherPath: path.join(homeDir, 'config', 'playground.config.json'),
    homeConfigPath: path.join(homeDir, 'config', 'playground.home.json'),
  }
}

function configBinding(source: string) {
  const token = /configBridgeToken: "([a-f0-9]{64})"/.exec(source)?.[1]
  const generation = /generation: "(playground-[a-f0-9]+)"/.exec(source)?.[1]
  const identity = /\{ id: "cli-proxy-api", source: "([^"]+)"/.exec(source)?.[1]
  if (token === undefined || generation === undefined || identity === undefined) {
    throw new Error('missing config binding')
  }
  return { token, generation, source: identity }
}

function request(binding: ReturnType<typeof configBinding>, input: {
  readonly operation: 'stage' | 'commit'
  readonly requestId: string
  readonly expectedRevision?: number
  readonly candidateRevision?: number
  readonly config?: unknown
}) {
  return JSON.stringify({
    version: 1,
    token: binding.token,
    operation: input.operation,
    requestId: input.requestId,
    identity: { source: binding.source, pluginId: 'cli-proxy-api' },
    scope: { profileId: 'playground', generation: binding.generation },
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    ...(input.candidateRevision === undefined ? {} : { candidateRevision: input.candidateRevision }),
    ...(input.config === undefined ? {} : { config: input.config }),
  })
}

describe('stable Playground configuration materialization', () => {
  it('materializes both validated documents only on the first external-home startup', async () => {
    const value = await fixture()
    const session = await createPlaygroundSession(value.sourcePath, { homeDir: value.homeDir })
    try {
      const composition = await session.buildComposition('/runtime.ts')
      expect(composition.source).toContain('config: {"shortcutPolicy":"enter"}, revision: 0')
      expect(JSON.parse(await readFile(value.launcherPath, 'utf8'))).toMatchObject({
        codex: { debugPort: 9229, agentLoopBackend: 'mock' },
        futureLauncherField: { from: 'fixture' },
      })
      expect(JSON.parse(await readFile(value.homeConfigPath, 'utf8'))).toMatchObject({
        defaultApp: 'codex',
        apps: { codex: { defaultProfile: 'playground' } },
      })
    } finally {
      await session.close()
    }
    await expect(access(value.launcherPath)).resolves.toBeUndefined()
    await expect(access(value.homeConfigPath)).resolves.toBeUndefined()
  }, 30_000)

  it('uses the persisted revision on a second startup and ignores changed source defaults', async () => {
    const value = await fixture()
    const first = await createPlaygroundSession(value.sourcePath, { homeDir: value.homeDir })
    const initial = await first.buildComposition('/runtime.ts')
    const binding = configBinding(initial.source)
    await first.handleConfigRequest(request(binding, {
      operation: 'stage',
      requestId: 'stage-mod-enter',
      expectedRevision: 0,
      config: { shortcutPolicy: 'mod-enter' },
    }))
    await first.handleConfigRequest(request(binding, {
      operation: 'commit',
      requestId: 'commit-mod-enter',
      candidateRevision: 1,
    }))
    await first.close()
    const persistedLauncher = await readFile(value.launcherPath, 'utf8')
    const persistedHome = await readFile(value.homeConfigPath, 'utf8')

    await value.writeSource({ shortcutPolicy: 'source-changed', newDefault: true })
    const second = await createPlaygroundSession(value.sourcePath, { homeDir: value.homeDir })
    try {
      expect(await readFile(value.launcherPath, 'utf8')).toBe(persistedLauncher)
      expect(await readFile(value.homeConfigPath, 'utf8')).toBe(persistedHome)
      const firstServerComposition = await second.buildComposition('/runtime.ts')
      expect(firstServerComposition.source).toContain('config: {"shortcutPolicy":"mod-enter"}, revision: 1')
      expect(firstServerComposition.source).not.toContain('source-changed')
    } finally {
      await second.close()
    }
  }, 30_000)

  it('hydrates the first virtual composition of a restarted server from the persisted value', async () => {
    const value = await fixture()
    const first = await createPlaygroundSession(value.sourcePath, { homeDir: value.homeDir })
    const initial = await first.buildComposition('/runtime.ts')
    const binding = configBinding(initial.source)
    await first.handleConfigRequest(request(binding, {
      operation: 'stage',
      requestId: 'stage-server-mod-enter',
      expectedRevision: 0,
      config: { shortcutPolicy: 'mod-enter' },
    }))
    await first.handleConfigRequest(request(binding, {
      operation: 'commit',
      requestId: 'commit-server-mod-enter',
      candidateRevision: 1,
    }))
    await first.close()

    const server = await startVitePlayground({ configPath: value.sourcePath, homeDir: value.homeDir })
    try {
      const response = await fetch(new URL('/@id/__x00__virtual:cordisx-composition', server.url))
      expect(response.ok).toBe(true)
      const source = await response.text()
      expect(source).toContain('config: {"shortcutPolicy":"mod-enter"}, revision: 1')
      expect(source).not.toContain('config: {"shortcutPolicy":"enter"}, revision: 0')
    } finally {
      await server.close()
    }
  }, 30_000)

  it(
    'starts a new external-home server at generation zero without resetting retained owner or Session records',
    async () => {
      const value = await fixture()
      const initialized = await createPlaygroundSession(value.sourcePath, { homeDir: value.homeDir })
      await initialized.close()
      const retainedOwner = path.join(value.homeDir, 'state', 'owner-documents', 'v1', 'retained-room.json')
      const retainedSessions = path.join(value.homeDir, 'state', 'playground-agent-sessions', 'v1', 'ledger.json')
      await mkdir(path.dirname(retainedOwner), { recursive: true })
      await mkdir(path.dirname(retainedSessions), { recursive: true })
      await writeFile(retainedOwner, '{"rooms":3,"items":7}\n')
      await writeFile(retainedSessions, '{"sessions":6}\n')
      const launcherBefore = await readFile(value.launcherPath, 'utf8')
      const homeBefore = await readFile(value.homeConfigPath, 'utf8')

      const server = await startVitePlayground({ configPath: value.sourcePath, homeDir: value.homeDir })
      try {
        const epoch = await fetch(new URL('/api/reset-state', server.url)).then(async response => {
          expect(response.ok).toBe(true)
          return await response.json() as {
            readonly version: number
            readonly instanceId: string
            readonly generation: number
          }
        })
        expect(epoch).toMatchObject({ version: 1, generation: 0 })
        expect(epoch.instanceId).not.toBe('')
        expect(await readFile(value.launcherPath, 'utf8')).toBe(launcherBefore)
        expect(await readFile(value.homeConfigPath, 'utf8')).toBe(homeBefore)
        expect(await readFile(retainedOwner, 'utf8')).toBe('{"rooms":3,"items":7}\n')
        expect(await readFile(retainedSessions, 'utf8')).toBe('{"sessions":6}\n')
      } finally {
        await server.close()
      }
    },
    30_000,
  )

  it('fails closed on an existing malformed document without rewriting either config', async () => {
    const value = await fixture()
    const initialized = await createPlaygroundSession(value.sourcePath, { homeDir: value.homeDir })
    await initialized.close()
    const malformed = '{"version":1,"codex":{"agentLoopBackend":"unsupported"},"plugins":[]}'
    await writeFile(value.launcherPath, malformed)
    const homeBefore = await readFile(value.homeConfigPath, 'utf8')

    await expect(createPlaygroundSession(value.sourcePath, { homeDir: value.homeDir }))
      .rejects.toThrow('invalid Playground launcher config')
    expect(await readFile(value.launcherPath, 'utf8')).toBe(malformed)
    expect(await readFile(value.homeConfigPath, 'utf8')).toBe(homeBefore)
  })

  it('preflights an existing malformed home document before creating a missing launcher document', async () => {
    const value = await fixture()
    const initialized = await createPlaygroundSession(value.sourcePath, { homeDir: value.homeDir })
    await initialized.close()
    await unlink(value.launcherPath)
    const malformed = '{"version":1,"defaultApp":"missing","plugins":[],"apps":{}}'
    await writeFile(value.homeConfigPath, malformed)

    await expect(createPlaygroundSession(value.sourcePath, { homeDir: value.homeDir }))
      .rejects.toThrow('invalid Playground home config')
    await expect(access(value.launcherPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(value.homeConfigPath, 'utf8')).toBe(malformed)
  })

  it('retains disposable temp-home fixture replacement and cleanup semantics', async () => {
    const value = await fixture()
    const session = await createPlaygroundSession(value.sourcePath)
    const disposableHome = session.homeDir
    expect(disposableHome).not.toBe(value.homeDir)
    expect((await session.buildComposition('/runtime.ts')).source)
      .toContain('config: {"shortcutPolicy":"enter"}, revision: 0')
    await session.close()
    await expect(access(disposableHome)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)
})
