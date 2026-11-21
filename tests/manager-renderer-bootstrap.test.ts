import { expect, it, vi } from 'vitest'
import { createManagerRendererBootstrap } from '../packages/cli/src/cli/manager-renderer-bootstrap.js'
import { encodeManagerRendererBundle } from '../packages/cli/src/cli/manager-renderer-bundle-codec.js'

const origin = 'http://127.0.0.1:12345'
const privateBase = `http://127.0.0.1:23456/cordisx-plugin-artifacts/${'a'.repeat(64)}/${'b'.repeat(64)}/`
const publicBase = `${origin}/api/renderer/graphs/${'c'.repeat(64)}/`
const privateGraph = {
  leaseId: 'b'.repeat(64),
  pluginId: 'plugin',
  moduleGeneration: 'generation',
  baseUrl: privateBase,
  entryUrl: `${privateBase}main.js`,
  initialStyleUrls: [],
}
const publicGraph = {
  leaseId: 'd'.repeat(64),
  pluginId: 'plugin',
  moduleGeneration: 'generation',
  baseUrl: publicBase,
  entryUrl: `${publicBase}main.js`,
  initialStyleUrls: [],
}
const invocation = {
  gateway: { pid: 42, processStartedAt: 'fixture', instanceToken: 'e'.repeat(64) },
  browserSessionId: 'f'.repeat(64),
  handle: { rendererId: '1'.repeat(64), ownerGeneration: 'generation', grant: '2'.repeat(64) },
}

it('builds a bundle using only owner-issued graphs projected for this session', async () => {
  const envelope = await encodeManagerRendererBundle(Buffer.from('export const fixture = true'))
  const request = vi.fn(async operation => {
    expect(operation.channel).toBe('manager-bootstrap')
    expect(operation.handle).toEqual(invocation.handle)
    if (operation.payload.action === 'status') return { status: 'ok', value: { status: 'ok', current: true } }
    if (operation.payload.action === 'prepare') {
      return { status: 'ok', value: { status: 'ok', snapshot: {}, privateGraphs: [privateGraph] } }
    }
    expect(operation.payload).toEqual({ action: 'complete', managerOrigin: origin, graphs: [publicGraph] })
    return { status: 'ok', value: { status: 'ok', bundle: envelope, initialGraphs: [publicGraph] } }
  })
  const projection = { projectInitial: vi.fn(() => [publicGraph]), close: vi.fn() }
  const bootstrap = createManagerRendererBootstrap({
    owner: { request },
    invocation,
    managerOrigin: origin,
    projection,
    isCurrent: () => true,
    signal: new AbortController().signal,
    forbiddenSecrets: ['x'.repeat(64)],
  })
  expect(await bootstrap.isSessionCurrent()).toBe(true)
  const result = await bootstrap.prepare()
  expect(result.initialGraphs).toEqual([publicGraph])
  expect(result.bundle.toString()).toBe('export const fixture = true')
  expect(projection.projectInitial).toHaveBeenCalledWith([privateGraph])
  expect(projection.close).not.toHaveBeenCalled()
  await expect(bootstrap.prepare()).rejects.toThrow('MANAGER_BOOTSTRAP_UNAVAILABLE')
})

it('retires projected resources if a bundle exposes a private graph URL', async () => {
  const envelope = await encodeManagerRendererBundle(Buffer.from(`export default ${JSON.stringify(privateBase)}`))
  const request = vi.fn(async operation =>
    operation.payload.action === 'prepare'
      ? { status: 'ok', value: { status: 'ok', snapshot: {}, privateGraphs: [privateGraph] } }
      : { status: 'ok', value: { status: 'ok', bundle: envelope, initialGraphs: [publicGraph] } }
  )
  const projection = { projectInitial: () => [publicGraph], close: vi.fn() }
  const bootstrap = createManagerRendererBootstrap({
    owner: { request },
    invocation,
    managerOrigin: origin,
    projection,
    isCurrent: () => true,
    signal: new AbortController().signal,
    forbiddenSecrets: ['x'.repeat(64)],
  })
  await expect(bootstrap.prepare()).rejects.toThrow('MANAGER_BOOTSTRAP_UNAVAILABLE')
  expect(projection.close).toHaveBeenCalledOnce()
})

it('rejects a changed owner or a graph the owner did not confirm', async () => {
  const envelope = await encodeManagerRendererBundle(Buffer.from('export {}'))
  let current = true
  const request = vi.fn(async operation => {
    if (operation.payload.action === 'prepare') {
      return { status: 'ok', value: { status: 'ok', snapshot: {}, privateGraphs: [privateGraph] } }
    }
    current = false
    return { status: 'ok', value: { status: 'ok', bundle: envelope, initialGraphs: [] } }
  })
  const projection = { projectInitial: () => [publicGraph], close: vi.fn() }
  const bootstrap = createManagerRendererBootstrap({
    owner: { request },
    invocation,
    managerOrigin: origin,
    projection,
    isCurrent: () => current,
    signal: new AbortController().signal,
    forbiddenSecrets: ['x'.repeat(64)],
  })
  await expect(bootstrap.prepare()).rejects.toThrow('MANAGER_BOOTSTRAP_UNAVAILABLE')
  expect(projection.close).toHaveBeenCalledOnce()
})
