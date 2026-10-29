import type { spawn as nodeSpawn } from 'node:child_process'
import { expect, it } from 'vitest'
import { declaration, definition, fixture, owner, runtime, syntheticChild } from './managed-service-runtime-fixture.js'

it('retains the exact owned child when termination fails and permits a cleanup retry', async () => {
  const { root, home } = await fixture()
  const controlled = syntheticChild()
  let permitExit = false
  const kill = controlled.child.kill.bind(controlled.child)
  controlled.child.kill = ((signal?: NodeJS.Signals) => {
    const result = kill(signal)
    if (permitExit) controlled.exit(0)
    return result
  }) as typeof controlled.child.kill
  const host = runtime(home, {
    spawn: (() => controlled.child) as typeof nodeSpawn,
    fetch: async () => new Response(null, { status: 204 }),
    childTerminationTimeouts: { gracefulMs: 1, forceMs: 1 },
  })
  const binding = host.bind({
    owner: owner('cleanup-plugin', 'cleanup-one'),
    source: 'https://plugins.example.test/cleanup',
    declaration: declaration('cleanup-service', 'cleanup-plugin', []),
    artifactDirectory: root,
  }, new AbortController().signal)
  const registration = await binding.registry.register(definition('cleanup-service'), {
    revision: `sha256:${'1'.repeat(64)}`,
  })
  expect((await registration.ensureReady()).status).toBe('ready')
  await expect(binding.dispose()).rejects.toThrow()
  expect(controlled.signals).toEqual(['SIGTERM', 'SIGKILL'])
  permitExit = true
  await binding.dispose()
  expect(controlled.signals).toEqual(['SIGTERM', 'SIGKILL', 'SIGTERM'])
})

it('retains the launch diagnostic sink when a child exits outside its registering async context', async () => {
  const { withDiagnostics } = await import('../packages/cli/src/diagnostics/context.js')
  const events: { event: string }[] = []
  const controlled = syntheticChild({ exitOnKill: 'SIGTERM' })
  const binding = await withDiagnostics({ emit: event => events.push(event) }, async () => {
    const { root, home } = await fixture()
    const host = runtime(home, {
      spawn: (() => controlled.child) as typeof nodeSpawn,
      fetch: async () => new Response(null, { status: 204 }),
    })
    const binding = host.bind({
      owner: owner('observe-plugin', 'observe-one'),
      source: 'https://plugins.example.test/observe',
      declaration: declaration('observe-service', 'observe-plugin', []),
      artifactDirectory: root,
    }, new AbortController().signal)
    const registration = await binding.registry.register(definition('observe-service'), {
      revision: `sha256:${'1'.repeat(64)}`,
    })
    expect((await registration.ensureReady()).status).toBe('ready')
    return binding
  })
  controlled.exit(1)
  expect(events).toContainEqual(expect.objectContaining({ event: 'managed-service-exit', exitCode: 1 }))
  await binding.dispose()
})
