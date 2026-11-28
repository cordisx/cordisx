import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../packages/cli/src/launcher/management-rpc.js'
import { ManagedProviderOwner } from '../packages/cli/src/launcher/model-catalog/managed-provider-owner.js'
import { portableConnection } from '../packages/cli/src/launcher/model-catalog/portable-transfer-codec.js'
import { exerciseInstalledCodex } from './helpers/managed-terminal-real-client.js'

const run = promisify(execFile)

it('serves an existing Host-managed model through an isolated service owner', async () => {
  const root = await realpath(await mkdtemp('/tmp/cx-managed-model-owner-'))
  const home = path.join(root, 'cordisx')
  const ca = path.join(root, 'ca.pem')
  const caKey = path.join(root, 'ca-key.pem')
  const cert = path.join(root, 'cert.pem')
  const csr = path.join(root, 'cert.csr')
  const privateKey = path.join(root, 'key.pem')
  const profile = 'fixture'
  const cli = path.resolve('packages/cli/dist/src/cli.js')
  let upstream: ReturnType<typeof createServer> | undefined
  let launchAttempted = false
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    CORDISX_HOME: home,
    CORDISX_MODEL_API_PORT: '0',
    NODE_EXTRA_CA_CERTS: ca,
    TMPDIR: root,
  }
  const command = async (action: string) =>
    await run(process.execPath, [cli, action, '--mode', 'service', 'codex', profile, '--json'], {
      env,
      cwd: root,
      timeout: 30_000,
    })
  try {
    await mkdir(home, { mode: 0o700 })
    await writeFile(
      path.join(root, 'server-extensions.cnf'),
      [
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage=serverAuth',
      ].join('\n'),
    )
    await run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      caKey,
      '-out',
      ca,
      '-days',
      '1',
      '-subj',
      '/CN=CordisX Local Test CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-addext',
      'keyUsage=critical,keyCertSign,cRLSign',
    ], { timeout: 10_000 })
    await run('openssl', [
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      privateKey,
      '-out',
      csr,
      '-subj',
      '/CN=localhost',
    ], { timeout: 10_000 })
    await run('openssl', [
      'x509',
      '-req',
      '-in',
      csr,
      '-CA',
      ca,
      '-CAkey',
      caKey,
      '-CAcreateserial',
      '-out',
      cert,
      '-days',
      '1',
      '-extfile',
      path.join(root, 'server-extensions.cnf'),
    ], { timeout: 10_000 })
    let requests = 0
    let authorization: string | undefined
    const tlsErrors: string[] = []
    upstream = createServer({ key: await readFile(privateKey), cert: await readFile(cert) }, async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{}')
        return
      }
      requests++
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      authorization = req.headers.authorization
      const body = JSON.parse(Buffer.concat(chunks).toString())
      if (body.stream) {
        const message = {
          id: 'msg_fixture',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'local fixture response', annotations: [] }],
        }
        const completed = {
          id: 'resp_fixture',
          object: 'response',
          created_at: 1,
          status: 'completed',
          model: body.model,
          output: [message],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (
          const event of [
            { type: 'response.output_item.done', output_index: 0, item: message },
            { type: 'response.completed', response: completed },
          ]
        ) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        return res.end()
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ model: body.model, output: [] }))
    })
    upstream.on('tlsClientError', error => tlsErrors.push((error as NodeJS.ErrnoException).code ?? 'tls-error'))
    await new Promise<void>((resolve, reject) => {
      upstream!.once('error', reject)
      upstream!.listen(0, '127.0.0.1', resolve)
    })
    const config = createDefaultHomeConfig()
    await writeFile(
      path.join(home, 'config.json'),
      JSON.stringify({
        ...config,
        apps: {
          codex: { defaultProfile: profile, profiles: { [profile]: { displayName: 'Fixture', dataMode: 'shared' } } },
        },
      }),
      { mode: 0o600 },
    )
    const seed = await ManagedProviderOwner.open({ homeDir: home, profileId: profile })
    try {
      const connection = portableConnection({
        title: 'Fixture',
        endpoint: `https://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
        protocol: 'responses',
        auth: 'bearer',
        environment: 'FIXTURE_MODEL_KEY',
        models: [{ id: 'fixture-model', label: 'Fixture model' }],
      })
      await seed.importPortable(
        { version: 2, environment: [{ name: 'FIXTURE_MODEL_KEY' }], connections: [connection] },
        [
          { sourceName: 'FIXTURE_MODEL_KEY', name: 'FIXTURE_MODEL_KEY', value: 'fixture-secret', enabled: true },
        ],
      )
    } finally {
      await seed.close()
    }
    launchAttempted = true
    const started = JSON.parse((await command('start')).stdout) as { status: string; modelApiUrl: string }
    expect(started.status).toBe('ready')
    const key = (await readFile(path.join(home, 'run', 'model-api', profile, 'access-key'), 'utf8')).trim()
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
    let model = ''
    await vi.waitFor(async () => {
      const catalog = await fetch(started.modelApiUrl + '/models', { headers }).then(response => response.json())
      model = catalog.data.find((item: { id: string }) => item.id.endsWith('::fixture-model'))?.id ?? ''
      expect(model).not.toBe('')
    }, { timeout: 10_000 })
    const providerId = model.slice(0, model.indexOf('::'))
    const paths = pluginManagementRpcPaths(home, 'codex', profile)
    const endpoint = (await readPluginManagementRpcEndpoint(paths))!
    const terminal = await requestPluginManagementRpc(paths, endpoint, {
      kind: 'terminal-provider',
      request: { kind: 'prepare', providerId, model: 'fixture-model' },
    }) as { kind: string; leaseId: string }
    expect(terminal.kind).toBe('prepared')
    expect(JSON.stringify(terminal)).not.toContain('fixture-secret')
    expect(
      await requestPluginManagementRpc(paths, endpoint, {
        kind: 'terminal-provider',
        request: { kind: 'renew', leaseId: terminal.leaseId },
      }),
    ).toEqual({ kind: 'renewed' })
    await requestPluginManagementRpc(paths, endpoint, {
      kind: 'terminal-provider',
      request: { kind: 'release', leaseId: terminal.leaseId },
    })
    const response = await fetch(started.modelApiUrl + '/responses', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: 'synthetic' }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({ model: 'fixture-model' })
    expect(authorization).toBe('Bearer fixture-secret')
    expect(requests).toBe(1)
    let exercised = false
    try {
      exercised = await exerciseInstalledCodex({
        root,
        cert: ca,
        port: (upstream.address() as { port: number }).port,
        profile,
        providerId,
        env,
      })
    } catch (error) {
      const diagnostic = process.env.CORDISX_TEST_CODEX_DIAGNOSTIC
      if (diagnostic) {
        const record = JSON.parse(await readFile(diagnostic, 'utf8')) as Record<string, unknown>
        await writeFile(diagnostic, JSON.stringify({ ...record, upstreamRequests: requests, tlsErrors }), {
          mode: 0o600,
        })
      }
      throw error
    }
    if (exercised) expect(requests).toBeGreaterThan(1)
  } finally {
    let stopConfirmed = !launchAttempted
    if (launchAttempted) {
      try {
        const stopped = JSON.parse((await command('stop')).stdout) as { status: string }
        stopConfirmed = stopped.status === 'stopped'
      } catch { /* Preserve the fixture root when the owner cannot be confirmed stopped. */ }
    }
    upstream?.closeAllConnections()
    if (upstream) await new Promise<void>(resolve => upstream!.close(() => resolve()))
    if (!stopConfirmed) throw new Error('Fixture owner shutdown was not confirmed')
    await rm(root, { recursive: true, force: true })
  }
}, 90_000)
