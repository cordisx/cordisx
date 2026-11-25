import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { createDefaultHomeConfig, parseHomeConfig } from '../packages/cli/src/config/home-config.js'
import { channelModelConnectivityEvidence } from '../packages/cli/src/launcher/channel-model-connectivity.js'
import { channelMemoryServiceConnection } from '../packages/cli/src/launcher/channel-user-memory-connection.js'

it('uses exact configured route-to-response mapping against a real synthetic Responses endpoint', async () => {
  const bodies: Record<string, unknown>[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    bodies.push(JSON.parse(body))
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ status: 'completed', model: 'trusted/upstream/model' }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const provider = {
    id: 'gateway',
    kind: 'model-service',
    displayName: 'Gateway',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKeyEnv: 'TEST_KEY',
    protocols: ['openai-responses'],
    models: { codex: ['route/model'] },
  }
  const config = (aliases?: Record<string, string[]>) =>
    parseHomeConfig({
      ...createDefaultHomeConfig(),
      providers: [{ ...provider, ...(aliases ? { responseModelAliases: aliases } : {}) }],
    })
  const probe = (aliases?: Record<string, string[]>) =>
    channelModelConnectivityEvidence(
      channelMemoryServiceConnection(config(aliases), { TEST_KEY: 'fixture-key' }),
      { providerId: 'gateway', model: 'route/model' },
    )
  try {
    expect(await probe()).toBe('inconclusive')
    expect(await probe({ 'route/model': ['trusted/upstream/model'] })).toBe('healthy')
    expect(await probe({ 'route/model': ['other/upstream/model'] })).toBe('inconclusive')
    expect(bodies).toHaveLength(3)
    expect(new Set(bodies.map(body => body.prompt_cache_key)).size).toBe(3)
    for (const body of bodies) expect(body).toMatchObject({ model: 'route/model', tools: [], store: false })
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
