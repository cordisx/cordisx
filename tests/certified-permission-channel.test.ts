import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CORDISX_CERTIFIED_PERMISSION_PROJECTION_SCHEMA_V1,
  type CordisXCertifiedPermissionProjectionV1,
} from '../packages/cli/src/permission-contracts.js'
import { sha256Hex } from '../packages/cli/src/permission-model-v2.js'
import {
  CERTIFIED_PERMISSION_CHANNEL_CONTRACT,
  certifiedPermissionEndpointTakeKey,
  createCertifiedPermissionDocumentChannel,
} from '../packages/cli/src/renderer/certified-permission-channel.js'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  createBrandMarkElement: (document: Document, className?: string) => {
    const mark = document.createElement('span')
    if (className !== undefined) mark.className = className
    return mark
  },
  BrandMark: () => null,
  AnimatedBrandMark: () => null,
}))

const profileId = 'work'
const runtimeGeneration = 'runtime-1'
const token = 'a'.repeat(64)
const digest = `sha256:${'b'.repeat(64)}` as const

interface Snapshot {
  readonly revision: number
  readonly projections: readonly CordisXCertifiedPermissionProjectionV1[]
}

interface Endpoint {
  describe(): Readonly<{
    contract: string
    profileId: string
    runtimeGeneration: string
    documentEpoch: string
  }>
  deliver(payload: unknown): Readonly<{
    documentEpoch: string
    deliverySequence: number
    authorityRevision: number
  }>
  close(): boolean
}

function certification(): CordisXCertifiedPermissionProjectionV1 {
  const payload = {
    source: 'https://plugins.example/certified-channel',
    pluginId: 'certified-channel',
    version: '1.2.3',
    integrity: digest,
    reviewPolicy: { id: 'cordisx-marketplace-review' as const, version: '1.0.0' },
    reviewedAt: '2026-08-29T00:00:00.000Z',
    expiresAt: '2026-09-30T00:00:00.000Z',
    evidence: {
      kind: 'protected-marketplace-review' as const,
      reference: 'https://github.com/cordisx/marketplace/pull/197',
    },
    feed: {
      generatedAt: '2026-08-30T00:00:00.000Z',
      root: 'https://marketplace.example/feed.json',
      authority: 'cordisx.marketplace.codeowners/v1' as const,
    },
  }
  return {
    $schema: CORDISX_CERTIFIED_PERMISSION_PROJECTION_SCHEMA_V1,
    schemaVersion: 1,
    kind: 'cordisx-certified-permission-eligibility',
    status: 'active',
    ...payload,
    fingerprint: `sha256:${sha256Hex(JSON.stringify(payload))}`,
    revision: payload.feed.generatedAt,
  }
}

function envelope(input: Readonly<{
  documentEpoch: string
  deliverySequence?: number
  authorityRevision?: number
  snapshot?: Snapshot
  profileId?: string
  runtimeGeneration?: string
}>): string {
  const authorityRevision = input.authorityRevision ?? input.snapshot?.revision ?? 1
  return JSON.stringify({
    contract: CERTIFIED_PERMISSION_CHANNEL_CONTRACT,
    profileId: input.profileId ?? profileId,
    runtimeGeneration: input.runtimeGeneration ?? runtimeGeneration,
    documentEpoch: input.documentEpoch,
    deliverySequence: input.deliverySequence ?? 1,
    authorityRevision,
    snapshot: input.snapshot ?? { revision: authorityRevision, projections: [certification()] },
  })
}

