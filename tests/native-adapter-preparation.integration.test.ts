import { afterEach, expect, it, vi } from 'vitest'
import { createPackage } from '@electron/asar'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startNativeAdapterPreparation } from '../packages/cli/src/launcher/native-adapter-preparation.js'
import { openFrozenAdapterRuntime } from '../packages/cli/src/launcher/codex-adapter/runtime.js'
import {
  changeAdapterPolicy,
  liveAdapterLeases,
  pruneAdapterCache,
} from '../packages/cli/src/launcher/codex-adapter/store.js'
import { writePrivateJson } from '../packages/cli/src/launcher/codex-adapter/files.js'
import { hashPackageTree } from '../packages/cli/src/launcher/packages/integrity.js'
import { resources } from './fixtures/native-submission-structure.js'

const adapterVersion = JSON.parse(
  await readFile(new URL('../packages/codex-adapter/package.json', import.meta.url), 'utf8'),
).version as string

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-prepare-'))
  roots.push(root)
  const contents = path.join(root, 'Contents')
  const assets = path.join(root, 'source/webview/assets')
  await mkdir(assets, { recursive: true })
  await mkdir(path.join(contents, 'Resources'), { recursive: true })
  await writeFile(
    path.join(contents, 'Info.plist'),
    '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>future</string><key>CFBundleVersion</key><string>unknown</string></dict></plist>',
  )
  for (const resource of resources()) await writeFile(path.join(assets, path.basename(resource.url)), resource.source)
  await createPackage(path.join(root, 'source'), path.join(contents, 'Resources/app.asar'))
  return { root, contents, cache: path.join(root, 'cache'), store: path.join(root, 'store') }
}
async function candidate(f: Awaited<ReturnType<typeof fixture>>, source: string, key: string) {
  const id = createHash('sha256').update(key).digest('hex')
  const payload = path.join(f.store, 'packages', id, 'payload')
  await mkdir(path.join(payload, 'dist'), { recursive: true, mode: 0o700 })
  await writeFile(path.join(payload, 'dist/adapter.mjs'), source)
  await writePrivateJson(path.join(f.store, 'packages', id, 'receipt.json'), {
    schema: 1,
    id,
    version: adapterVersion,
    treeHash: await hashPackageTree(payload),
    entryHash: createHash('sha256').update(source).digest('hex'),
    trust: 'npm-sigstore-v1',
    bytes: source.length,
  })
  return id
}
const state = (preferred: string[], rollback: string[] = []) => ({
  schema: 1,
  preferred,
  rollback,
  pinned: [],
  revoked: [],
  lastUsed: {},
})

it.skipIf(process.platform !== 'darwin')(
  'runs a single source Worker, validates warm cache and fences original byte drift',
  async () => {
    const f = await fixture()
    const first = startNativeAdapterPreparation(f.contents, f.cache, f.store)
    const output = await first.ready
    expect(output.metrics.cacheHit).toBe(false)
    expect(output.metrics.resourceCount).toBe(2)
    expect(output.metrics.resultBytes).toBeGreaterThan(0)
    expect(output.metrics.resourceBytes).toBe(resources().reduce((n, r) => n + Buffer.byteLength(r.source), 0))
    expect(() => output.transforms[0]!.transform('changed')).toThrow('changed')
    await first.close()
    expect(await liveAdapterLeases(f.store)).toEqual([])
    const second = startNativeAdapterPreparation(f.contents, f.cache, f.store)
    expect((await second.ready).metrics.cacheHit).toBe(true)
    await second.close()
    const [file] = await readdir(f.cache)
    const corrupted = JSON.parse(await readFile(path.join(f.cache, file!), 'utf8'))
    corrupted.transforms[0].source += ';corrupt'
    await writeFile(path.join(f.cache, file!), JSON.stringify(corrupted), { mode: 0o600 })
    const third = startNativeAdapterPreparation(f.contents, f.cache, f.store)
    expect((await third.ready).metrics.cacheHit).toBe(false)
    await third.close()
    const corruptedModules = JSON.parse(await readFile(path.join(f.cache, file!), 'utf8'))
    corruptedModules.modules[0].identity = 'not-a-frozen-candidate'
    await writeFile(path.join(f.cache, file!), JSON.stringify(corruptedModules), { mode: 0o600 })
    const repaired = startNativeAdapterPreparation(f.contents, f.cache, f.store)
    expect((await repaired.ready).metrics.cacheHit).toBe(false)
    await Promise.all([repaired.close(), repaired.close()])
    await writeFile(
      path.join(f.root, 'source/webview/assets', path.basename(resources()[0]!.url)),
      resources()[0]!.source + '\n// new bytes',
    )
    await createPackage(path.join(f.root, 'source'), path.join(f.contents, 'Resources/app.asar'))
    const drift = startNativeAdapterPreparation(f.contents, f.cache, f.store)
    expect((await drift.ready).metrics.cacheHit).toBe(false)
    await drift.close()
    expect(await readdir(f.cache)).toHaveLength(2)
  },
)

