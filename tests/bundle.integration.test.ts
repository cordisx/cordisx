import { describe, it } from 'vitest'
import { bootSurfaces } from './suites/bundle.surfaces.js'
import { verifyRoutes } from './suites/bundle.routes.js'
import { verifyManagerShell } from './suites/bundle.manager-shell.js'

describe('renderer bundle', () => {
  it('boots the structured demo, routes all outlets, reprojects locale, and disposes one generation', async () => {
    const started = performance.now()
    const surfaces = await bootSurfaces()
    const booted = performance.now()
    console.info('[bundle integration] boot surfaces', Math.round(booted - started), 'ms')
    const routes = await verifyRoutes(surfaces)
    const routed = performance.now()
    console.info('[bundle integration] verify routes', Math.round(routed - booted), 'ms')
    await verifyManagerShell(routes)
    console.info('[bundle integration] verify Manager and dispose', Math.round(performance.now() - routed), 'ms')
    // The complete JSDOM scenario already takes about 70 seconds on hosted CI.
    // Keep a single generation across the three phases and allow for slower runners.
  }, 150_000)
})
