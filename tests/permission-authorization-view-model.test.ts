import { describe, expect, it } from 'vitest'
import {
  CapabilityRiskCatalog,
  HOST_CAPABILITY_RISK_ENTRIES,
  buildPermissionAuthorizationPlanV2,
} from '../packages/cli/src/capability-risk-catalog.js'
import {
  PermissionAuthorizationViewModel,
  type PermissionAuthorizationProjectionInput,
} from '../packages/cli/src/permission-authorization-view-model.js'
import { CORDISX_PERMISSION_LOCALE_CATALOGS } from '../packages/cli/src/permission-locales.js'
import type { CordisXCapabilityDeclarationV2 } from '../packages/cli/src/permission-contracts.js'

const identity = { source: 'file:///plugins/demo.js', pluginId: 'demo' } as const

function resolve(locale: 'en' | 'zh-CN') {
  const catalog = CORDISX_PERMISSION_LOCALE_CATALOGS.find(item => item.locale === locale)!
  return (message: { readonly key: string; readonly fallback?: string }) => (
    catalog.messages[message.key] ?? message.fallback ?? `[[${message.key}]]`
  )
}

function declaration(
  name: CordisXCapabilityDeclarationV2['name'],
  required: boolean,
  scope: CordisXCapabilityDeclarationV2['scope'],
): CordisXCapabilityDeclarationV2 {
  return {
    name,
    required,
    rationale: {
      title: { key: `${name}.title`, fallback: 'Why this plugin asks' },
      description: { key: `${name}.description`, fallback: 'The plugin uses this for its task timeline.' },
      feature: { key: `${name}.feature`, fallback: 'Task timeline' },
      deniedBehavior: { key: `${name}.denied`, fallback: 'The timeline remains unavailable.' },
    },
    security: { dataUse: 'ephemeral', retention: 'runtime', externalTransfer: false },
    scope,
  }
}

function model() {
  return new PermissionAuthorizationViewModel(buildPermissionAuthorizationPlanV2({
    planId: 'permission-plan-1',
    operation: 'install',
    profileId: 'work',
    identity,
    binding: {
      operationId: 'install:demo:1',
      runtimeGeneration: 'runtime-1',
      moduleGeneration: 'demo-1',
      requestId: 'request-1',
    },
    declarations: [
      declaration('models.read', true, {}),
      declaration('agent.events.read', false, { sessionIds: ['session-1'] }),
      declaration('tasks.control', true, {
        sessions: [{ providerId: 'codex', remoteSessionId: 'thread-1' }],
      }),
    ],
    policies: [],
    contextFor: item => ({
      operation: 'install',
      providerKind: item.name.startsWith('agent.') ? 'host-local' : 'current-connection',
      providerTrust: item.name === 'tasks.control' ? 'unverified' : 'native',
      availability: item.name === 'agent.events.read' ? 'unavailable' : 'supported',
    }),
  }))
}

function projectionInput(locale: 'en' | 'zh-CN'): PermissionAuthorizationProjectionInput {
  return {
    plugin: {
      name: 'Demo',
      source: 'file:///plugins/demo.js',
      trust: 'unverified',
      icon: 'host-token:plugin',
    },
    availability: {
      'models.read': {
        status: 'supported',
        reason: { key: 'models-available', fallback: 'The current connection is available.' },
        providerIds: ['desktop-current'],
      },
      'agent.events.read': {
        status: 'unavailable',
        reason: { key: 'events-unavailable', fallback: 'No matching event provider is active.' },
        providerIds: ['host-agent-events'],
      },
    },
    resolve: resolve(locale),
    scope: scope => JSON.stringify(scope),
    requestSource: 'package-install',
  }
}

