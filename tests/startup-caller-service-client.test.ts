import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readEndpoint: vi.fn(),
  request: vi.fn(),
  readState: vi.fn(),
  identity: vi.fn(),
  ping: vi.fn(),
}))
vi.mock('../packages/cli/src/launcher/management-rpc.js', () => ({
  pluginManagementRpcPaths: () => ({ directory: '/owner', socket: '/owner/management.sock' }),
  readPluginManagementRpcEndpoint: mocks.readEndpoint,
  requestPluginManagementRpc: mocks.request,
}))
vi.mock('../packages/cli/src/cli/supervisor-control.js', () => ({ requestSupervisorPing: mocks.ping }))
vi.mock('../packages/cli/src/cli/supervisor-state.js', () => ({
  supervisorPaths: () => ({ socket: '/owner/control.sock', role: 'owner' }),
  clientSupervisorPaths: () => ({ socket: '/client/control.sock', role: 'client' }),
  readSupervisorState: mocks.readState,
  processIdentityStatus: mocks.identity,
}))
import { waitForStartupCaller } from '../packages/cli/src/cli/startup-caller-wait.js'
import type { SupervisorState } from '../packages/cli/src/cli/supervisor-state.js'

const owner = {
  appId: 'codex',
  profileId: 'default',
  mode: 'service',
  phase: 'ready',
  pid: 11,
  processStartedAt: 'owner-start',
  instanceToken: 'owner-token',
} as SupervisorState
const client = {
  appId: 'codex',
  profileId: 'default',
  clientOfService: true,
  clientConnection: 'connected',
  phase: 'ready',
  pid: 22,
  processStartedAt: 'client-start',
  instanceToken: 'client-token',
} as SupervisorState
const endpoint = {
  appId: 'codex',
  profileId: 'default',
  pid: 11,
  processStartedAt: 'owner-start',
  configPath: '/fixture/config.json',
  token: 'endpoint-token',
  generation: 'owner-generation',
}
const input = { configPath: '/fixture/config.json', appId: 'codex', profileId: 'default', state: client }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readEndpoint.mockResolvedValue(endpoint)
  mocks.request.mockResolvedValue({ kind: 'ready' })
  mocks.readState.mockImplementation(async (paths: { role: string }) => paths.role === 'owner' ? owner : client)
  mocks.identity.mockResolvedValue('alive')
  mocks.ping.mockResolvedValue(true)
})

it('waits on the verified service for a separately supervised ready client', async () => {
  await expect(waitForStartupCaller(input)).resolves.toBeUndefined()
  expect(mocks.request).toHaveBeenCalledOnce()
})

it('rejects a disconnected client before dispatch and an owner change before returning', async () => {
  mocks.readState.mockImplementation(async (paths: { role: string }) =>
    paths.role === 'owner' ? owner : { ...client, clientConnection: 'disconnected' }
  )
  await expect(waitForStartupCaller(input)).rejects.toThrow('Startup target owner changed')
  expect(mocks.request).not.toHaveBeenCalled()
  mocks.readState.mockImplementation(async (paths: { role: string }) => paths.role === 'owner' ? owner : client)
  mocks.request.mockImplementation(async () => {
    mocks.readState.mockImplementation(async (paths: { role: string }) =>
      paths.role === 'owner' ? { ...owner, instanceToken: 'replacement' } : client
    )
    mocks.readEndpoint.mockResolvedValue({ ...endpoint, generation: 'replacement-generation' })
    return { kind: 'ready' }
  })
  await expect(waitForStartupCaller(input)).rejects.toThrow('Startup target owner changed')
})
