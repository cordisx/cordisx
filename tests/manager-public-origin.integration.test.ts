import { request } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { createManagerEntry } from '../packages/cli/src/cli/manager-entry.js'
import { startManagerWeb } from '../packages/cli/src/cli/manager-web.js'

const owner = {
  appId: 'codex',
  profileId: 'work',
  generation: 'owner-1',
  isCurrent: async () => true,
  request: async () => ({ status: 'unavailable' }),
} as unknown as Parameters<typeof startManagerWeb>[0]

it('uses the configured public origin while keeping the Manager listener local', async () => {
  const publicOrigin = 'https://manager.example.test'
  const web = await startManagerWeb(owner, { publicOrigin })
  try {
    const entry = new URL(web.url)
    expect(entry.origin).toBe(publicOrigin)
    expect(new URL(web.localOrigin).hostname).toBe('127.0.0.1')
    const headers = { host: entry.host, origin: publicOrigin, 'content-type': 'application/json' }
    const send = async (route: string, requestHeaders: typeof headers, body?: unknown) =>
      await new Promise<{ status: number | undefined; cookies: string[] | undefined }>((resolve, reject) => {
        const outgoing = request(web.localOrigin + route, {
          method: body === undefined ? 'GET' : 'POST',
          headers: requestHeaders,
        }, response => {
          response.resume()
          response.on('end', () => resolve({ status: response.statusCode, cookies: response.headers['set-cookie'] }))
          response.on('error', reject)
        })
        outgoing.on('error', reject).end(body === undefined ? undefined : JSON.stringify(body))
      })
    expect((await send('/', { ...headers, host: 'other.example.test' })).status).toBe(403)
    expect((await send('/', { ...headers, origin: 'https://other.example.test' })).status)
      .toBe(403)
    expect((await send('/', headers)).status).toBe(200)
    const response = await send('/api/session', headers, { token: entry.hash.slice(1), resume: true })
    expect(response.status).toBe(200)
    expect(response.cookies?.[0]).toContain('Secure')
  } finally {
    await web.close()
  }
})

it('opens the configured origin through the existing private entry file', async () => {
  const web = await startManagerWeb(owner, { publicOrigin: 'https://manager.example.test' })
  let directory: string | undefined
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), 'cx-public-manager-entry-'))
    const entry = await createManagerEntry(directory, web)
    expect(await readFile(entry, 'utf8')).toContain('https://manager.example.test/#')
  } finally {
    try {
      await web.close()
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  }
})

it.each([
  'ftp://manager.example.test',
  'https://user:password@manager.example.test',
  'https://manager.example.test/path',
  'https://manager.example.test?query=1',
  'https://manager.example.test#fragment',
])('rejects a non-origin public address %s', async publicOrigin => {
  await expect(startManagerWeb(owner, { publicOrigin })).rejects.toThrow()
})