it.skipIf(process.platform !== 'darwin')(
  'skips an incompatible preferred candidate and continues through a good rollback in the Worker',
  async () => {
    const f = await fixture()
    const bad = await candidate(
      f,
      `export const bundle={version:${JSON.stringify(adapterVersion)},apiVersion:99}`,
      'bad',
    )
    // Real owned packed entry: this candidate must beat builtin fallback.
    const good = await candidate(f, await readFile('packages/codex-adapter/dist/adapter.mjs', 'utf8'), 'good')
    await writePrivateJson(path.join(f.store, 'state.json'), state([bad], [good]))
    const preparation = startNativeAdapterPreparation(f.contents, f.cache, f.store)
    await preparation.ready
    const [lease] = await liveAdapterLeases(f.store)
    expect(lease!.modules.find(module => module.id === 'submission')?.identity).toBe(good)
    const [file] = await readdir(f.cache)
    const cached = JSON.parse(await readFile(path.join(f.cache, file!), 'utf8'))
    expect(cached.rejected).toContainEqual(
      expect.objectContaining({ identity: bad, reason: expect.stringContaining('incompatible') }),
    )
    await preparation.close()
  },
)

it('protects every frozen candidate from prune and rejects revocation before selected lease creation', async () => {
  const f = await fixture()
  const id = await candidate(f, await readFile('packages/codex-adapter/dist/adapter.mjs', 'utf8'), 'protected')
  await writePrivateJson(path.join(f.store, 'state.json'), state([id]))
  const runtime = await openFrozenAdapterRuntime(f.store)
  await writePrivateJson(path.join(f.store, 'state.json'), state([]))
  expect(await pruneAdapterCache(f.store, 0, 0)).toEqual([])
  await changeAdapterPolicy(f.store, 'revoke', [id])
  await expect(
    runtime.selected({
      transforms: [],
      modules: [{ id: 'submission', identity: id, version: adapterVersion }],
      rejected: [],
    }),
  ).rejects.toThrow('revoked')
  await runtime.close()
  expect(await liveAdapterLeases(f.store)).toEqual([])
  expect(await pruneAdapterCache(f.store, 0, 0)).toEqual([id])
})

