import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchMarketplaceFeed, normalizeMarketplaceRequestUrl } from '../packages/cli/src/launcher/marketplace.js'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(server =>
      new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
      })
    ),
  )
})

describe('launcher marketplace network boundary', () => {
  it('accepts user-configured HTTP and HTTPS feed URLs without credentials or fragments', () => {
    expect(normalizeMarketplaceRequestUrl('http://localhost:3000/marketplace.json').href)
      .toBe('http://localhost:3000/marketplace.json')
    expect(normalizeMarketplaceRequestUrl('http://192.168.1.20:8080/feed.json').href)
      .toBe('http://192.168.1.20:8080/feed.json')
    expect(normalizeMarketplaceRequestUrl('https://internal.example/feed.json').href)
      .toBe('https://internal.example/feed.json')
    expect(() => normalizeMarketplaceRequestUrl('file:///tmp/feed.json')).toThrow('HTTP or HTTPS URL')
    expect(() => normalizeMarketplaceRequestUrl('https://user@example.com/feed.json')).toThrow('credentials')
    expect(() => normalizeMarketplaceRequestUrl('https://example.com/feed.json#entry')).toThrow('fragment')
  })

  it('fetches a localhost HTTP feed and follows relative redirects', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/marketplace.json' })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"plugins":["local"]}')
    })
    servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server address unavailable')

    await expect(fetchMarketplaceFeed(`http://127.0.0.1:${address.port}/redirect`)).resolves.toEqual({
      url: `http://127.0.0.1:${address.port}/marketplace.json`,
      status: 200,
      text: '{"plugins":["local"]}',
    })
  })
})
