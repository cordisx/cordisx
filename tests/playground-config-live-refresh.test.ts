import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createPlaygroundSession,
  type PlaygroundEffectiveConfigCommit,
  type PreparedPlaygroundComposition,
} from '../packages/cli/src/playground/session.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-playground-live-config-'))
  roots.push(root)
  const configPath = path.join(root, 'source', 'playground.config.json')
  const homeDir = path.join(root, 'home')
  await mkdir(path.dirname(configPath), { recursive: true })
  await writeFile(configPath, `${JSON.stringify({
    version: 1,
    codex: { debugPort: 9229, agentLoopBackend: 'mock' },
    providers: [],
    plugins: [{
      id: 'cli-proxy-api', entry: 'cordisx:cli-proxy-api', enabled: true,
      config: { shortcutPolicy: 'enter' },
    }],
    futureLauncherField: { retained: true },
  }, null, 2)}\n`)
  return { root, configPath, homeDir }
}

function binding(source: string, token: string, generation: string, input: {
  readonly requestId: string
  readonly operation: 'stage' | 'commit'
  readonly expectedRevision?: number
  readonly candidateRevision?: number
  readonly config?: unknown
}) {
  return JSON.stringify({
    version: 1, token, operation: input.operation, requestId: input.requestId,
    identity: { source, pluginId: 'cli-proxy-api' },
    scope: { profileId: 'playground', generation },
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    ...(input.candidateRevision === undefined ? {} : { candidateRevision: input.candidateRevision }),
    ...(input.config === undefined ? {} : { config: input.config }),
  })
}

function bindingFromComposition(source: string) {
  const token = /configBridgeToken: "([a-f0-9]{64})"/.exec(source)?.[1]
  const generation = /generation: "(playground-[a-f0-9]+)"/.exec(source)?.[1]
  const identity = /\{ id: "cli-proxy-api", source: "([^"]+)"/.exec(source)?.[1]
  if (token === undefined || generation === undefined || identity === undefined) {
    throw new Error('Playground composition did not expose the expected config binding')
  }
  return { token, generation, source: identity }
}

