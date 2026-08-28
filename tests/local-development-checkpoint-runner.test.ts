import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const helperPath = path.resolve(import.meta.dirname, '../packages/cli/scripts/checkpoint-local-dev-lib.mjs')
const helper = await import(pathToFileURL(helperPath).href)

describe('local development checkpoint runner', () => {
  it('wires deterministic and opt-in real-App gates without adding the desktop gate to check', async () => {
    const root = path.resolve(import.meta.dirname, '..')
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    expect(manifest.scripts['checkpoint:local-dev']).toContain('local-development-generation.test.ts')
    expect(manifest.scripts['checkpoint:local-dev']).toContain('local-development-checkpoint-runner.test.ts')
    expect(manifest.scripts['checkpoint:local-dev:app']).toBe('node packages/cli/scripts/checkpoint-local-dev.mjs')
    expect(manifest.scripts['precheckpoint:local-dev']).toBe('npm run build --workspace=cordisx')
    expect(manifest.scripts['precheckpoint:local-dev:app']).toBe('npm run build --workspace=cordisx')
    expect(manifest.scripts.check).not.toContain('checkpoint:local-dev:app')
  })

  it('requires explicit absolute production inputs and separates packed CLI mode', () => {
    expect(() => helper.parseCheckpointArgs([])).toThrow('--executable is required')
    expect(() => helper.parseCheckpointArgs(['--executable', './Codex'])).toThrow('--executable must be absolute')
    expect(() => helper.parseCheckpointArgs([
      '--executable', '/Applications/Codex.app/Contents/MacOS/Codex', '--cli', '/tmp/cli.js', '--cli-bin', '/tmp/cordisx',
    ])).toThrow('mutually exclusive')
    expect(helper.parseCheckpointArgs([
      '--executable', '/Applications/Codex.app/Contents/MacOS/Codex', '--cli-bin', '/tmp/cordisx', '--timeout-ms', '45000',
    ])).toMatchObject({ executable: '/Applications/Codex.app/Contents/MacOS/Codex', 'cli-bin': '/tmp/cordisx', timeoutMs: 45_000 })
  })

  it('creates private evidence roots and finds exact state artifacts', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-checkpoint-helper-'))
    try {
      const nested = path.join(root, 'state', 'publisher-grants')
      await helper.ensurePrivateDirectory(nested)
      await writeFile(path.join(nested, 'direct-device-bound.v1.json'), '{}\n')
      await mkdir(path.join(root, 'projects', 'demo', 'cache', 'codex-app-profile'), { recursive: true })
      expect(await helper.mode(nested)).toBe(0o700)
      expect(await helper.findNamed(root, 'direct-device-bound.v1.json')).toEqual([path.join(nested, 'direct-device-bound.v1.json')])
      expect(await helper.findNamed(root, 'codex-app-profile')).toEqual([path.join(root, 'projects', 'demo', 'cache', 'codex-app-profile')])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('projects only last-good invariants for failure comparison', () => {
    const state = { ready: true, plugin: { id: 'demo' }, activation: { digest: 'sha256:1' }, runtimeGeneration: 'g', lifecycleRevision: 1, manager: { state: 'failed' } }
    expect(helper.invariantProjection(state)).toEqual({
      ready: true, plugin: { id: 'demo' }, activation: { digest: 'sha256:1' }, runtimeGeneration: 'g', lifecycleRevision: 1,
    })
  })

  it('compares complete renderer generations and snapshots pre-existing runtime paths by content', async () => {
    const generation = {
      plugin: { package: { digest: 'sha256:1', moduleGeneration: 'module-1' } },
      activation: { digest: 'sha256:1', moduleGeneration: 'module-1' },
      runtimeGeneration: 'runtime-1', lifecycleRevision: 2, activationLastGoodRevision: 2,
      configRevision: 0, configLastGoodRevision: 0,
    }
    expect(helper.rendererGenerationProjection(generation)).toEqual({
      digest: 'sha256:1', moduleGeneration: 'module-1', activationDigest: 'sha256:1',
      activationModuleGeneration: 'module-1', runtimeGeneration: 'runtime-1', lifecycleRevision: 2,
      activationLastGoodRevision: 2, configRevision: 0, configLastGoodRevision: 0,
    })

    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-checkpoint-snapshot-'))
    try {
      await mkdir(path.join(root, 'state'), { recursive: true })
      await writeFile(path.join(root, 'state', 'existing.json'), '{"value":1}\n')
      const before = await helper.snapshotRuntimePaths(root, ['state', 'projects'])
      const same = await helper.snapshotRuntimePaths(root, ['state', 'projects'])
      expect(same.sha256).toBe(before.sha256)
      expect(before.records).toContainEqual(expect.objectContaining({ path: path.join('state', 'existing.json'), kind: 'file' }))
      await writeFile(path.join(root, 'state', 'existing.json'), '{"value":2}\n')
      const changed = await helper.snapshotRuntimePaths(root, ['state', 'projects'])
      expect(changed.sha256).not.toBe(before.sha256)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
