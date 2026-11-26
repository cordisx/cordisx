import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { ManagedProviderOwner } from '../packages/cli/src/launcher/model-catalog/managed-provider-owner.js'
import { portableConnection } from '../packages/cli/src/launcher/model-catalog/portable-transfer-codec.js'

const run = promisify(execFile)

it('serves an existing Host-managed model through an isolated service owner', async () => {
  const root = await mkdtemp('/tmp/cx-managed-model-owner-')
  const home = path.join(root, 'cordisx')
  const cert = path.join(root, 'cert.pem')
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
    NODE_EXTRA_CA_CERTS: cert,
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
      path.join(root, 'openssl.cnf'),
      [
        '[req]',
        'distinguished_name=dn',
        'x509_extensions=v3',
        'prompt=no',
        '[dn]',
        'CN=localhost',
        '[v3]',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
        'basicConstraints=critical,CA:TRUE',
      ].join('\n'),
    )
    await run('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      privateKey,
      '-out',
      cert,
      '-days',
      '1',
      '-config',
      path.join(root, 'openssl.cnf'),
    ], { timeout: 10_000 })
    let requests = 0
    let authorization: string | undefined
    upstream = createServer({ key: await readFile(privateKey), cert: await readFile(cert) }, async (req, res) => {
      requests++
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk)
      authorization = req.headers.authorization
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ model: JSON.parse(Buffer.concat(chunks).toString()).model, output: [] }))
    })
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
    const response = await fetch(started.modelApiUrl + '/responses', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input: 'synthetic' }),
    })
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({ model: 'fixture-model' })
    expect(authorization).toBe('Bearer fixture-secret')
    expect(requests).toBe(1)
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
