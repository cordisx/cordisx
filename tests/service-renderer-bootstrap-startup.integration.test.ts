import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { type ServiceRendererPrivateGraph } from '../packages/cli/src/cli/service-renderer-projection.js'
import { decodeManagerRendererBundle } from '../packages/cli/src/cli/manager-renderer-bundle-codec.js'
import * as rendererBundle from '../packages/cli/src/launcher/bundle.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'
import { persistPermissionPolicies } from '../packages/cli/src/launcher/permission-rpc.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'

const secret = () => randomBytes(32).toString('hex')
const origin = 'http://127.0.0.1:43123'
function defer<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => resolve = done)
  return { promise, resolve }
}

it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'waits for managed startup before taking profile fences and cancels on disconnect',
  async () => {
    const f = await fixture({ managedBackend: true, protectProfileInputs: true })
    let entered = defer<void>()
    let release = defer<void>()
    let aborted = false
    const wait = vi.spyOn(f.managedUI, 'waitForInitialReadiness').mockImplementation(async signal => {
      const current = release
      entered.resolve()
      await new Promise<void>((resolve, reject) => {
        const cancel = () => {
          aborted = true
          reject(new Error('startup canceled'))
        }
        if (signal.aborted) return cancel()
        signal.addEventListener('abort', cancel, { once: true })
        void current.promise.then(() => {
          signal.removeEventListener('abort', cancel)
          resolve()
        })
      })
    })
    const policy = createPermissionPolicyRecord({
      profileId: f.profileId,
      identity: { source: 'https://example.test/plugin', id: 'fixture' },
      capability: 'models.read',
      scope: { providers: ['codex'] },
      policy: 'deny',
    })
    try {
      const first = f.call({ action: 'prepare' })
      await entered.promise
      await persistPermissionPolicies({ configPath: f.configPath }, [policy])
      release.resolve()
      expect(await first).toMatchObject({ status: 'ok' })
      expect(await f.sessions.close(f.invocation)).toBe(true)

      entered = defer<void>()
      release = defer<void>()
      const browserSessionId = secret()
      const handle = await f.sessions.open(f.gateway, browserSessionId)
      if (!handle) throw new Error('second renderer unavailable')
      const second = { gateway: f.gateway, browserSessionId, handle }
      const pending = f.sessions.call(second, 'manager-bootstrap', { action: 'prepare' })
      await entered.promise
      const closing = f.sessions.close(second)
      expect(await pending).toEqual({ status: 'unavailable' })
      expect(await closing).toBe(true)
      expect(aborted).toBe(true)
    } finally {
      release.resolve()
      wait.mockRestore()
      await f.close()
    }
  },
  30_000,
)

function project(graph: ServiceRendererPrivateGraph) {
  const baseUrl = `${origin}/api/renderer/graphs/${secret()}/`
  return {
    leaseId: secret(),
    pluginId: graph.pluginId,
    moduleGeneration: graph.moduleGeneration,
    baseUrl,
    entryUrl: baseUrl + graph.entryUrl.slice(graph.baseUrl.length),
    initialStyleUrls: graph.initialStyleUrls.map(url => baseUrl + url.slice(graph.baseUrl.length)),
  }
}

it('keeps an owner source out of the standalone bundle even when Host trust code contains it', async () => {
  const trustCode = await readFile(
    new URL('../packages/cli/src/renderer/marketplace-trust.ts', import.meta.url),
    'utf8',
  )
  const source = /const INTERNAL_SOURCE = '([^']+)'/u.exec(trustCode)?.[1]
  if (!source) throw new Error('test trust source unavailable')
  const f = await fixture({ managedUiVersion: 15, managedUiSource: source, protectProfileInputs: true })
  const build = vi.spyOn(rendererBundle, 'buildRendererBundle')
  try {
    const prepared = await f.call({ action: 'prepare' }) as any
    expect(prepared.status).toBe('ok')
    const graphs = prepared.value.privateGraphs.map(project)
    const completed = await f.call({ action: 'complete', managerOrigin: origin, graphs }) as any
    const built = await build.mock.results[0]?.value
    if (typeof built !== 'string') throw new Error('renderer bundle unavailable')
    expect(built.includes(source)).toBe(false)
    expect(completed.status).toBe('ok')
    const bytes = await decodeManagerRendererBundle(completed.value.bundle)
    try {
      expect(bytes.includes(source)).toBe(false)
      expect(bytes.includes(f.managed.capabilities()[0]!.token)).toBe(false)
    } finally {
      bytes.fill(0)
    }
  } finally {
    build.mockRestore()
    await f.close()
  }
}, 30_000)
