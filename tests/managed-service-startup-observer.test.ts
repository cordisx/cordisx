import { describe, expect, it } from 'vitest'
import type { StartupEventV1 } from '@cordisx/protocol/startup/v1'
import { createStartupObserverSource } from '../packages/cli/src/launcher/managed-service-startup-observer.js'

describe('startup observer replay and scope lifetime', () => {
  it('repairs expired/future/epoch cursors and permits no event after scope closure', async () => {
    let changed = () => {}
    const source = createStartupObserverSource({
      scopeId: 'scope',
      hostGeneration: 'host',
      historyLimit: 2,
      read: () => ({ entries: [], pages: [] }),
      subscribe: listener => {
        changed = listener
        return () => {}
      },
    })
    const initial = await source.observer.read()
    changed()
    changed()
    changed()
    const events: StartupEventV1[] = []
    const old = await source.observer.subscribe(event => events.push(event), { after: initial.cursor })
    expect(events[0]).toMatchObject({ kind: 'snapshot', reason: 'gap', snapshot: { cursor: { sequence: 3 } } })
    old.close()
    const future: StartupEventV1[] = []
    await source.observer.subscribe(event => future.push(event), { after: { ...initial.cursor, sequence: 99 } })
    expect(future[0]).toMatchObject({ reason: 'gap' })
    const replacement: StartupEventV1[] = []
    await source.observer.subscribe(event => replacement.push(event), { after: { ...initial.cursor, epoch: 'old' } })
    expect(replacement[0]).toMatchObject({ reason: 'epoch-changed' })
    source.close('scope-revoked')
    changed()
    source.close('host-replaced')
    expect(replacement.filter(event => event.kind === 'closed')).toHaveLength(1)
    await expect(source.observer.read()).rejects.toThrow('scope-revoked')
  })

  it('delivers replay before reentrant live updates without dropping a sequence', async () => {
    let changed = () => {}
    const source = createStartupObserverSource({
      scopeId: 'scope',
      hostGeneration: 'host',
      read: () => ({ entries: [], pages: [] }),
      subscribe: listener => {
        changed = listener
        return () => {}
      },
    })
    const initial = await source.observer.read()
    changed()
    changed()
    const seen: number[] = []
    await source.observer.subscribe(event => {
      if (event.kind !== 'snapshot') return
      seen.push(event.snapshot.cursor.sequence)
      if (event.snapshot.cursor.sequence === 1) changed()
    }, { after: initial.cursor })
    expect(seen).toEqual([1, 2, 3])
    source.close('host-replaced')
  })
})
