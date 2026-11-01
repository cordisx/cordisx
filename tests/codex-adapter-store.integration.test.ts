import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { c as createTar } from 'tar'
import { mkdir } from 'node:fs/promises'
import {
  adapterReceipts,
  changeAdapterPolicy,
  installAdapterPackage,
  liveAdapterLeases,
  pruneAdapterCache,
  readAdapterState,
} from '../packages/cli/src/launcher/codex-adapter/store.js'
import { openAdapterRuntime } from '../packages/cli/src/launcher/codex-adapter/runtime.js'
import { selectAdapterModules } from '../packages/cli/src/launcher/codex-adapter/selection.js'
import * as registry from '../packages/cli/src/launcher/codex-adapter/registry.js'
import { resources } from './fixtures/native-submission-structure.js'
import { ownedDirectory, writePrivateJson } from '../packages/cli/src/launcher/codex-adapter/files.js'

let archive: Buffer
let adapterVersion: string
let temp: string
let root: string
const input = () => ({ appVersion: 'future', buildNumber: 'future', resources: resources() })
beforeAll(async () => {
  adapterVersion = JSON.parse(await readFile(path.resolve('packages/codex-adapter/package.json'), 'utf8')).version
  const dir = await mkdtemp(path.join(os.tmpdir(), 'adapter-pack-'))
  try {
    const [packed] = JSON.parse(
      execFileSync('npm', [
        'pack',
        '--workspace=@cordisx/codex-adapter',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        dir,
      ], { encoding: 'utf8' }),
    )
    archive = await readFile(path.join(dir, packed.filename))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
beforeEach(async () => {
  temp = await mkdtemp(path.join(os.tmpdir(), 'cordisx-adapter-store-'))
  root = path.join(temp, 'codex-adapters')
  vi.spyOn(registry, 'resolveAdapterRelease').mockResolvedValue({
    version: adapterVersion,
    integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
    tarball: `https://registry.npmjs.org/@cordisx/codex-adapter/-/codex-adapter-${adapterVersion}.tgz`,
    publishedAt: '2026-11-01T00:00:00Z',
    sourceCommit: 'a'.repeat(40),
    workflowIdentity: 'synthetic-trust-fixture',
  })
  vi.spyOn(registry, 'registryFetch').mockResolvedValue(archive)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(temp, { recursive: true, force: true })
})

describe('packed adapter production intake and loading (registry trust is a separate policy fixture)', () => {
  it('loads the actual independently packed artifact and carries an admitted first-turn token through native dispatch', async () => {
    const stages: string[] = []
    const installed = await installAdapterPackage(root, 'beta', state => stages.push(state))
    expect(stages).toEqual(['downloaded', 'installed'])
    expect(await adapterReceipts(root)).toHaveLength(1)
    expect((await readAdapterState(root)).preferred).toEqual([])
    await changeAdapterPolicy(root, 'use', [installed.id])
    const runtime = await openAdapterRuntime(root)
    expect(runtime.candidates[0]!.identity).toBe(installed.id)
    const plan = selectAdapterModules(runtime.candidates, input())
    expect(plan.modules.find(m => m.id === 'submission')?.identity).toBe(installed.id)
    const lease = await runtime.selected(plan)
    try {
      expect((await liveAdapterLeases(root))[0]!.documents).toEqual({})
      const sandbox: Record<string, any> = {
        updateModel: async () => true,
        __cordisxNativeSubmitHook: async () => ({ allow: true, operationToken: 'independent-adapter-send-token' }),
        createNativeThread: async () => ({ conversationResponse: { model: 'accepted-model' } }),
        normalizeWire: (request: any) => ({ input: request.input, permission: 'retained' }),
      }
      for (const transform of plan.transforms) {
        const original = input().resources.find(r => r.url === transform.url)!
        runInNewContext(transform.transform(original.source).source, sandbox)
      }
      const context = await sandbox.submit({
        clearStopTurnConfirmation() {},
        submitTarget: { type: 'local' },
        isResponseInProgress: false,
        options: { input: 'hello' },
      })
      const draft = await sandbox.draft({ context, prompt: 'hello', serviceTier: null })
      const request = await sandbox.first({ input: 'hello', config: draft.configOverrides })
      const sent = await sandbox.dispatch({
        manager: {
          getConversation: () => ({}),
          requestClient: { getAppServerVersion: () => 'future' },
          sendRequest: async (_method: string, wire: any) => wire,
        },
        operation: { request },
      })
      expect(sent.config['cordisx.operation_token']).toBe('independent-adapter-send-token')
      expect(sent.permission).toBe('retained')
      await lease.lifecycle('test-document', 'active')
      expect((await liveAdapterLeases(root))[0]!.documents['test-document']).toBe('active')
      expect(await pruneAdapterCache(root, 0, 0)).toEqual([])
    } finally {
      await lease.close()
    }
    expect(await liveAdapterLeases(root)).toEqual([])
  })
  it('continues from the exact verified cache offline; a failed new download leaves the selection unchanged', async () => {
    const installed = await installAdapterPackage(root, 'beta')
    await changeAdapterPolicy(root, 'use', [installed.id])
    vi.mocked(registry.resolveAdapterRelease).mockRejectedValue(new Error('offline'))
    await expect(installAdapterPackage(root, 'beta')).rejects.toThrow('offline')
    const runtime = await openAdapterRuntime(root)
    expect(selectAdapterModules(runtime.candidates, input()).modules[0]!.identity).toBe(installed.id)
  })
  it('rejects a changed cached entry before execution and falls back to the bundled baseline', async () => {
    const installed = await installAdapterPackage(root, 'beta')
    await changeAdapterPolicy(root, 'use', [installed.id])
    await writeFile(
      path.join(root, 'packages', installed.id, 'payload/dist/adapter.mjs'),
      'throw Error("must never execute")',
    )
    const runtime = await openAdapterRuntime(root)
    expect(runtime.rejected[0]?.reason).toContain('content changed')
    expect(selectAdapterModules(runtime.candidates, input()).modules[0]!.identity).toMatch(/^builtin:/u)
  })
  it('honors local withdrawal and does not silently reselect a revoked cached version', async () => {
    const installed = await installAdapterPackage(root, 'beta')
    await changeAdapterPolicy(root, 'use', [installed.id])
    await changeAdapterPolicy(root, 'revoke', [installed.id])
    await expect(changeAdapterPolicy(root, 'use', [installed.id])).rejects.toThrow('revoked')
    expect((await openAdapterRuntime(root)).candidates.map(c => c.identity)).not.toContain(installed.id)
    await expect(installAdapterPackage(root, 'beta')).rejects.toThrow('revoked')
  })
  it('protects pins, active leases and rollback packages; removes other packages by disk budget, not count', async () => {
    const installed = await installAdapterPackage(root, 'beta')
    await changeAdapterPolicy(root, 'pin', [installed.id])
    expect(await pruneAdapterCache(root, 0, 0)).toEqual([])
    await changeAdapterPolicy(root, 'unpin', [installed.id])
    await changeAdapterPolicy(root, 'use', [installed.id])
    await changeAdapterPolicy(root, 'use', [])
    expect((await openAdapterRuntime(root)).candidates[0]!.identity).toMatch(/^builtin:/u)
    expect(await pruneAdapterCache(root, 0, 0)).toEqual([])
    await changeAdapterPolicy(root, 'use', [])
    const file = path.join(root, 'leases', 'aaaaaaaa-1111.json')
    await writePrivateJson(file, { pid: process.pid, packages: [installed.id], modules: [], documents: {} })
    expect(await pruneAdapterCache(root, 0, 0)).toEqual([])
    await rm(file)
    expect(await pruneAdapterCache(root, 0, 0)).toEqual([installed.id])
  })
  it('rejects a corrupt distribution archive before installing it', async () => {
    vi.mocked(registry.registryFetch).mockResolvedValue(Buffer.from('tampered'))
    await expect(installAdapterPackage(root, 'beta')).rejects.toThrow('integrity mismatch')
    expect(await adapterReceipts(root)).toEqual([])
  })
  it.each([
    { scripts: { postinstall: 'must-never-run' } },
    { dependencies: { unexpected: '1.0.0' } },
    { bin: { executable: 'dist/adapter.mjs' } },
    { name: '@other/package' },
  ])('rejects disallowed package metadata before loading or executing it: %j', async extra => {
    const source = path.join(temp, 'malformed')
    await mkdir(path.join(source, 'package'), { recursive: true })
    await writeFile(
      path.join(source, 'package/package.json'),
      JSON.stringify({ name: registry.ADAPTER_PACKAGE, version: adapterVersion, ...extra }),
    )
    const file = path.join(temp, 'malformed.tgz')
    await createTar({ file, cwd: source, gzip: true }, ['package'])
    const data = await readFile(file)
    vi.mocked(registry.registryFetch).mockResolvedValue(data)
    vi.mocked(registry.resolveAdapterRelease).mockResolvedValue({
      ...(await registry.resolveAdapterRelease('beta')),
      integrity: `sha512-${createHash('sha512').update(data).digest('base64')}`,
    })
    await expect(installAdapterPackage(root, 'beta')).rejects.toThrow('policy')
    expect(await adapterReceipts(root)).toEqual([])
  })
  it('recovers an interrupted archive download and prunes only abandoned intake artifacts', async () => {
    const id = createHash('sha256').update(archive).digest('hex')
    const downloads = path.join(root, 'downloads')
    await ownedDirectory(downloads)
    await writeFile(path.join(downloads, `${id}.tgz`), 'interrupted', { mode: 0o600 })
    const installed = await installAdapterPackage(root, 'beta')
    expect(installed.id).toBe(id)
    const abandoned = path.join(downloads, 'staging', `${'a'.repeat(36)}.${'b'.repeat(36)}`)
    await mkdir(abandoned, { recursive: true, mode: 0o700 })
    await writeFile(path.join(abandoned, 'partial'), 'unused')
    await writeFile(path.join(downloads, 'review-note.txt'), 'preserve')
    await pruneAdapterCache(root, 0, 0)
    await expect(readFile(path.join(abandoned, 'partial'))).rejects.toHaveProperty('code', 'ENOENT')
    expect(await readFile(path.join(downloads, 'review-note.txt'), 'utf8')).toBe('preserve')
  })
})
