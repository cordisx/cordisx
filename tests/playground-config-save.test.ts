import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ensureHomeConfig,
  loadHomeConfig,
  updateHomeConfigAtomic,
} from '../packages/cli/src/config/home-config.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import {
  createConfigBridgeHandler,
  parseConfigBindingRequest,
} from '../packages/cli/src/launcher/config-rpc.js'
import { createLauncherConfigBridgeHandler } from '../packages/cli/src/launcher/launcher-plugin-config.js'

const token = 'a'.repeat(64)

function request(input: {
  readonly operation: 'stage' | 'commit'
  readonly requestId: string
  readonly source: string
  readonly pluginId?: string
  readonly generation: string
  readonly expectedRevision?: number
  readonly candidateRevision?: number
  readonly config?: unknown
}) {
  return parseConfigBindingRequest({
    version: 1, token, operation: input.operation, requestId: input.requestId,
    identity: { source: input.source, pluginId: input.pluginId ?? 'cli-proxy-api' },
    scope: { profileId: 'playground', generation: input.generation },
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    ...(input.candidateRevision === undefined ? {} : { candidateRevision: input.candidateRevision }),
    ...(input.config === undefined ? {} : { config: input.config }),
  }, token, 'playground', input.generation)
}

describe('Playground plugin configuration persistence', () => {
  it('updates only the scoped plugin ledger inside a launcher envelope and survives generation reload', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-playground-config-save-'))
    const configPath = path.join(root, 'home', 'config', 'playground.config.json')
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(configPath, `${JSON.stringify({
      version: 1,
      codex: { debugPort: 9229, agentLoopBackend: 'mock' },
      providers: [],
      plugins: [{ id: 'cli-proxy-api', entry: 'cordisx:cli-proxy-api', enabled: true, config: { shortcutPolicy: 'enter' } }],
      futureLauncherField: { retained: true },
    }, null, 2)}\n`)
    try {
      const firstGeneration = 'playground-generation-1'
      const firstComposition = await loadConfig(configPath, { profileId: 'playground' })
      const plugin = firstComposition.plugins[0]!
      const source = pathToFileURL(plugin.entry).href
      const first = createLauncherConfigBridgeHandler({
        token, profileId: 'playground', generation: firstGeneration, configPath, composition: firstComposition,
      })
      await expect(first.handle(request({
        operation: 'stage', requestId: 'stage-choice', source, generation: firstGeneration,
        expectedRevision: 0, config: { shortcutPolicy: 'mod-enter' },
      }))).resolves.toEqual({ candidateRevision: 1 })
      await expect(first.handle(request({
        operation: 'commit', requestId: 'commit-choice', source, generation: firstGeneration, candidateRevision: 1,
      }))).resolves.toEqual({ revision: 1, config: { shortcutPolicy: 'mod-enter' } })

      const persisted = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
      expect(persisted.codex).toEqual({ debugPort: 9229, agentLoopBackend: 'mock' })
      expect(persisted.futureLauncherField).toEqual({ retained: true })
      expect((persisted.plugins as Array<Record<string, unknown>>)[0]).toMatchObject({
        id: 'cli-proxy-api', entry: 'cordisx:cli-proxy-api', enabled: true,
        config: { shortcutPolicy: 'enter' },
        profiles: { playground: { revision: 1, config: { shortcutPolicy: 'mod-enter' } } },
      })
      await expect(first.handle(request({
        operation: 'stage', requestId: 'stale-choice', source, generation: firstGeneration,
        expectedRevision: 0, config: { shortcutPolicy: 'enter' },
      }))).rejects.toMatchObject({ actualRevision: 1 })

      const reloaded = await loadConfig(configPath, { profileId: 'playground' })
      expect(reloaded).toMatchObject({
        codex: { agentLoopBackend: 'mock' },
        plugins: [{ id: 'cli-proxy-api', revision: 1, config: { shortcutPolicy: 'mod-enter' } }],
      })
      const secondGeneration = 'playground-generation-2'
      const second = createLauncherConfigBridgeHandler({
        token, profileId: 'playground', generation: secondGeneration, configPath, composition: reloaded,
      })
      await expect(second.handle(request({
        operation: 'stage', requestId: 'stage-after-reload', source, generation: secondGeneration,
        expectedRevision: 1, config: { shortcutPolicy: 'enter' },
      }))).resolves.toEqual({ candidateRevision: 2 })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails closed on an invalid launcher document without rewriting it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-playground-config-invalid-'))
    const configPath = path.join(root, 'home', 'config', 'playground.config.json')
    await mkdir(path.dirname(configPath), { recursive: true })
    await writeFile(configPath, `${JSON.stringify({
      version: 1, codex: { debugPort: 9229, agentLoopBackend: 'mock' }, providers: [],
      plugins: [{ id: 'cli-proxy-api', entry: 'cordisx:cli-proxy-api', enabled: true, config: {} }],
    })}\n`)
    try {
      const generation = 'playground-generation-1'
      const composition = await loadConfig(configPath, { profileId: 'playground' })
      const source = pathToFileURL(composition.plugins[0]!.entry).href
      const handler = createLauncherConfigBridgeHandler({ token, profileId: 'playground', generation, configPath, composition })
      const invalid = (await readFile(configPath, 'utf8')).replace('"mock"', '"unsupported"')
      await writeFile(configPath, invalid)
      await expect(handler.handle(request({
        operation: 'stage', requestId: 'invalid-launcher', source, generation,
        expectedRevision: 0, config: { shortcutPolicy: 'enter' },
      }))).rejects.toThrow('config.codex.agentLoopBackend must be local-cli or mock')
      expect(await readFile(configPath, 'utf8')).toBe(invalid)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the normal Home config bridge path compatible', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-home-config-bridge-'))
    const configPath = path.join(root, 'home', 'config.json')
    await ensureHomeConfig(configPath)
    await updateHomeConfigAtomic(current => ({
      ...current,
      plugins: [{ id: 'example', entry: './example.ts', enabled: true, config: { shortcutPolicy: 'enter' } }],
    }), configPath)
    try {
      const generation = 'home-generation-1'
      const composition = await loadConfig(configPath, { profileId: 'playground' })
      const source = pathToFileURL(composition.plugins[0]!.entry).href
      const handler = createConfigBridgeHandler({ token, profileId: 'playground', generation, configPath, composition })
      await handler.handle(request({
        operation: 'stage', requestId: 'home-stage', source, pluginId: 'example', generation,
        expectedRevision: 0, config: { shortcutPolicy: 'mod-enter' },
      }))
      await handler.handle(request({
        operation: 'commit', requestId: 'home-commit', source, pluginId: 'example', generation, candidateRevision: 1,
      }))
      expect((await loadHomeConfig(configPath)).plugins[0]?.profiles?.playground).toEqual({
        revision: 1, config: { shortcutPolicy: 'mod-enter' },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
