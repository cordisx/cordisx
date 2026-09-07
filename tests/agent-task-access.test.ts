import { expect, test, vi } from 'vitest'
import { AgentRouteSessionScopeAuthority } from '../packages/cli/src/renderer/agent-route-session-scope.js'
import { CordisXAgentSessionRuntime } from '../packages/cli/src/renderer/agent-session-runtime.js'

test('task preflight checks current declarations without inventing a Session permission; exact authorization still denies', async () => {
  const owner = { pluginId: 'file:///task-plugin.js:tasks', generation: 1 }
  const decide = vi.fn(async () => ({ authorized: false }))
  const scope = new AgentRouteSessionScopeAuthority({
    activeRoute: () => undefined,
    routes: () => [],
    decide,
    connectionGeneration: () => 1,
  })
  // These are the existing required creation/status capabilities. No Session event read is used.
  scope.install(
    owner,
    ['agents.create', 'agents.message.submit', 'agents.get'].map(name => ({
      manifestVersion: 8 as const,
      name: name as 'agents.create' | 'agents.message.submit' | 'agents.get',
      required: true,
      scope: {},
    })),
  )
  const authorize = vi.fn(scope.authorize.bind(scope))
  const runtime = new CordisXAgentSessionRuntime({
    driver: {
      create: vi.fn(async () => ({ status: 'unavailable', code: 'unsupported' } as const)),
      resume: async () => ({ status: 'unavailable', code: 'unsupported' }),
      submit: async () => 'unsupported',
      discard: async () => 'unsupported',
      cancel: async () => 'unsupported',
      onReplacement: () => () => {},
      dispose: () => {},
    },
    authorize,
    declares: scope.declares.bind(scope),
  })
  try {
    expect(await runtime.authorizeTask(owner, 'create')).toBe(true)
    expect(await runtime.authorizeTask(owner, 'read')).toBe(true)
    expect(await runtime.authorizeTask(owner, 'approval')).toBe(false)
    expect(await runtime.authorizeTask({ ...owner, generation: 2 }, 'create')).toBe(false)
    expect(authorize).not.toHaveBeenCalled()
    expect(decide).not.toHaveBeenCalled()
    expect(await runtime.authorizeTask(owner, 'create', 'reserved-session')).toBe(false)
    expect(authorize).toHaveBeenCalledWith(owner, 'agents.create', 'reserved-session')
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'agents.create',
      scopeSource: { kind: 'host-create', reservedSessionId: 'reserved-session' },
    }))
    expect(await runtime.authorizeTask(owner, 'read', 'known-session')).toBe(false)
    expect(authorize).toHaveBeenLastCalledWith(owner, 'agents.get', 'known-session')
    scope.uninstall(owner)
    expect(await runtime.authorizeTask(owner, 'create')).toBe(false)
  } finally {
    await runtime.dispose()
  }
})