function setup(input: Readonly<{
  initialHandshakeTimeoutMs?: number
  heartbeatTimeoutMs?: number
}> = {}) {
  const replacements: Snapshot[] = []
  let clears = 0
  const globals = globalThis as typeof globalThis & Record<string, unknown>
  const channel = createCertifiedPermissionDocumentChannel({
    token,
    profileId,
    runtimeGeneration,
    sink: {
      replaceCertifiedPermissionSnapshot: snapshot => { replacements.push(snapshot) },
      clearCertifiedPermissionSnapshot: () => { clears += 1 },
    },
    now: () => new Date('2026-08-30T12:00:00.000Z'),
    ...input,
  })
  const takeKey = certifiedPermissionEndpointTakeKey(token)
  const take = globals[takeKey] as (() => Endpoint | undefined) | undefined
  return {
    channel,
    globals,
    takeKey,
    take,
    replacements,
    clears: () => clears,
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  const globals = globalThis as typeof globalThis & Record<string, unknown>
  Reflect.deleteProperty(globals, certifiedPermissionEndpointTakeKey(token))
  Reflect.deleteProperty(globals, '__cordisxBoot')
  Reflect.deleteProperty(globals, '__cordisxBootGeneration')
  Reflect.deleteProperty(globals, '__cordisxRequestedGeneration')
  Reflect.deleteProperty(globals, '__cordisxRuntime')
})

