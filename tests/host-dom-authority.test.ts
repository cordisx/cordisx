import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import type { HostDomBridgeRequest, HostDomBridgeResult, HostDomNodeRef } from '@cordisx/protocol/host-dom/v1'
import { HostDomAuthority, type HostDomRootDefinition } from '../packages/cli/src/renderer/host-dom.js'
import type { HostDomPermissionAccessDecision } from '../packages/cli/src/renderer/platform.js'

const REQUEST =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/host-dom-bridge-request.v1.schema.json'
const RESULT =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/host-dom-bridge-result.v1.schema.json'
const CATALOG =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/host-dom-root-catalog.v1.schema.json'
const base = (requestId: string) => ({
  $schema: REQUEST,
  contract: 'cordisx.bound-host-dom/v1' as const,
  schemaVersion: 1 as const,
  requestId,
})

const require = createRequire(import.meta.url)
const protocolRoot = path.resolve(path.dirname(require.resolve('@cordisx/protocol/host-dom/v1')), '..')

async function formalHostDomValidators(): Promise<{ catalog: ValidateFunction; result: ValidateFunction }> {
  const schemas = await Promise.all([
    'ui-common.v1.schema.json',
    'host-dom-common.v1.schema.json',
    'host-dom-root-catalog.v1.schema.json',
    'host-dom-bridge-result.v1.schema.json',
  ].map(async name => JSON.parse(await readFile(path.join(protocolRoot, 'schemas', name), 'utf8')) as object))
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  for (const schema of schemas) ajv.addSchema(schema)
  return { catalog: ajv.getSchema(CATALOG)!, result: ajv.getSchema(RESULT)! }
}

function expectFormal(validator: ValidateFunction, value: unknown): void {
  expect(validator(value), JSON.stringify(validator.errors)).toBe(true)
}

function acceptedLease(
  capability: 'ui.host-dom.read' | 'ui.host-dom.modify',
  id: string,
): HostDomPermissionAccessDecision {
  return {
    authorized: true,
    state: 'allowed',
    reason: 'permission.explicit-user',
    policy: 'inherit',
    authorizationOrigin: 'explicit-user',
    lease: {
      leaseId: id,
      key: {
        profileId: 'work',
        identity: { source: 'https://plugins.example/demo', pluginId: 'demo' },
        capability,
        scope: {
          rootIds: ['root.one', 'root.two'],
          operations: capability === 'ui.host-dom.read'
            ? ['inspect-structure', 'read-text', 'read-attributes', 'read-state']
            : ['set-text', 'insert-owned-structured-child'],
        },
        securityFingerprint: `sha256:${'a'.repeat(64)}`,
      },
      runtimeGeneration: 'runtime-1',
      moduleGeneration: 'module-1',
      authorizationOrigin: 'explicit-user',
    },
  }
}

function roots(document: Document): readonly HostDomRootDefinition[] {
  return ['root.one', 'root.two'].map(rootId => ({
    rootId,
    name: { key: `${rootId}.name`, fallback: rootId },
    description: { key: `${rootId}.description`, fallback: rootId },
    sensitivity: 'high-risk' as const,
    readOperations: ['inspect-structure', 'read-text', 'read-attributes', 'read-state'] as const,
    modifyOperations: [
      'set-text',
      'set-attribute',
      'insert-owned-structured-child',
      'remove-owned-child',
      'focus',
    ] as const,
    resolve: () => document.querySelector(`[data-root="${rootId}"]`) ?? undefined,
  }))
}

