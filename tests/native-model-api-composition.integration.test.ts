import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createNativeSubmissionComposition } from '../packages/cli/src/launcher/native-submission-composition.js'
import { bundle, pluginActivation, writeManagedProfile } from './fixtures/native-app-bundle.js'

const roots: string[] = []
beforeEach(async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cx-api-composition-'))
  roots.push(home)
  vi.stubEnv('CORDISX_HOME', home)
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.skipIf(process.platform !== 'darwin')(
  'publishes the production model API and prepares managed Agent credentials before native dispatch',
  async () => {
    vi.stubEnv('CORDISX_MODEL_API_PORT', '0')
    const f = await bundle(roots)
    const home = path.join(f.contents, 'api-home')
    await mkdir(home, { mode: 0o700 })
    await writeManagedProfile(home, 'api-fixture')
    const upstream = (await import('node:http')).createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      expect(req.headers.authorization).toBe('Bearer fixture-api-secret')
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ model: JSON.parse(Buffer.concat(chunks).toString()).model, output: [] }))
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const base = pluginActivation({ fixture: { pluginId: 'fixture-plugin', modelId: 'fixture-model' } })
    const activation = {
      ...base,
      prepareNativeConnection(providerId: string) {
        const session = base.prepareNativeConnection(providerId)
        return {
          ...session,
          value: {
            ...session.value,
            endpoint: {
              origin: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
              apiPath: '/v1' as const,
              auth: { scheme: 'bearer' as const, token: 'fixture-api-secret' },
            },
          },
        }
      },
    }
    const composition = await createNativeSubmissionComposition(activation, f.executable, home, {
      managedCatalog: { homeDir: home, profileId: 'api-fixture' },
      nativeModelDiscovery: false,
    })
    const dispatched: Array<{ method: string; params: Record<string, any> }> = []
    const peer = connect(composition.environment.CORDISX_NATIVE_CONTROL_SOCKET!)
    let buffer = ''
    const authenticated = new Promise<void>(resolve => {
      peer.on('connect', () =>
        peer.write(
          JSON.stringify({
            id: 'api-hello',
            type: 'hello',
            nonce: composition.environment.CORDISX_NATIVE_CONTROL_NONCE,
          }) + '\n',
        ))
      peer.on('data', chunk => {
        buffer += chunk.toString()
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const input = JSON.parse(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
          if (input.id === 'api-hello') {
            resolve()
            continue
          }
          if (input.type !== 'native-request') {
            continue
          }
          dispatched.push(input)
          const value = input.method === 'thread/start'
            ? { thread: { id: 'api-task', modelProvider: 'fixture' } }
            : input.method === 'turn/start'
            ? { turn: { id: 'api-turn' } }
            : { thread: { id: 'api-task', modelProvider: 'fixture', status: { type: 'active' }, turns: [] } }
          peer.write(JSON.stringify({ id: input.id, ok: true, value }) + '\n')
        }
      })
    })
    try {
      await authenticated
      const binding = JSON.parse(await readFile(path.join(home, 'run/model-api/api-fixture/server.json'), 'utf8'))
      const key = (await readFile(binding.accessKeyFile, 'utf8')).trim()
      const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
      const catalog = await fetch(binding.baseUrl + '/models', { headers }).then(r => r.json())
      expect(catalog.data).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'fixture::fixture-model', invocation: 'model' })]),
      )
      const reply = await fetch(binding.baseUrl + '/responses', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: 'fixture::fixture-model', input: 'mock' }),
      })
      expect(await reply.json()).toMatchObject({ model: 'fixture-model' })
      const started = await fetch(binding.agentUrl + '/sessions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ providerId: 'fixture', model: 'fixture-model', prompt: 'mock agent turn', cwd: home }),
      }).then(r => r.json())
      expect(started).toMatchObject({ status: 'started', sessionId: 'api-task', turnId: 'api-turn' })
      for (const method of ['thread/start', 'turn/start']) {
        const params = dispatched.find(call => call.method === method)!.params
        expect(params.config['model_providers.fixture']).toMatchObject({
          wire_api: 'responses',
          requires_openai_auth: false,
          auth: { command: expect.any(String) },
        })
        expect(JSON.stringify(params)).not.toContain('fixture-api-secret')
      }
    } finally {
      peer.destroy()
      await composition.close()
      upstream.closeAllConnections()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
    }
  },
  20000,
)
