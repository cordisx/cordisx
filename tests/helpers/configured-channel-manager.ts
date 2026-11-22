import { randomBytes } from 'node:crypto'
import { expect } from 'vitest'
import { decodeManagerRendererBundle } from '../../packages/cli/src/cli/manager-renderer-bundle-codec.js'
import type { ServiceRendererPrivateGraph } from '../../packages/cli/src/cli/service-renderer-projection.js'
import type { fixture } from '../fixtures/service-renderer-bootstrap-fixture.js'
import { STANDALONE_PERMISSION_BINDING_MARKER } from '../../packages/cli/src/standalone-permission-contract.js'

type Fixture = Awaited<ReturnType<typeof fixture>>
const origin = 'http://127.0.0.1:43123'
const secret = () => randomBytes(32).toString('hex')

export async function bootConfiguredChannelManager(
  f: Fixture,
  invocation = f.invocation,
  expectCredentialBridge = f.channelCredentialsEnabled,
  expectServiceConfigBridge?: boolean,
  permissionPublicKey?: unknown,
): Promise<string> {
  const prepared = await f.sessions.call(invocation, 'manager-bootstrap', { action: 'prepare' }) as any
  expect(prepared).toMatchObject({ status: 'ok', value: { status: 'ok' } })
  const privateGraph: ServiceRendererPrivateGraph = prepared.value.privateGraphs[0]
  const baseUrl = origin + '/api/renderer/graphs/' + secret() + '/'
  const graph = {
    leaseId: secret(),
    pluginId: privateGraph.pluginId,
    moduleGeneration: privateGraph.moduleGeneration,
    baseUrl,
    entryUrl: baseUrl + privateGraph.entryUrl.slice(privateGraph.baseUrl.length),
    initialStyleUrls: privateGraph.initialStyleUrls.map(url => baseUrl + url.slice(privateGraph.baseUrl.length)),
  }
  const completed = await f.sessions.call(invocation, 'manager-bootstrap', {
    action: 'complete',
    managerOrigin: origin,
    graphs: [graph],
    ...(permissionPublicKey === undefined ? {} : { permissionPublicKey }),
  }) as any
  expect(completed).toMatchObject({ status: 'ok', value: { status: 'ok' } })
  const bytes = await decodeManagerRendererBundle(completed.value.bundle)
  let alias: string | undefined
  try {
    const bundle = bytes.toString('utf8')
    alias = bundle.match(new RegExp('https://renderer[.]cordisx[.]invalid/plugin/[a-f0-9]{64}', 'u'))?.[0]
    expect(alias).toBeDefined()
    expect(bundle).not.toContain(f.configuredChannel!.plugin.source!)
    expect(bundle).not.toContain('fixture-private-reference')
    expect(new RegExp(`permissionBridgeToken\\s*:\\s*"${STANDALONE_PERMISSION_BINDING_MARKER}"`, 'u').test(bundle))
      .toBe(permissionPublicKey !== undefined)
    expect(/channelCredentialBridgeToken\s*:\s*"renderer-binding-placeholder"/u.test(bundle))
      .toBe(expectCredentialBridge)
    if (expectServiceConfigBridge !== undefined) {
      expect(/serviceConfigBridgeToken\s*:\s*"renderer-binding-placeholder"/u.test(bundle)).toBe(
        expectServiceConfigBridge,
      )
    }
  } finally {
    bytes.fill(0)
  }
  const polling = f.sessions.poll(invocation, 3000)
  const admission = f.sessions.admit(invocation)
  const command = (await polling as any).value.command
  expect(command.method).toBe('synchronize')
  expect(
    await f.sessions.acknowledge(invocation, {
      id: command.id,
      sequence: command.sequence,
      ok: true,
      value: { active: command.payload.active, registryEpoch: command.payload.registryEpoch },
    }),
  ).toEqual({ status: 'ok', value: { accepted: true } })
  expect(await admission).toEqual({ status: 'ok', value: { admitted: true } })
  return alias!
}