describe('Playground effective configuration refresh', () => {
  it('wires successful session commits to the Vite virtual composition cache without restarting the server', async () => {
    const server = await readFile(path.resolve('packages/cli/src/playground/vite/server.ts'), 'utf8')
    expect(server).toContain('onEffectiveConfigCommitted()')
    expect(server).toContain('moduleGraph.getModuleById(RESOLVED_COMPOSITION_ID)')
    expect(server).toContain('moduleGraph.invalidateModule(composition)')
    expect(server).not.toContain('vite?.restart')
  })

  it('invalidates a same-server composition cache after commit and hydrates a new renderer from the committed revision', async () => {
    const value = await fixture()
    let cached: PreparedPlaygroundComposition | undefined
    let invalidations = 0
    const session = await createPlaygroundSession(value.configPath, {
      homeDir: value.homeDir,
      onEffectiveConfigCommitted() {
        cached = undefined
        invalidations += 1
      },
    })
    const newRenderer = async () => cached ??= await session.buildComposition('/runtime.ts')
    const before = (await newRenderer()).source
    expect(before).toContain('config: {"shortcutPolicy":"enter"}, revision: 0')
    const first = bindingFromComposition(before)
    await expect(session.handleConfigRequest(binding(first.source, first.token, first.generation, {
      operation: 'stage', requestId: 'stage-mod-enter', expectedRevision: 0,
      config: { shortcutPolicy: 'mod-enter' },
    }))).resolves.toMatchObject({ ok: true, value: { candidateRevision: 1 } })
    expect(invalidations).toBe(0)
    await expect(session.handleConfigRequest(binding(first.source, first.token, first.generation, {
      operation: 'commit', requestId: 'commit-mod-enter', candidateRevision: 1,
    }))).resolves.toMatchObject({ ok: true, value: { revision: 1, config: { shortcutPolicy: 'mod-enter' } } })
    expect(invalidations).toBe(1)

    const after = (await newRenderer()).source
    expect(after).toContain('config: {"shortcutPolicy":"mod-enter"}, revision: 1')
    expect(bindingFromComposition(after).generation).not.toBe(first.generation)
    const persisted = JSON.parse(await readFile(path.join(value.homeDir, 'config', 'playground.config.json'), 'utf8')) as Record<string, unknown>
    expect(persisted).toMatchObject({
      codex: { debugPort: 9229, agentLoopBackend: 'mock' },
      futureLauncherField: { retained: true },
      plugins: [{ profiles: { playground: { revision: 1, config: { shortcutPolicy: 'mod-enter' } } } }],
    })
    await session.close()
  }, 30_000)

  it('publishes only advancing successful commits and fences stale generations and disposal', async () => {
    const value = await fixture()
    const commits: PlaygroundEffectiveConfigCommit[] = []
    const session = await createPlaygroundSession(value.configPath, {
      homeDir: value.homeDir,
      onEffectiveConfigCommitted: commit => { commits.push(commit) },
    })
    const firstComposition = await session.buildComposition('/runtime.ts')
    const first = bindingFromComposition(firstComposition.source)

    const stage = await session.handleConfigRequest(binding(first.source, first.token, first.generation, {
      operation: 'stage', requestId: 'stage-one', expectedRevision: 0,
      config: { shortcutPolicy: 'mod-enter' },
    }))
    expect(stage).toMatchObject({ ok: true, value: { candidateRevision: 1 } })
    expect(commits).toEqual([])
    const committed = await session.handleConfigRequest(binding(first.source, first.token, first.generation, {
      operation: 'commit', requestId: 'commit-one', candidateRevision: 1,
    }))
    expect(committed).toMatchObject({ ok: true, value: { revision: 1 } })
    expect(commits).toEqual([{ generation: first.generation, pluginId: 'cli-proxy-api', revision: 1 }])

    const duplicate = await session.handleConfigRequest(binding(first.source, first.token, first.generation, {
      operation: 'commit', requestId: 'commit-one-replay', candidateRevision: 1,
    }))
    expect(duplicate).toMatchObject({ ok: false, code: 'conflict', actualRevision: 1 })
    expect(commits).toHaveLength(1)

    const secondComposition = await session.buildComposition('/runtime.ts')
    expect(secondComposition.source).toContain('config: {"shortcutPolicy":"mod-enter"}, revision: 1')
    expect(secondComposition.generation).not.toBe(first.generation)
    const second = bindingFromComposition(secondComposition.source)
    const conflict = await session.handleConfigRequest(binding(second.source, second.token, second.generation, {
      operation: 'stage', requestId: 'stale-cas', expectedRevision: 0,
      config: { shortcutPolicy: 'enter' },
    }))
    expect(conflict).toMatchObject({ ok: false, code: 'conflict', actualRevision: 1 })
    expect(commits).toHaveLength(1)
    await expect(session.handleConfigRequest(binding(first.source, first.token, first.generation, {
      operation: 'stage', requestId: 'stale-stage', expectedRevision: 1,
      config: { shortcutPolicy: 'enter' },
    }))).rejects.toThrow('token is invalid')
    expect(commits).toHaveLength(1)

    await session.reset()
    const resetComposition = await session.buildComposition('/runtime.ts')
    expect(resetComposition.source).toContain('config: {"shortcutPolicy":"enter"}, revision: 0')
    const reset = bindingFromComposition(resetComposition.source)
    await session.handleConfigRequest(binding(reset.source, reset.token, reset.generation, {
      operation: 'stage', requestId: 'stage-after-reset', expectedRevision: 0,
      config: { shortcutPolicy: 'mod-enter' },
    }))
    await session.handleConfigRequest(binding(reset.source, reset.token, reset.generation, {
      operation: 'commit', requestId: 'commit-after-reset', candidateRevision: 1,
    }))
    expect(commits.at(-1)).toEqual({ generation: reset.generation, pluginId: 'cli-proxy-api', revision: 1 })
    expect(commits).toHaveLength(2)

    await session.close()
    await expect(session.handleConfigRequest(binding(first.source, first.token, first.generation, {
      operation: 'commit', requestId: 'after-close', candidateRevision: 1,
    }))).rejects.toThrow('Playground has no active generation')
    expect(commits).toHaveLength(2)
  }, 30_000)
})