describe('permission authorization information architecture', () => {
  it('projects one dialog heading, flat capability items, and separately labelled plugin rationale', () => {
    const projection = model().project(projectionInput('en'))
    expect(projection.heading).toBe('Review permissions before installing')
    expect(projection.items).toHaveLength(3)
    expect(projection.items.map(item => item.name)).not.toContain(projection.heading)
    expect(projection.items.every(item => item.rationale?.label === 'Plugin-provided explanation')).toBe(true)
    expect(projection.items[0]).toMatchObject({
      requirement: 'Required',
      sensitivity: 'Low risk',
      reviewMode: 'batch-eligible',
      reviewModeLabel: 'Batch review',
      authorizationLabel: 'Authorization method',
      denialImpact: 'The plugin will be blocked because this permission is required.',
    })
    expect(projection.actions).toEqual({
      cancel: 'Cancel',
      confirm: 'Confirm',
      manage: 'Manage plugin permissions',
    })
  })

  it('keeps availability orthogonal to policy selection and forbids persistent high-risk grants', () => {
    const projection = model().project(projectionInput('en'))
    const unavailable = projection.items.find(item => item.capability === 'agent.events.read')!
    expect(unavailable.availability).toMatchObject({ status: 'unavailable', statusLabel: 'Unavailable now' })
    expect(unavailable.authorizationOptions).toHaveLength(4)
    expect(unavailable.authorizationOptions.find(item => item.value === 'allow-once')?.selected).toBe(true)
    const highRisk = projection.items.find(item => item.capability === 'tasks.control')!
    expect(highRisk.sensitivity).toBe('High risk')
    expect(highRisk).toMatchObject({ reviewMode: 'explicit', reviewModeLabel: 'Explicit review' })
    expect(highRisk.authorizationOptions.map(item => item.value)).not.toContain('allow-persistent')
    expect(highRisk.authorizationOptions.find(item => item.value === 'deny-once')?.selected).toBe(true)
  })

  it('reprojects locale without losing the request or selected authorization lifetime', () => {
    const viewModel = model()
    viewModel.select('agent.events.read', 'deny-persistent')
    const english = viewModel.project(projectionInput('en'))
    const chinese = viewModel.project(projectionInput('zh-CN'))
    expect(english.heading).toBe('Review permissions before installing')
    expect(chinese.heading).toBe('安装前确认权限')
    expect(chinese.items.find(item => item.capability === 'agent.events.read')?.name).toBe('读取 Agent 事件')
    expect(chinese.items.find(item => item.capability === 'agent.events.read')?.authorizationOptions)
      .toContainEqual({ value: 'deny-persistent', label: '始终拒绝', selected: true })
    expect(viewModel.plan.planId).toBe('permission-plan-1')
  })

  it('returns one exact bound decision document and settles only once', () => {
    const viewModel = model()
    viewModel.select('models.read', 'allow-once')
    const result = viewModel.confirm()
    expect(result).toMatchObject({
      status: 'confirmed',
      decision: {
        planId: 'permission-plan-1',
        profileId: 'work',
        identity,
        binding: { operationId: 'install:demo:1', runtimeGeneration: 'runtime-1', requestId: 'request-1' },
      },
    })
    if (result.status !== 'confirmed') throw new Error('expected a confirmed result')
    expect(result.decision.decisions).toHaveLength(3)
    expect(result.decision.decisions[0]).toMatchObject({ capability: 'models.read', decision: 'allow-once' })
    expect(() => viewModel.confirm()).toThrow('already settled')
  })

  it('has complete English and Chinese Host copy for every catalog capability', () => {
    for (const locale of ['en', 'zh-CN'] as const) {
      const catalog = CORDISX_PERMISSION_LOCALE_CATALOGS.find(item => item.locale === locale)!
      for (const entry of HOST_CAPABILITY_RISK_ENTRIES) {
        for (const message of Object.values(entry.presentation)) {
          expect(catalog.messages[message.key], `${locale}/${message.key}`).toBeTypeOf('string')
        }
      }
    }
    expect(new CapabilityRiskCatalog().snapshot()).toHaveLength(HOST_CAPABILITY_RISK_ENTRIES.length)
  })
})