it.skipIf(process.platform !== 'darwin')(
  'terminates a busy Worker, drains late work and never publishes a selected lease or cache',
  async () => {
    const f = await fixture()
    const marker = path.join(f.root, 'analyzing')
    const id = await candidate(
      f,
      `import {writeFileSync} from 'node:fs';export const bundle={version:'0.1.0-beta.2',apiVersion:1,relayContract:1,resourceHints:[],modules:[{id:'submission',requires:[],composes:[],analyze(){writeFileSync(${
        JSON.stringify(marker)
      },'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);throw Error('late result')}}]}`,
      'busy',
    )
    await writePrivateJson(path.join(f.store, 'state.json'), state([id]))
    const controller = new AbortController()
    const preparation = startNativeAdapterPreparation(f.contents, f.cache, f.store, { signal: controller.signal })
    await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('ready'), { timeout: 5000 })
    controller.abort()
    await expect(preparation.ready).rejects.toMatchObject({ name: 'NativeAdapterPreparationError', code: 'cancelled' })
    await Promise.all([preparation.close(), preparation.close()])
    expect(await liveAdapterLeases(f.store)).toEqual([])
    await expect(readdir(f.cache)).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it('supports cancellation before startup without any store or lease creation', async () => {
  const f = await fixture()
  const controller = new AbortController()
  controller.abort()
  const preparation = startNativeAdapterPreparation(f.contents, f.cache, f.store, { signal: controller.signal })
  await expect(preparation.ready).rejects.toMatchObject({ code: 'cancelled' })
  await preparation.close()
  await expect(readdir(f.store)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.skipIf(process.platform !== 'darwin')(
  'loads the compiled production Worker in plain Node without tsx or workspace adapter resolution',
  async () => {
    const f = await fixture()
    const entry = pathToFileURL(path.resolve('packages/cli/dist/src/launcher/native-adapter-preparation.js')).href
    const code = `import {startNativeAdapterPreparation} from ${JSON.stringify(entry)};
    const preparation=startNativeAdapterPreparation(...JSON.parse(process.argv[1]));
    const result=await preparation.ready;await preparation.close();
    console.log(JSON.stringify({metrics:result.metrics,transforms:result.transforms.length}));`
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--input-type=module',
      '-e',
      code,
      JSON.stringify([f.contents, f.cache, f.store]),
    ], { cwd: f.root })
    const measured = JSON.parse(stdout)
    expect(measured.transforms).toBe(2)
    expect(measured.metrics.cacheHit).toBe(false)
    expect(measured.metrics.resultBytes).toBeGreaterThan(0)
    expect(await liveAdapterLeases(f.store)).toEqual([])
  },
)

it.skipIf(process.platform !== 'darwin')(
  'rejects stale Worker generations before any cache publication or selected lease',
  async () => {
    const f = await fixture()
    const id = await candidate(
      f,
      `import {parentPort} from 'node:worker_threads';export const bundle={version:'0.1.0-beta.2',apiVersion:1,relayContract:1,resourceHints:[],modules:[{id:'submission',requires:[],composes:[],analyze(){parentPort.postMessage({result:{generation:'stale',adapterIdentity:'stale'}});process.exit(0)}}]}`,
      'stale',
    )
    await writePrivateJson(path.join(f.store, 'state.json'), state([id]))
    const preparation = startNativeAdapterPreparation(f.contents, f.cache, f.store)
    await expect(preparation.ready).rejects.toMatchObject({ code: 'identity' })
    await preparation.close()
    expect(await liveAdapterLeases(f.store)).toEqual([])
    await expect(readdir(f.cache)).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it.skipIf(process.platform !== 'darwin')(
  'queues overlapping preparations behind one Worker and cancels each waiter independently',
  async () => {
    const fixtures = await Promise.all([fixture(), fixture()])
    const markers = fixtures.map(f => path.join(f.root, 'worker-started'))
    for (const [index, f] of fixtures.entries()) {
      const id = await candidate(
        f,
        `import {writeFileSync} from 'node:fs';export const bundle={version:'0.1.0-beta.2',apiVersion:1,relayContract:1,resourceHints:[],modules:[{id:'submission',requires:[],composes:[],analyze(){writeFileSync(${
          JSON.stringify(markers[index])
        },'ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,30000);throw Error('late')}}]}`,
        `queued-${index}`,
      )
      await writePrivateJson(path.join(f.store, 'state.json'), state([id]))
    }
    const controllers = [new AbortController(), new AbortController()]
    const firstFixture = fixtures[0]!
    const first = startNativeAdapterPreparation(firstFixture.contents, firstFixture.cache, firstFixture.store, {
      signal: controllers[0]!.signal,
    })
    await vi.waitFor(async () => expect(await readFile(markers[0]!, 'utf8')).toBe('ready'), { timeout: 5000 })
    const secondFixture = fixtures[1]!
    const second = startNativeAdapterPreparation(secondFixture.contents, secondFixture.cache, secondFixture.store, {
      signal: controllers[1]!.signal,
    })
    await vi.waitFor(async () => expect(await liveAdapterLeases(secondFixture.store)).toHaveLength(1))
    // Allow enough time for a wrongly parallel Worker to enter its analyze function.
    await new Promise(resolve => setTimeout(resolve, 150))
    await expect(readFile(markers[1]!, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    controllers[1]!.abort()
    await expect(second.ready).rejects.toMatchObject({ code: 'cancelled' })
    await second.close()
    expect(await liveAdapterLeases(firstFixture.store)).toHaveLength(1)
    controllers[0]!.abort()
    await first.close()
    expect(await liveAdapterLeases(firstFixture.store)).toEqual([])
    expect(await liveAdapterLeases(secondFixture.store)).toEqual([])
  },
)
