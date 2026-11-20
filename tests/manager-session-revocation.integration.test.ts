import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { startManagerWeb } from '../packages/cli/src/cli/manager-web.js'
import { MODEL_SERVICE_SAFE_WRITE_CONTRACT } from '../packages/cli/src/model-service-contracts.js'
import { requestPluginManagementRpc } from '../packages/cli/src/launcher/management-rpc.js'

async function exchange(web: Awaited<ReturnType<typeof startManagerWeb>>, link: string): Promise<string> {
  const url = new URL(link)
  const result = await fetch(`${url.origin}/api/session`, {
    method: 'POST',
    headers: { origin: url.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ token: url.hash.slice(1) }),
  })
  expect(result.status).toBe(200)
  return (await result.json() as { token: string }).token
}

async function evict(web: Awaited<ReturnType<typeof startManagerWeb>>) {
  for (let index = 0; index < 16; index++) await exchange(web, web.issueUrl())
}

function partialRequest(origin: string, route: string, token: string, body: unknown) {
  const content = JSON.stringify(body)
  let finish!: () => void
  const response = new Promise<{ status: number; data: string }>((resolve, reject) => {
    const request = httpRequest(`${origin}${route}`, {
      method: 'POST',
      headers: {
        origin,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(content),
      },
    }, result => {
      let data = ''
      result.setEncoding('utf8')
      result.on('data', chunk => {
        data += chunk
      })
      result.on('end', () => resolve({ status: result.statusCode!, data }))
    })
    request.on('error', reject)
    request.write(content.slice(0, 8))
    finish = () => request.end(content.slice(8))
  })
  return { response, finish: () => finish() }
}

it('rejects incomplete Channel, model and management requests when their sessions are evicted', async () => {
  const operations: Array<Record<string, unknown>> = []
  const web = await startManagerWeb(
    {
      appId: 'codex',
      profileId: 'fixture',
      generation: 'g',
      isCurrent: async () => true,
      request: async (operation: Record<string, unknown>) => {
        operations.push(operation)
        return { status: 'applied' }
      },
    } as unknown as Parameters<typeof startManagerWeb>[0],
  )
  try {
    const origin = new URL(web.url).origin
    const tokens = [
      await exchange(web, web.url),
      await exchange(web, web.issueUrl()),
      await exchange(web, web.issueUrl()),
    ]
    const requests = [
      partialRequest(origin, '/api/channel-credentials', tokens[0]!, {
        action: 'capture',
        purpose: 'create',
        expectedRevision: 0,
        serviceGeneration: 'service-1',
        account: { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant' },
        secret: 'synthetic-secret',
      }),
      partialRequest(origin, '/api/model-services', tokens[1]!, { expectedRevision: 'r', services: [] }),
      partialRequest(origin, '/api/management', tokens[2]!, {
        kind: 'execute',
        expectedRevision: 0,
        request: { kind: 'plugin-enable', pluginId: 'fixture' },
      }),
    ]
    await new Promise(resolve => setTimeout(resolve, 30))
    await evict(web)
    requests.forEach(request => request.finish())
    const results = await Promise.all(requests.map(request => request.response))
    expect(results.map(result => result.status)).toEqual([401, 401, 401])
    expect(operations).toEqual([])
  } finally {
    await web.close()
  }
}, 30_000)

it('does not save if session eviction occurs while its safety handshake is pending', async () => {
  let release!: () => void
  const waiting = new Promise<void>(resolve => {
    release = resolve
  })
  const request = vi.fn(async (operation: { operation?: string }) => {
    if (operation.operation === 'model-services:read') {
      await waiting
      return { status: 'ok', managerSafeWrite: MODEL_SERVICE_SAFE_WRITE_CONTRACT }
    }
    return { status: 'applied' }
  })
  const web = await startManagerWeb(
    {
      appId: 'codex',
      profileId: 'fixture',
      generation: 'g',
      isCurrent: async () => true,
      request,
    } as unknown as Parameters<typeof startManagerWeb>[0],
  )
  try {
    const url = new URL(web.url)
    const token = await exchange(web, web.url)
    const response = fetch(`${url.origin}/api/model-services`, {
      method: 'POST',
      headers: { origin: url.origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 'r', services: [] }),
    })
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce())
    await evict(web)
    release()
    expect((await response).status).toBe(401)
    expect(request.mock.calls.map(call => call[0].operation)).toEqual(['model-services:read'])
  } finally {
    release()
    await web.close()
  }
}, 30_000)

it('reports unknown when a dispatched write may finish after its session is evicted', async () => {
  let release!: () => void
  const waiting = new Promise<void>(resolve => {
    release = resolve
  })
  const request = vi.fn(async (operation: { operation?: string }) => {
    if (operation.operation === 'model-services:read') {
      return { status: 'ok', managerSafeWrite: MODEL_SERVICE_SAFE_WRITE_CONTRACT }
    }
    await waiting
    return { status: 'applied' }
  })
  const web = await startManagerWeb(
    {
      appId: 'codex',
      profileId: 'fixture',
      generation: 'g',
      isCurrent: async () => true,
      request,
    } as unknown as Parameters<typeof startManagerWeb>[0],
  )
  try {
    const url = new URL(web.url)
    const token = await exchange(web, web.url)
    const response = fetch(`${url.origin}/api/model-services`, {
      method: 'POST',
      headers: { origin: url.origin, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 'r', services: [] }),
    })
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    await evict(web)
    release()
    const result = await response
    expect(result.status).toBe(503)
    expect(await result.json()).toEqual({ error: 'OPERATION_RESULT_UNKNOWN' })
  } finally {
    release()
    await web.close()
  }
}, 30_000)

it('aborts the private socket on revocation without claiming a sent operation was cancelled', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-abort-'))
  const socketPath = path.join(directory, 'owner.sock')
  let received!: () => void
  const sent = new Promise<void>(resolve => {
    received = resolve
  })
  const server = createServer(socket => {
    socket.on('data', () => received())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  try {
    const paths = { socket: socketPath } as Parameters<typeof requestPluginManagementRpc>[0]
    const endpoint = { token: 'fixture', profileId: 'fixture' } as Parameters<typeof requestPluginManagementRpc>[1]
    const alreadyRevoked = new AbortController()
    alreadyRevoked.abort()
    await expect(requestPluginManagementRpc(paths, endpoint, { kind: 'query' }, { signal: alreadyRevoked.signal }))
      .rejects.toThrow('MANAGER_SESSION_REVOKED')
    const controller = new AbortController()
    const pending = requestPluginManagementRpc(paths, endpoint, { kind: 'query' }, { signal: controller.signal })
    await sent
    controller.abort()
    await expect(pending).rejects.toThrow('MANAGER_SESSION_REVOKED')
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
