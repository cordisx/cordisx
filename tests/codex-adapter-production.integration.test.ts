import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { PluginPackageSourceSnapshotter } from '../packages/cli/src/launcher/packages/integrity.js'
import { ownedDirectory, writePrivateJson } from '../packages/cli/src/launcher/codex-adapter/files.js'
import { resources } from './fixtures/native-submission-structure.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
it('uses an independent npm artifact through compiled production analysis, partitions its cache by artifact and fences drift', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'adapter-production-'))
  roots.push(root)
  const store = path.join(root, 'store')
  const [{ filename }] = JSON.parse(
    execFileSync('npm', [
      'pack',
      '--workspace=@cordisx/codex-adapter',
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      root,
    ], { encoding: 'utf8' }),
  )
  const bytes = await readFile(path.join(root, filename))
  const id = createHash('sha256').update(bytes).digest('hex')
  // Local synthetic trust receipt: actual registry signature/provenance enforcement is tested separately.
  const snapshot = await new PluginPackageSourceSnapshotter(path.join(root, 'staging')).snapshot({
    kind: 'local-package',
    path: path.join(root, filename),
  })
  await writePrivateJson(path.join(snapshot.stagingDirectory, 'receipt.json'), {
    schema: 1,
    id,
    version: '0.1.0-beta.1',
    treeHash: snapshot.digest,
    entryHash: createHash('sha256').update(await readFile(path.join(snapshot.payloadDirectory, 'dist/adapter.mjs')))
      .digest('hex'),
    trust: 'npm-sigstore-v1',
    installedAt: new Date().toISOString(),
    bytes: bytes.length,
  })
  await ownedDirectory(path.join(store, 'packages'))
  await rename(snapshot.stagingDirectory, path.join(store, 'packages', id))
  const modules = path.join(root, 'node_modules/@cordisx')
  await mkdir(modules, { recursive: true })
  await symlink(path.join(store, 'packages', id, 'payload'), path.join(modules, 'codex-adapter'))
  const standalone = execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    'import {bundle} from "@cordisx/codex-adapter"; import {parseNativeSource} from "@cordisx/codex-adapter/native-source-structure"; console.log(JSON.stringify({version:bundle.version,type:parseNativeSource("export const value=1").type}))',
  ], { cwd: root, encoding: 'utf8' })
  expect(JSON.parse(standalone)).toEqual({ version: '0.1.0-beta.1', type: 'Program' })

  await writePrivateJson(path.join(store, 'state.json'), {
    schema: 1,
    preferred: [id],
    rollback: [],
    pinned: [],
    revoked: [],
    lastUsed: {},
  })
  const { openAdapterRuntime } = await import('../packages/cli/dist/src/launcher/codex-adapter/runtime.js')
  const { analyzeNativeAdapterResources } = await import('../packages/cli/dist/src/launcher/native-adapter-analysis.js')
  const { changeAdapterPolicy, liveAdapterLeases } = await import(
    '../packages/cli/dist/src/launcher/codex-adapter/store.js'
  )
  const scripts = resources()
  const cache = path.join(root, 'native-cache')
  const identity = { appVersion: '2099.unknown', buildNumber: 'unbounded' }
  const external = await openAdapterRuntime(store)
  expect(external.candidates[0]!.identity).toBe(id)
  const first = await analyzeNativeAdapterResources(scripts, identity, cache, external)
  expect((await liveAdapterLeases(store))[0]!.modules.find((m: any) => m.id === 'submission')?.identity).toBe(id)
  await first.adapterLifecycle.close()
  const cached = await analyzeNativeAdapterResources(scripts, identity, cache, await openAdapterRuntime(store))
  expect(cached.transforms.map((t: any) => t.sha256)).toEqual(first.transforms.map((t: any) => t.sha256))
  expect(() => cached.transforms[0]!.transform('changed')).toThrow('changed')
  await cached.adapterLifecycle.close()
  await changeAdapterPolicy(store, 'revoke', [id])
  const fallback = await analyzeNativeAdapterResources(scripts, identity, cache, await openAdapterRuntime(store))
  expect((await liveAdapterLeases(store))[0]!.modules[0]!.identity).toMatch(/^builtin:/u)
  expect(await readdir(cache)).toHaveLength(2)
  await fallback.adapterLifecycle.close()
  const compiled = await readFile(
    new URL('../packages/cli/dist/src/launcher/codex-adapter/runtime.js', import.meta.url),
    'utf8',
  )
  expect(compiled).not.toContain("from '@cordisx/codex-adapter'")
  const shim = await readFile(
    new URL('../packages/cli/dist/src/launcher/native-source-structure.js', import.meta.url),
    'utf8',
  )
  expect(shim).toContain('codex-adapter/adapter.mjs')
})
