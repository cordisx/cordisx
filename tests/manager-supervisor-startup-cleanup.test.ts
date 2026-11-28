import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  home: '',
  ingressStartFails: false,
  closeWeb: vi.fn(async () => {}),
  closeIngress: vi.fn(async () => {
    throw new Error('synthetic ingress close failure')
  }),
}))

vi.mock('../packages/cli/src/cli/manager-owner.js', () => ({
  resolveManagerProfile: async () => ({ homeDir: state.home, profileId: 'work' }),
  openManagerOwner: async () => ({ appId: 'codex', profileId: 'work', generation: 'owner-1' }),
}))
vi.mock('../packages/cli/src/cli/manager-deployment-config.js', () => ({
  loadManagerDeploymentConfig: async () => ({ publicOrigin: 'https://manager.example.test', listeners: [] }),
}))
vi.mock('../packages/cli/src/cli/manager-web.js', () => ({
  startManagerWeb: async () => ({
    origin: 'https://manager.example.test',
    localOrigin: 'http://127.0.0.1:12345',
    close: state.closeWeb,
  }),
}))
vi.mock('../packages/cli/src/cli/manager-public-ingress.js', () => ({
  startManagerPublicIngress: async () => {
    if (state.ingressStartFails) throw new Error('synthetic ingress publication failure')
    return { close: state.closeIngress }
  },
}))
vi.mock('../packages/cli/src/cli/supervisor-control.js', () => ({
  startSupervisorControlServer: async () => {
    throw new Error('synthetic control publication failure')
  },
  requestManagerEntry: vi.fn(),
  requestManagerLink: vi.fn(),
  requestSupervisorPing: vi.fn(),
  requestSupervisorStop: vi.fn(),
}))

import { managerRendererGatewayPaths } from '../packages/cli/src/cli/manager-renderer-gateway.js'
import { serveManager } from '../packages/cli/src/cli/manager-supervisor.js'

it.each([
  { ingressStartFails: false, webFails: false },
  { ingressStartFails: false, webFails: true },
  { ingressStartFails: true, webFails: true },
])(
  'closes the Manager listener and retains startup and cleanup failures: %s',
  async ({ ingressStartFails, webFails }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-startup-cleanup-'))
    const oldKey = process.env.CORDISX_MANAGER_CHILD_KEY
    state.home = root
    state.ingressStartFails = ingressStartFails
    state.closeWeb.mockClear()
    state.closeWeb.mockImplementation(async () => {
      if (webFails) throw new Error('synthetic web close failure')
    })
    state.closeIngress.mockClear()
    const key = 'a'.repeat(64)
    try {
      const paths = managerRendererGatewayPaths(root, 'work')
      await mkdir(paths.directory, { recursive: true, mode: 0o700 })
      await writeFile(paths.bootstrapToken, key, { mode: 0o600 })
      process.env.CORDISX_MANAGER_CHILD_KEY = key
      const failure = await serveManager('work', 'fixture-deployment').then(() => undefined, error => error)
      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).errors.map(error => (error as Error).message)).toEqual([
        ingressStartFails ? 'synthetic ingress publication failure' : 'synthetic control publication failure',
        ...(ingressStartFails ? [] : ['synthetic ingress close failure']),
        ...(webFails ? ['synthetic web close failure'] : []),
      ])
      expect(state.closeIngress).toHaveBeenCalledTimes(ingressStartFails ? 0 : 1)
      expect(state.closeWeb).toHaveBeenCalledOnce()
    } finally {
      if (oldKey === undefined) delete process.env.CORDISX_MANAGER_CHILD_KEY
      else process.env.CORDISX_MANAGER_CHILD_KEY = oldKey
      await rm(root, { recursive: true, force: true })
    }
  },
)
