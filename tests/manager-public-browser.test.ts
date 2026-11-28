import { expect, it } from 'vitest'
import { fixture } from './fixtures/standalone-manager-client.js'
import { cleanup, fixture as graphFixture, target } from './fixtures/independent-plugin-graph.js'
import { createSessionPluginGraphProjection } from '../packages/cli/src/independent-manager/plugin-graph-projection.js'
import { createManagerRendererGraphSession } from '../packages/cli/src/cli/manager-renderer-graph-session.js'

it('starts the existing Manager composition at a configured HTTPS origin', async () => {
  const test = fixture({ browserOrigin: 'https://manager.example.test' })
  try {
    expect(await test.manager.ready).toBe(true)
    expect(test.unavailable).not.toHaveBeenCalled()
  } finally {
    await test.manager.close()
    test.dom.window.close()
  }
})

it('projects only owner-issued plugin graphs onto the public Manager origin', async () => {
  const input = await graphFixture()
  const managerOrigin = 'https://manager.example.test'
  let projection: ReturnType<typeof createSessionPluginGraphProjection> | undefined
  try {
    projection = createSessionPluginGraphProjection({ managerOrigin, artifactServer: input.server })
    const graph = projection.project(input.lease, () => true)
    expect(new URL(graph.entryUrl).origin).toBe(managerOrigin)
    expect(graph.entryUrl).not.toContain(input.server.origin)
    expect((await projection.resolve({ method: 'GET', target: target(graph.entryUrl) })).status).toBe(200)
    const session = createManagerRendererGraphSession({
      managerOrigin,
      profileId: 'work',
      generation: 'owner-1',
      rendererId: 'a'.repeat(64),
      isCurrent: () => true,
      forbiddenSecrets: [],
    })
    session.projectInitial([])
    session.close()
  } finally {
    projection?.close()
    await cleanup()
  }
})
