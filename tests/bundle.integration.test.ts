import { describe, it } from 'vitest'
import { bootSurfaces } from './suites/bundle.surfaces.js'
import { verifyRoutes } from './suites/bundle.routes.js'
import { verifyManagerShell } from './suites/bundle.manager-shell.js'
import { verifyPluginDetails } from './suites/bundle.plugin-details.js'

describe('renderer bundle', () => {
  it('boots the structured demo, routes all outlets, reprojects locale, and disposes one generation', async () => {
    const surfaces = await bootSurfaces()
    const routes = await verifyRoutes(surfaces)
    const manager = await verifyManagerShell(routes)
    // Preserve the existing early return after the React Manager smoke and disposal.
    if (manager === undefined) return
    await verifyPluginDetails(manager)
  }, 90_000)
})