function binding() {
  const leases = new Set<string>()
  const listeners = new Set<() => void>()
  let state: 'active' | 'disabled' | 'uninstalled' | 'generation-replaced' = 'active'
  let sequence = 0
  return {
    leases,
    listeners,
    setState(next: typeof state) {
      state = next
      for (const listener of listeners) listener()
    },
    revoke(id: string) {
      leases.delete(id)
      for (const listener of listeners) listener()
    },
    value: {
      ownerKey: 'https://plugins.example/demo\u0000demo',
      profileId: 'work',
      identity: { source: 'https://plugins.example/demo', pluginId: 'demo' },
      runtimeGeneration: 'runtime-1',
      moduleGeneration: 'module-1',
      state: () => state,
      authorize: async (capability: 'ui.host-dom.read' | 'ui.host-dom.modify') => {
        const id = `lease-${++sequence}`
        leases.add(id)
        return acceptedLease(capability, id)
      },
      leaseActive: (id: string) => leases.has(id),
      subscribeInvalidation: (listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      invokeCommand: vi.fn(),
    },
  }
}

function nodeFrom(result: HostDomBridgeResult, index: number): HostDomNodeRef {
  if (result.status !== 'accepted' || result.type !== 'read' || result.projection.kind !== 'structure') {
    throw new Error('structure result expected')
  }
  return result.projection.nodes[index]!.node
}

describe('Host DOM authority', () => {
  it('reports unavailable and never authorizes in the current shared-renderer boundary', async () => {
    const validators = await formalHostDomValidators()
    const dom = new JSDOM('<body><main data-root="root.one"></main><aside data-root="root.two"></aside></body>')
    const owner = binding()
    const authorize = vi.spyOn(owner.value, 'authorize')
    const authority = new HostDomAuthority({
      hostGeneration: 'host-1',
      isolatedPluginBoundary: false,
      roots: roots(dom.window.document),
    })
    const client = authority.bind(owner.value)

    const catalog = await client.catalog()
    expectFormal(validators.catalog, catalog)
    expect(catalog.roots).toEqual(expect.arrayContaining([
      expect.objectContaining({ rootId: 'root.one', availability: 'unavailable', unavailableReason: 'unsupported' }),
    ]))
    const result = await client.request({
      ...base('acquire-1'),
      type: 'acquire',
      capability: 'ui.host-dom.read',
      rootId: 'root.one',
      operations: ['read-text'],
    })
    expectFormal(validators.result, result)
    expect(result).toMatchObject({ status: 'unavailable', code: 'unsupported' })
    expect(authorize).not.toHaveBeenCalled()
    authority.dispose()
    dom.window.close()
  })

  it('performs bounded reads and reversible writes with opaque owner/root/generation fenced handles', async () => {
    const validators = await formalHostDomValidators()
    const dom = new JSDOM(
      '<body><main data-root="root.one"><span id="label">Before</span><span data-cordisx-private="true">Secret</span><span>Visible</span></main><aside data-root="root.two"><span>Other</span></aside></body>',
      { pretendToBeVisual: true },
    )
    const owner = binding()
    const authority = new HostDomAuthority({
      hostGeneration: 'host-1',
      isolatedPluginBoundary: true,
      roots: roots(dom.window.document),
    })
    const client = authority.bind(owner.value)
    const readHandle = await client.request({
      ...base('read-handle'),
      type: 'acquire',
      capability: 'ui.host-dom.read',
      rootId: 'root.one',
      operations: ['inspect-structure', 'read-text'],
    })
    expectFormal(validators.result, readHandle)
    if (readHandle.status !== 'accepted' || readHandle.type !== 'acquire') throw new Error('read handle expected')
    const structure = await client.request({
      ...base('inspect'),
      type: 'read',
      handle: readHandle.handle,
      operation: 'inspect-structure',
    })
    expectFormal(validators.result, structure)
    const label = nodeFrom(structure, 1)
    expect(JSON.stringify(structure)).not.toContain('#label')
    const text = await client.request({
      ...base('read-text'),
      type: 'read',
      handle: readHandle.handle,
      operation: 'read-text',
    })
    expectFormal(validators.result, text)
    expect(text).toMatchObject({
      status: 'accepted',
      projection: { kind: 'text', text: 'BeforeVisible', redacted: true, truncated: false },
    })
    expect(JSON.stringify(text)).not.toContain('Secret')

    const modifyHandle = await client.request({
      ...base('modify-handle'),
      type: 'acquire',
      capability: 'ui.host-dom.modify',
      rootId: 'root.one',
      operations: ['set-text', 'insert-owned-structured-child'],
    })
    if (modifyHandle.status !== 'accepted' || modifyHandle.type !== 'acquire') throw new Error('modify handle expected')
    const changed = await client.request({
      ...base('set-text'),
      type: 'modify',
      handle: modifyHandle.handle,
      node: label,
      operation: 'set-text',
      text: 'After',
    })
    expectFormal(validators.result, changed)
    expect(changed).toMatchObject({ status: 'accepted', changed: true })
    expect(dom.window.document.querySelector('#label')?.textContent).toBe('After')

    const otherHandle = await client.request({
      ...base('other-handle'),
      type: 'acquire',
      capability: 'ui.host-dom.modify',
      rootId: 'root.two',
      operations: ['set-text'],
    })
    if (otherHandle.status !== 'accepted' || otherHandle.type !== 'acquire') throw new Error('other handle expected')
    await expect(client.request({
      ...base('cross-root'),
      type: 'modify',
      handle: otherHandle.handle,
      node: label,
      operation: 'set-text',
      text: 'Crossed',
    })).resolves.toMatchObject({ status: 'denied', code: 'scope-denied' })

    await expect(client.request({
      ...base('raw-selector'),
      type: 'modify',
      handle: modifyHandle.handle,
      node: label,
      operation: 'set-text',
      text: 'Bad',
      selector: '#label',
    } as HostDomBridgeRequest)).resolves.toMatchObject({ status: 'denied', code: 'operation-denied' })

    owner.revoke(modifyHandle.handle === readHandle.handle ? 'none' : [...owner.leases][1]!)
    expect(dom.window.document.querySelector('#label')?.textContent).toBe('Before')
    client.dispose()
    authority.dispose()
    dom.window.close()
  })

  it('targets the exact root for a modify-only handle when node is omitted and rolls back on lease invalidation', async () => {
    const validators = await formalHostDomValidators()
    const dom = new JSDOM('<body><main data-root="root.one">Before</main><aside data-root="root.two"></aside></body>')
    const owner = binding()
    const authorize = vi.spyOn(owner.value, 'authorize')
    const authority = new HostDomAuthority({
      hostGeneration: 'host-1',
      isolatedPluginBoundary: true,
      roots: roots(dom.window.document),
    })
    const client = authority.bind(owner.value)
    const acquired = await client.request({
      ...base('modify-root-acquire'),
      type: 'acquire',
      capability: 'ui.host-dom.modify',
      rootId: 'root.one',
      operations: ['set-text'],
    })
    expectFormal(validators.result, acquired)
    if (acquired.status !== 'accepted' || acquired.type !== 'acquire') throw new Error('modify handle expected')
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(authorize).toHaveBeenCalledWith('ui.host-dom.modify', 'root.one', ['set-text'])

    const changed = await client.request({
      ...base('modify-root-set-text'),
      type: 'modify',
      handle: acquired.handle,
      operation: 'set-text',
      text: 'After',
    })
    expectFormal(validators.result, changed)
    expect(changed).toMatchObject({
      status: 'accepted',
      type: 'modify',
      capability: 'ui.host-dom.modify',
      rootId: 'root.one',
      operation: 'set-text',
      changed: true,
    })
    const root = dom.window.document.querySelector('[data-root="root.one"]')!
    expect(root.textContent).toBe('After')

    await expect(client.request({
      ...base('modify-root-null-node'),
      type: 'modify',
      handle: acquired.handle,
      node: null,
      operation: 'set-text',
      text: 'Null',
    } as unknown as HostDomBridgeRequest)).resolves.toMatchObject({ status: 'denied', code: 'operation-denied' })
    await expect(client.request({
      ...base('modify-root-selector'),
      type: 'modify',
      handle: acquired.handle,
      operation: 'set-text',
      text: 'Selected',
      selector: '[data-root="root.one"]',
    } as unknown as HostDomBridgeRequest)).resolves.toMatchObject({ status: 'denied', code: 'operation-denied' })
    expect(root.textContent).toBe('After')
    expect(authorize).toHaveBeenCalledTimes(1)

    owner.revoke([...owner.leases][0]!)
    expect(root.textContent).toBe('Before')
    await expect(client.request({
      ...base('modify-root-after-revoke'),
      type: 'modify',
      handle: acquired.handle,
      operation: 'set-text',
      text: 'Stale',
    })).resolves.toMatchObject({ status: 'unavailable', code: 'stale-handle' })
    expect(root.textContent).toBe('Before')
    expect(authorize.mock.calls.some(([capability]) => capability === 'ui.host-dom.read')).toBe(false)

    client.dispose()
    authority.dispose()
    dom.window.close()
  })

  it('redacts executable, hidden, and private subtrees from text and structure projections', async () => {
    const dom = new JSDOM(
      `<body><main data-root="root.one"><span>Visible</span><style>.secret{content:'css-secret'}</style><script>script-secret</script><span hidden>hidden-secret</span><span aria-hidden="true">aria-secret</span><span style="display:none">display-secret</span></main><aside data-root="root.two"></aside></body>`,
      { pretendToBeVisual: true },
    )
    const owner = binding()
    const authority = new HostDomAuthority({
      hostGeneration: 'host-1',
      isolatedPluginBoundary: true,
      roots: roots(dom.window.document),
    })
    const client = authority.bind(owner.value)
    const acquired = await client.request({
      ...base('redacted-acquire'),
      type: 'acquire',
      capability: 'ui.host-dom.read',
      rootId: 'root.one',
      operations: ['inspect-structure', 'read-text', 'read-attributes', 'read-state'],
    })
    if (acquired.status !== 'accepted' || acquired.type !== 'acquire') throw new Error('read handle expected')
    const text = await client.request({
      ...base('redacted-text'),
      type: 'read',
      handle: acquired.handle,
      operation: 'read-text',
    })
    expect(text).toMatchObject({ status: 'accepted', projection: { kind: 'text', text: 'Visible', redacted: true } })
    expect(JSON.stringify(text)).not.toMatch(/css-secret|script-secret|hidden-secret|aria-secret|display-secret/)
    const structure = await client.request({
      ...base('redacted-structure'),
      type: 'read',
      handle: acquired.handle,
      operation: 'inspect-structure',
    })
    expect(structure).toMatchObject({ status: 'accepted', projection: { kind: 'structure', redacted: true } })
    if (structure.status !== 'accepted' || structure.type !== 'read' || structure.projection.kind !== 'structure') {
      throw new Error('structure expected')
    }
    expect(structure.projection.nodes).toHaveLength(2)
    const visible = structure.projection.nodes[1]!.node
    dom.window.document.querySelector('[data-root="root.one"]')!.setAttribute('aria-hidden', 'true')
    await expect(client.request({
      ...base('ancestor-hidden-text'),
      type: 'read',
      handle: acquired.handle,
      node: visible,
      operation: 'read-text',
    })).resolves.toMatchObject({ status: 'accepted', projection: { kind: 'text', text: '', redacted: true } })
    await expect(client.request({
      ...base('ancestor-hidden-attributes'),
      type: 'read',
      handle: acquired.handle,
      node: visible,
      operation: 'read-attributes',
      attributes: ['title'],
    })).resolves.toMatchObject({
      status: 'accepted',
      projection: { kind: 'attributes', attributes: [], redacted: true },
    })
    await expect(client.request({
      ...base('ancestor-hidden-state'),
      type: 'read',
      handle: acquired.handle,
      node: visible,
      operation: 'read-state',
    })).resolves.toMatchObject({
      status: 'accepted',
      projection: { kind: 'state', visible: false, enabled: false, redacted: true },
    })
    dom.window.document.querySelector('[data-root="root.one"]')!.removeAttribute('aria-hidden')

    const script = dom.window.document.querySelector('script')!
    const scriptAuthority = new HostDomAuthority({
      hostGeneration: 'host-1',
      isolatedPluginBoundary: true,
      roots: [{ ...roots(dom.window.document)[0]!, resolve: () => script }],
    })
    const scriptClient = scriptAuthority.bind(binding().value)
    const scriptHandle = await scriptClient.request({
      ...base('script-acquire'),
      type: 'acquire',
      capability: 'ui.host-dom.read',
      rootId: 'root.one',
      operations: ['read-text'],
    })
    if (scriptHandle.status !== 'accepted' || scriptHandle.type !== 'acquire') throw new Error('script handle expected')
    await expect(scriptClient.request({
      ...base('script-read'),
      type: 'read',
      handle: scriptHandle.handle,
      operation: 'read-text',
    })).resolves.toMatchObject({ status: 'denied', code: 'scope-denied' })
    scriptClient.dispose()
    scriptAuthority.dispose()
    client.dispose()
    authority.dispose()
    dom.window.close()
  })

  it('serializes overlapping modify roots so lease rollback cannot restore an intermediate value', async () => {
    vi.useFakeTimers()
    const dom = new JSDOM('<body><main data-root="root.one">Before</main><aside data-root="root.two"></aside></body>')
    const owner = binding()
    const authority = new HostDomAuthority({
      hostGeneration: 'host-1',
      isolatedPluginBoundary: true,
      roots: roots(dom.window.document),
    })
    const client = authority.bind(owner.value)
    const read = await client.request({
      ...base('overlap-read'),
      type: 'acquire',
      capability: 'ui.host-dom.read',
      rootId: 'root.one',
      operations: ['inspect-structure'],
    })
    if (read.status !== 'accepted' || read.type !== 'acquire') throw new Error('read handle expected')
    const structure = await client.request({
      ...base('overlap-inspect'),
      type: 'read',
      handle: read.handle,
      operation: 'inspect-structure',
    })
    const rootNode = nodeFrom(structure, 0)
    const first = await client.request({
      ...base('modify-first'),
      type: 'acquire',
      capability: 'ui.host-dom.modify',
      rootId: 'root.one',
      operations: ['set-text'],
    })
    if (first.status !== 'accepted' || first.type !== 'acquire') throw new Error('modify handle expected')
    await expect(client.request({
      ...base('modify-second'),
      type: 'acquire',
      capability: 'ui.host-dom.modify',
      rootId: 'root.one',
      operations: ['set-text'],
    })).resolves.toMatchObject({ status: 'denied', code: 'operation-denied' })
    const root = dom.window.document.querySelector('[data-root="root.one"]')!
    await client.request({
      ...base('modify-value'),
      type: 'modify',
      handle: first.handle,
      node: rootNode,
      operation: 'set-text',
      text: 'After',
    })
    expect(root.textContent).toBe('After')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(root.textContent).toBe('Before')
    await expect(client.request({
      ...base('modify-after-expiry'),
      type: 'acquire',
      capability: 'ui.host-dom.modify',
      rootId: 'root.one',
      operations: ['set-text'],
    })).resolves.toMatchObject({ status: 'accepted', code: 'allowed' })
    client.dispose()
    authority.dispose()
    dom.window.close()
    vi.useRealTimers()
  })

  it('freezes untrusted requests across authorization and rejects mismatched or stale leases before minting', async () => {
    const dom = new JSDOM('<body><main data-root="root.one"></main><aside data-root="root.two"></aside></body>')
    const activeLeases = new Set(['lease-exact', 'lease-wrong'])
    let resolveAuthorization!: (value: HostDomPermissionAccessDecision) => void
    const authorization = new Promise<HostDomPermissionAccessDecision>(resolve => {
      resolveAuthorization = resolve
    })
    let currentRoot = dom.window.document.querySelector('[data-root="root.one"]') as Element
    const authority = new HostDomAuthority({
      hostGeneration: 'host-1',
      isolatedPluginBoundary: true,
      roots: [{
        ...roots(dom.window.document)[0]!,
        resolve: () => currentRoot,
      }],
    })
    const client = authority.bind({
      ownerKey: 'https://plugins.example/demo\u0000demo',
      profileId: 'work',
      identity: { source: 'https://plugins.example/demo', pluginId: 'demo' },
      runtimeGeneration: 'runtime-1',
      moduleGeneration: 'module-1',
      state: () => 'active',
      authorize: async () => await authorization,
      leaseActive: id => activeLeases.has(id),
      subscribeInvalidation: () => () => undefined,
    })
    const untrusted = {
      ...base('toctou'),
      type: 'acquire' as const,
      capability: 'ui.host-dom.read' as const,
      rootId: 'root.one',
      operations: ['read-text'] as ['read-text'],
    }
    const pending = client.request(untrusted)
    Object.assign(untrusted, { capability: 'ui.host-dom.modify', rootId: 'root.two', operations: ['set-text'] })
    resolveAuthorization(acceptedLease('ui.host-dom.read', 'lease-exact'))
    await expect(pending).resolves.toMatchObject({
      status: 'accepted',
      capability: 'ui.host-dom.read',
      rootId: 'root.one',
      operations: ['read-text'],
    })

    const mismatched = authority.bind({
      ownerKey: 'https://plugins.example/demo\u0000demo',
      profileId: 'work',
      identity: { source: 'https://plugins.example/demo', pluginId: 'demo' },
      runtimeGeneration: 'runtime-1',
      moduleGeneration: 'module-1',
      state: () => 'active',
      authorize: async () => acceptedLease('ui.host-dom.modify', 'lease-wrong'),
      leaseActive: id => activeLeases.has(id),
      subscribeInvalidation: () => () => undefined,
    })
    await expect(mismatched.request({
      ...base('mismatch'),
      type: 'acquire',
      capability: 'ui.host-dom.read',
      rootId: 'root.one',
      operations: ['read-text'],
    })).resolves.toMatchObject({ status: 'denied', code: 'permission-denied' })

    const replacement = dom.window.document.createElement('main')
    replacement.dataset.root = 'root.one'
    currentRoot = replacement
    await expect(mismatched.request({
      ...base('stale-root'),
      type: 'acquire',
      capability: 'ui.host-dom.read',
      rootId: 'root.one',
      operations: ['read-text'],
    })).resolves.toMatchObject({ status: 'unavailable', code: 'not-mounted' })
    client.dispose()
    mismatched.dispose()
    authority.dispose()
    dom.window.close()
  })

  it('reserves the handle cap across concurrent authorization and validates only a cloned getter snapshot', async () => {
    const dom = new JSDOM('<body><main data-root="root.one"></main><aside data-root="root.two"></aside></body>')
    const activeLeases = new Set<string>()
    const authorizations: Array<(decision: HostDomPermissionAccessDecision) => void> = []
    const authority = new HostDomAuthority({
      hostGeneration: 'host-1',
      isolatedPluginBoundary: true,
      roots: roots(dom.window.document),
    })
    const client = authority.bind({
      ownerKey: 'https://plugins.example/demo\u0000demo',
      profileId: 'work',
      identity: { source: 'https://plugins.example/demo', pluginId: 'demo' },
      runtimeGeneration: 'runtime-1',
      moduleGeneration: 'module-1',
      state: () => 'active',
      authorize: async () => await new Promise(resolve => authorizations.push(resolve)),
      leaseActive: id => activeLeases.has(id),
      subscribeInvalidation: () => () => undefined,
    })
    const pending = Array.from({ length: 33 }, (_, index) =>
      client.request({
        ...base(`cap-${index}`),
        type: 'acquire',
        capability: 'ui.host-dom.read',
        rootId: 'root.one',
        operations: ['read-text'],
      }))
    await vi.waitFor(() => expect(authorizations).toHaveLength(32))
    await expect(pending[32]).resolves.toMatchObject({ status: 'denied', code: 'permission-denied' })
    authorizations.forEach((resolve, index) => {
      const id = `lease-cap-${index}`
      activeLeases.add(id)
      resolve(acceptedLease('ui.host-dom.read', id))
    })
    expect((await Promise.all(pending.slice(0, 32))).filter(item => item.status === 'accepted')).toHaveLength(32)
    client.dispose()
    authority.dispose()

    const getterOwner = binding()
    const getterAuthority = new HostDomAuthority({
      hostGeneration: 'host-1',
      isolatedPluginBoundary: true,
      roots: roots(dom.window.document),
    })
    const getterClient = getterAuthority.bind(getterOwner.value)
    let getterReads = 0
    const getterRequest = {
      ...base('getter-snapshot'),
      type: 'acquire',
      capability: 'ui.host-dom.read',
      rootId: 'root.one',
      get operations() {
        getterReads += 1
        return getterReads === 1 ? ['read-text'] : ['set-text']
      },
    } as unknown as HostDomBridgeRequest
    await expect(getterClient.request(getterRequest)).resolves.toMatchObject({
      status: 'accepted',
      capability: 'ui.host-dom.read',
      operations: ['read-text'],
    })
    expect(getterReads).toBe(1)
    getterClient.dispose()
    getterAuthority.dispose()
    dom.window.close()
  })

  it('creates only Host-owned structured children and cleans them on disable/uninstall invalidation', async () => {
    const dom = new JSDOM(
      '<body><main data-root="root.one"><div id="seat"></div></main><aside data-root="root.two"></aside></body>',
    )
    const owner = binding()
    const authority = new HostDomAuthority({
      hostGeneration: 'host-1',
      isolatedPluginBoundary: true,
      roots: roots(dom.window.document),
    })
    const client = authority.bind(owner.value)
    const read = await client.request({
      ...base('read'),
      type: 'acquire',
      capability: 'ui.host-dom.read',
      rootId: 'root.one',
      operations: ['inspect-structure'],
    })
    if (read.status !== 'accepted' || read.type !== 'acquire') throw new Error('read handle expected')
    const structure = await client.request({
      ...base('inspect'),
      type: 'read',
      handle: read.handle,
      operation: 'inspect-structure',
    })
    const seat = nodeFrom(structure, 1)
    const modify = await client.request({
      ...base('modify'),
      type: 'acquire',
      capability: 'ui.host-dom.modify',
      rootId: 'root.one',
      operations: ['insert-owned-structured-child'],
    })
    if (modify.status !== 'accepted' || modify.type !== 'acquire') throw new Error('modify handle expected')
    const inserted = await client.request({
      ...base('insert'),
      type: 'modify',
      handle: modify.handle,
      node: seat,
      operation: 'insert-owned-structured-child',
      child: {
        id: 'owned.action',
        kind: 'action',
        label: { key: 'run', fallback: 'Run' },
        command: { id: 'demo.run', arguments: { value: 1 } },
      },
    })
    expect(inserted).toEqual(expect.objectContaining({ status: 'accepted', changed: true, ownedChild: 'owned.action' }))
    const action = dom.window.document.querySelector<HTMLButtonElement>('[data-cordisx-host-dom-child="owned.action"]')!
    action.click()
    expect(owner.value.invokeCommand).toHaveBeenCalledWith('demo.run', { value: 1 })
    expect(action.getAttribute('style')).toBeNull()
    expect(action.getAttribute('onclick')).toBeNull()

    owner.setState('disabled')
    expect(dom.window.document.querySelector('[data-cordisx-host-dom-child]')).toBeNull()
    await expect(client.request({ ...base('stale'), type: 'release', handle: modify.handle })).resolves.toMatchObject({
      status: 'unavailable',
      code: 'stale-handle',
    })
    client.dispose()
    authority.dispose()
    dom.window.close()
  })

  it('actively rolls back owned children and command callbacks on Host generation replacement', async () => {
    const dom = new JSDOM(
      '<body><main data-root="root.one"><div id="seat"></div></main><aside data-root="root.two"></aside></body>',
    )
    const owner = binding()
    let hostGeneration = 'host-1'
    const generationListeners = new Set<() => void>()
    const authority = new HostDomAuthority({
      hostGeneration: 'host-1',
      currentHostGeneration: () => hostGeneration,
      subscribeHostGenerationInvalidation: listener => {
        generationListeners.add(listener)
        return () => generationListeners.delete(listener)
      },
      isolatedPluginBoundary: true,
      roots: roots(dom.window.document),
    })
    const client = authority.bind(owner.value)
    const read = await client.request({
      ...base('generation-read'),
      type: 'acquire',
      capability: 'ui.host-dom.read',
      rootId: 'root.one',
      operations: ['inspect-structure'],
    })
    if (read.status !== 'accepted' || read.type !== 'acquire') throw new Error('read handle expected')
    const structure = await client.request({
      ...base('generation-inspect'),
      type: 'read',
      handle: read.handle,
      operation: 'inspect-structure',
    })
    const seat = nodeFrom(structure, 1)
    const modify = await client.request({
      ...base('generation-modify'),
      type: 'acquire',
      capability: 'ui.host-dom.modify',
      rootId: 'root.one',
      operations: ['insert-owned-structured-child'],
    })
    if (modify.status !== 'accepted' || modify.type !== 'acquire') throw new Error('modify handle expected')
    await client.request({
      ...base('generation-insert'),
      type: 'modify',
      handle: modify.handle,
      node: seat,
      operation: 'insert-owned-structured-child',
      child: {
        id: 'owned.generation-action',
        kind: 'action',
        label: { key: 'run', fallback: 'Run' },
        command: { id: 'demo.run' },
      },
    })
    const action = dom.window.document.querySelector<HTMLButtonElement>(
      '[data-cordisx-host-dom-child="owned.generation-action"]',
    )!
    action.click()
    expect(owner.value.invokeCommand).toHaveBeenCalledTimes(1)
    hostGeneration = 'host-2'
    for (const listener of generationListeners) listener()
    expect(action.isConnected).toBe(false)
    action.click()
    expect(owner.value.invokeCommand).toHaveBeenCalledTimes(1)
    client.dispose()
    authority.dispose()
    dom.window.close()
  })
})
