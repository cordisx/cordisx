import { request } from 'node:http'
import { expect, it } from 'vitest'
import { startManagerWeb } from '../packages/cli/src/cli/manager-web.js'

const localConsole = 'http://console-' + 'a'.repeat(32) + '.cordisx-console.localhost:49000'
const managerOrigin = 'https://manager.example.test'
const consoleTemplate = 'https://{view}.console.example.test'
const ticket = 'b'.repeat(32)
const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: 'c'.repeat(64) }

function owner() {
  return {
    appId: 'codex',
    profileId: 'work',
    generation: 'owner-1',
    managerConsoleOrigins: [localConsole],
    isCurrent: async () => true,
    request: async (operation: { action?: string }) => {
      if (operation.action === 'open') {
        return {
          status: 'ok',
          channels: ['plugin-management', 'managed-service-ui'],
          handle: { rendererId: 'd'.repeat(64), grant: 'e'.repeat(64), ownerGeneration: 'owner-1' },
        }
      }
      if (operation.action === 'call') {
        return {
          status: 'ok',
          value: {
            requestId: 'issue-1',
            ok: true,
            value: {
              status: 'available',
              binding: {},
              serviceGeneration: 'one',
              origin: localConsole,
              url: localConsole + '/auth/browser?ticket=' + ticket,
            },
          },
        }
      }
      return { status: 'ok' }
    },
  } as unknown as Parameters<typeof startManagerWeb>[0]
}

async function send(
  web: Awaited<ReturnType<typeof startManagerWeb>>,
  route: string,
  body?: unknown,
  token?: string,
) {
  return await new Promise<{ status: number | undefined; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const outgoing = request(web.localOrigin + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          host: new URL(managerOrigin).host,
          origin: managerOrigin,
          'content-type': 'application/json',
          ...(token ? { authorization: 'Bearer ' + token } : {}),
        },
      }, response => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', chunk => text += chunk)
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: text }))
        response.on('error', reject)
      })
      outgoing.on('error', reject).end(body === undefined ? undefined : JSON.stringify(body))
    },
  )
}

async function issueConsole(web: Awaited<ReturnType<typeof startManagerWeb>>) {
  const session = await send(web, '/api/session', { token: new URL(web.url).hash.slice(1) })
  const { token } = JSON.parse(session.body) as { token: string }
  expect((await send(web, '/api/renderer/open', {}, token)).status).toBe(200)
  return await send(web, '/api/renderer/binding', {
    channel: 'managed-service-ui',
    payload: JSON.stringify({
      requestId: 'issue-1',
      operation: 'consoleBrowser',
      token: 'fixture-token',
      serviceId: 'fixture-service',
      request: { action: 'issue', viewId: 'view-1' },
    }),
  }, token)
}

it('maps an owner-issued console to its configured public iframe origin', async () => {
  const web = await startManagerWeb(owner(), {
    rendererGateway: gateway,
    publicOrigin: managerOrigin,
    publicConsoleOriginTemplates: [consoleTemplate],
  })
  try {
    const page = await send(web, '/')
    const policy = String(page.headers['content-security-policy'])
    expect(policy).toContain('frame-src https://*.console.example.test;')
    expect(policy).not.toContain(localConsole)
    const result = await issueConsole(web)
    expect(result.status).toBe(200)
    expect(result.body).not.toContain(localConsole)
    const value = JSON.parse(result.body).value
    expect(value).toMatchObject({
      status: 'available',
    })
    expect(value.origin).toMatch(/^https:\/\/[a-f0-9]{32}\.console\.example\.test$/u)
    expect(value.url).toBe(value.origin + '/auth/browser?ticket=' + ticket)
    expect(web.consoleMapping?.resolve(new URL(value.origin).host)?.localOrigin).toBe(localConsole)
  } finally {
    await web.close()
  }
})

it('does not expose a local console URL when no public mapping exists', async () => {
  const web = await startManagerWeb(owner(), { rendererGateway: gateway, publicOrigin: managerOrigin })
  try {
    const page = await send(web, '/')
    expect(String(page.headers['content-security-policy'])).not.toContain(localConsole)
    const result = await issueConsole(web)
    expect(result.body).not.toContain(localConsole)
    expect(JSON.parse(result.body).value).toEqual({ status: 'unavailable', reason: 'unsupported' })
  } finally {
    await web.close()
  }
})

it('rejects console mappings that do not match the owner or reuse the Manager origin', async () => {
  await expect(startManagerWeb(owner(), { publicOrigin: managerOrigin, publicConsoleOriginTemplates: [] })).rejects
    .toThrow()
  await expect(startManagerWeb(owner(), { publicOrigin: managerOrigin, publicConsoleOriginTemplates: [managerOrigin] }))
    .rejects.toThrow()
})
