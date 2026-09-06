import { describe, it } from 'vitest'
import { bootSurfaces } from './suites/bundle.surfaces.js'
import { verifyRoutes } from './suites/bundle.routes.js'
import { verifyManagerShell } from './suites/bundle.manager-shell.js'

describe('renderer bundle', () => {
  it('boots the structured demo, routes all outlets, reprojects locale, and disposes one generation', async () => {
    const surfaces = await bootSurfaces()
    const routes = await verifyRoutes(surfaces)
    await verifyManagerShell(routes)
  }, 90_000)
})
