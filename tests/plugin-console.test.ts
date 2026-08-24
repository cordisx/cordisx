import { describe, expect, it, vi } from 'vitest'
import {
  PluginConsoleAspect,
  formatConsoleMessage,
  snapshotConsoleValue,
  type PluginPrincipalToken,
} from '../packages/cli/src/renderer/plugin-console.js'

const alpha = { source: 'file:///alpha.ts', id: 'alpha' } as const
const beta = { source: 'file:///beta.ts', id: 'beta' } as const

describe('plugin DevTools Console aspect', () => {
  it('keeps native variadic Console semantics and safely snapshots hostile values', () => {
    const circular: Record<string, unknown> = { value: 1n }
    circular.self = circular
    let getterReads = 0
    const getter = Object.defineProperty({}, 'secret', { enumerable: true, get: () => { getterReads += 1; return 'no' } })
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error('proxy trap') } })
    const snapshots = [
      snapshotConsoleValue('x=%d %s %%'),
      snapshotConsoleValue(4),
      snapshotConsoleValue('ok'),
      snapshotConsoleValue(circular),
      snapshotConsoleValue(new Error('boom')),
      snapshotConsoleValue(getter),
      snapshotConsoleValue(hostile),
      snapshotConsoleValue(function sample() {}),
    ]

    expect(formatConsoleMessage(snapshots)).toContain('x=4 ok %')
    expect(snapshots[3]?.entries?.find(item => item.key === 'self')?.value.type).toBe('circular')
    expect(snapshots[4]).toMatchObject({ type: 'error', name: 'Error', preview: 'Error: boom' })
    expect(snapshots[5]?.entries?.[0]?.value).toMatchObject({ type: 'unavailable', preview: '[Getter/Setter]' })
    expect(snapshots[6]).toMatchObject({ type: 'unavailable', preview: '[unavailable proxy]' })
    expect(snapshots[7]).toMatchObject({ type: 'function', name: 'sample' })
    expect(getterReads).toBe(0)
  })

  it('binds owner at issuance and correlates permission, dispatch, and a real terminal result', async () => {
    let now = 100
    const aspect = new PluginConsoleAspect('runtime-1', 50, () => now++)
    const token = aspect.issue(alpha, 'runtime-1:alpha:1')
    const value = await aspect.run(token, 'platform.models.list', { providerIds: ['local'] }, async invocation => {
      aspect.permission(alpha, 'models.read', 'ask', 'permission requested')
      aspect.permission(alpha, 'models.read', 'allow', 'permission allowed')
      invocation.dispatch('adapter dispatch')
      return { ok: true, value: { models: [{ id: 'one' }] } }
    })

    expect(value).toMatchObject({ ok: true })
    const page = aspect.query(alpha)
    expect(page.entries.map(entry => entry.phase)).toEqual(['requested', 'ask', 'allow', 'dispatch', 'success'])
    expect(new Set(page.entries.map(entry => entry.correlationId))).toHaveLength(1)
    expect(page.entries.at(-1)).toMatchObject({ status: 'success', coverage: 'host-mediated' })
    expect(aspect.query(beta).entries).toEqual([])
  })

  it('does not accept a forged principal and a leaked facade remains charged to its issuer', () => {
    const aspect = new PluginConsoleAspect('runtime-1')
    const alphaToken = aspect.issue(alpha, 'runtime-1:alpha:1')
    aspect.issue(beta, 'runtime-1:beta:1')
    const facade = aspect.consoleFacade(alphaToken)
    facade.info('borrowed by beta', { owner: 'beta', generation: 'forged' })

    expect(aspect.query(alpha).entries).toHaveLength(1)
    expect(aspect.query(beta).entries).toHaveLength(0)
    expect(() => aspect.owner(Object.freeze({}) as PluginPrincipalToken)).toThrow(/stale or invalid/)
  })

  it('generation-fences callbacks and stops scoped console capture after dispose', () => {
    const aspect = new PluginConsoleAspect('runtime-1')
    const token = aspect.issue(alpha, 'runtime-1:alpha:1')
    const facade = aspect.consoleFacade(token)
    const callback = aspect.wrapCallback(token, 'commands:alpha:run', () => facade.log('inside callback'))
    callback()
    aspect.deactivate(token)
    expect(() => callback()).toThrow(/stale or invalid/)
    facade.warn('after dispose')
    expect(aspect.query(alpha).entries.filter(entry => entry.message === 'after dispose')).toHaveLength(0)
  })

  it('omits an ambiguous correlation instead of cross-linking concurrent async work', async () => {
    const aspect = new PluginConsoleAspect('runtime-1')
    const token = aspect.issue(alpha, 'runtime-1:alpha:1')
    const facade = aspect.consoleFacade(token)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = aspect.run(token, 'platform.tasks.list', {}, async () => { await gate; facade.info('first'); return { ok: true } })
    const second = aspect.run(token, 'platform.models.list', {}, async () => { facade.info('overlap'); return { ok: true } })
    await second
    release()
    await first

    const overlap = aspect.query(alpha).entries.find(entry => entry.message === 'overlap')
    expect(overlap?.coverage).toBe('scoped-console')
    expect(overlap?.correlationId).toBeUndefined()
  })

  it('does not monkey-patch the renderer global console', () => {
    const original = globalThis.console.log
    const spy = vi.spyOn(globalThis.console, 'log').mockImplementation(() => {})
    const aspect = new PluginConsoleAspect('runtime-1')
    const token = aspect.issue(alpha, 'runtime-1:alpha:1')
    aspect.consoleFacade(token).log('plugin')
    expect(globalThis.console.log).toBe(spy)
    spy.mockRestore()
    expect(globalThis.console.log).toBe(original)
  })

  it('counts shared error-boundary failures without guessing a plugin owner', () => {
    const aspect = new PluginConsoleAspect('runtime-1')
    aspect.issue(alpha, 'runtime-1:alpha:1')
    aspect.recordUnattributedError('error')
    aspect.recordUnattributedError('error')
    aspect.recordUnattributedError('unhandledrejection')
    expect(aspect.query(alpha)).toMatchObject({ unattributedEntries: 2, entries: [] })
  })
})
