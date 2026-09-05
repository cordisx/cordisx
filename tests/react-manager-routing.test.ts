import { describe, expect, it } from 'vitest'
import type { CordisXRouteReference } from '../packages/cli/src/contracts.js'
import { projectManagerContentBreadcrumbs } from '../packages/cli/src/renderer/manager/model/manager-content-breadcrumbs.js'
import type { ManagerContentPresentation } from '../packages/cli/src/renderer/navigation.js'

describe('React Manager plugin route breadcrumbs', () => {
  it('projects every plugin-declared parent route instead of special-casing a contribution', () => {
    const presentations = new Map<string, ManagerContentPresentation>([
      ['settings', { title: 'Channels', description: '', tabs: [] }],
      ['account', { title: 'Demo account', description: '', parent: { id: 'settings' }, tabs: [] }],
      ['logs', { title: 'Logs', description: '', parent: { id: 'account', params: { accountId: 'demo' } }, tabs: [] }],
    ])
    const current: CordisXRouteReference = { id: 'logs', params: { accountId: 'demo' } }

    expect(projectManagerContentBreadcrumbs({
      current,
      root: { id: 'settings' },
      rootLabel: '渠道',
      presentation: reference => presentations.get(reference.id),
    })).toEqual([
      { label: '渠道', reference: { id: 'settings' } },
      { label: 'Demo account', reference: { id: 'account', params: { accountId: 'demo' } } },
      { label: 'Logs', reference: current },
    ])
  })

  it('stops safely when a plugin declares a cyclic parent route', () => {
    expect(
      projectManagerContentBreadcrumbs({
        current: { id: 'child' },
        rootLabel: 'Plugin',
        presentation: reference => ({
          title: reference.id,
          description: '',
          parent: { id: reference.id === 'child' ? 'parent' : 'child' },
          tabs: [],
        }),
      }).map(segment => segment.label),
    ).toEqual(['parent', 'child'])
  })
})