describe('renderer Certified permission document channel', () => {
  it('exposes one exact endpoint description and makes the take capability one-shot', () => {
    const context = setup()
    expect(context.take).toBeTypeOf('function')

    const endpoint = context.take?.()
    expect(endpoint?.describe()).toEqual({
      contract: CERTIFIED_PERMISSION_CHANNEL_CONTRACT,
      profileId,
      runtimeGeneration,
      documentEpoch: context.channel.documentEpoch,
    })
    expect(endpoint).toBeDefined()
    expect(Object.hasOwn(context.globals, context.takeKey)).toBe(false)
    expect(context.take?.()).toBeUndefined()
    context.channel.dispose()
  })

  it.each([
    ['profile', { profileId: 'other' }],
    ['runtime generation', { runtimeGeneration: 'runtime-2' }],
    ['document', { documentEpoch: 'different_document_epoch_1234' }],
  ] as const)('rejects a forged %s binding and clears any prior snapshot', (_case, mutation) => {
    const context = setup()
    const endpoint = context.take?.()
    expect(endpoint).toBeDefined()
    const initial = envelope({ documentEpoch: context.channel.documentEpoch })
    endpoint!.deliver(initial)
    expect(context.replacements).toHaveLength(1)

    const forgedDocument = 'documentEpoch' in mutation ? mutation.documentEpoch : context.channel.documentEpoch
    const forged = envelope({
      documentEpoch: forgedDocument,
      ...('profileId' in mutation ? { profileId: mutation.profileId } : {}),
      ...('runtimeGeneration' in mutation ? { runtimeGeneration: mutation.runtimeGeneration } : {}),
      deliverySequence: 2,
    })
    expect(() => endpoint!.deliver(forged)).toThrow(/rejected|stale or invalid/)
    expect(context.clears()).toBe(1)
    context.channel.dispose()
  })

  it('fences sequence and authority revision while allowing an identical same-revision heartbeat', () => {
    const context = setup()
    const endpoint = context.take?.()
    const snapshot = { revision: 4, projections: [certification()] } as const

    expect(endpoint!.deliver(envelope({
      documentEpoch: context.channel.documentEpoch,
      deliverySequence: 1,
      snapshot,
    }))).toMatchObject({ deliverySequence: 1, authorityRevision: 4 })

    expect(() => endpoint!.deliver(envelope({
      documentEpoch: context.channel.documentEpoch,
      deliverySequence: 1,
      snapshot,
    }))).toThrow(/stale or invalid/)
    expect(context.clears()).toBe(1)

    expect(endpoint!.deliver(envelope({
      documentEpoch: context.channel.documentEpoch,
      deliverySequence: 2,
      snapshot,
    }))).toMatchObject({ deliverySequence: 2, authorityRevision: 4 })
    expect(context.replacements).toHaveLength(2)

    expect(() => endpoint!.deliver(envelope({
      documentEpoch: context.channel.documentEpoch,
      deliverySequence: 3,
      authorityRevision: 3,
      snapshot: { revision: 3, projections: [certification()] },
    }))).toThrow(/stale or invalid/)
    expect(context.clears()).toBe(2)

    expect(() => endpoint!.deliver(envelope({
      documentEpoch: context.channel.documentEpoch,
      deliverySequence: 4,
      authorityRevision: 4,
      snapshot: { revision: 4, projections: [] },
    }))).toThrow(/equivocated/)
    expect(context.clears()).toBe(3)
    context.channel.dispose()
  })

  it('fails closed on heartbeat timeout and endpoint close', async () => {
    vi.useFakeTimers()
    const context = setup({ initialHandshakeTimeoutMs: 50, heartbeatTimeoutMs: 100 })
    const endpoint = context.take?.()
    endpoint!.deliver(envelope({ documentEpoch: context.channel.documentEpoch }))
    await context.channel.ready

    await vi.advanceTimersByTimeAsync(100)
    expect(context.clears()).toBe(1)
    expect(endpoint!.close()).toBe(true)
    expect(context.clears()).toBe(2)
    expect(() => endpoint!.deliver(envelope({
      documentEpoch: context.channel.documentEpoch,
      deliverySequence: 2,
    }))).toThrow(/rejected/)
  })

  it('disposes the ready channel when a later renderer bootstrap step fails', async () => {
    const { installCordisX } = await import('../packages/cli/src/renderer/runtime.js')
    const dom = new JSDOM('<html lang="en"><head></head><body></body></html>', {
      pretendToBeVisual: true,
      url: 'https://codex.local/',
    })
    const browser = dom.window
    vi.stubGlobal('window', browser)
    vi.stubGlobal('document', browser.document)
    vi.stubGlobal('history', browser.history)
    vi.stubGlobal('location', browser.location)
    vi.stubGlobal('navigator', browser.navigator)
    vi.stubGlobal('localStorage', browser.localStorage)
    vi.stubGlobal('HTMLElement', browser.HTMLElement)
    vi.stubGlobal('Element', browser.Element)
    vi.stubGlobal('Node', browser.Node)
    vi.stubGlobal('Event', browser.Event)
    vi.stubGlobal('CustomEvent', browser.CustomEvent)
    vi.stubGlobal('MutationObserver', browser.MutationObserver)
    vi.stubGlobal('getComputedStyle', browser.getComputedStyle.bind(browser))
    vi.stubGlobal('requestAnimationFrame', browser.requestAnimationFrame.bind(browser))
    vi.stubGlobal('cancelAnimationFrame', browser.cancelAnimationFrame.bind(browser))
    const internalBootstrap = vi.fn(async () => {
      throw new Error('fixture post-channel bootstrap failure')
    })
    const boot = installCordisX([], {
      version: 'test',
      providers: [],
      profileId,
      generation: runtimeGeneration,
      certifiedPermissionChannelToken: token,
    }, internalBootstrap)
    const globals = globalThis as typeof globalThis & Record<string, unknown>
    const takeKey = certifiedPermissionEndpointTakeKey(token)
    for (let attempt = 0; attempt < 100 && typeof globals[takeKey] !== 'function'; attempt += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    const take = globals[takeKey] as (() => Endpoint | undefined) | undefined
    const endpoint = take?.()
    expect(endpoint).toBeDefined()
    endpoint!.deliver(envelope({
      documentEpoch: endpoint!.describe().documentEpoch,
      snapshot: { revision: 1, projections: [] },
    }))

    await expect(boot).rejects.toThrow('fixture post-channel bootstrap failure')
    expect(internalBootstrap).toHaveBeenCalledOnce()
    expect(() => endpoint!.deliver(envelope({
      documentEpoch: endpoint!.describe().documentEpoch,
      deliverySequence: 2,
      snapshot: { revision: 2, projections: [] },
    }))).toThrow(/rejected/)
    dom.window.close()
  }, 60_000)
})
