import { beforeEach, expect, it, vi } from 'vitest'
import { ensureClientService } from '../packages/cli/src/cli/client-service-owner.js'
import type { PreparedRunCommand } from '../packages/cli/src/cli/run-command-dispatch.js'

const run = vi.hoisted(() => vi.fn())
vi.mock('../packages/cli/src/cli/supervisor-command.js', () => ({ runSupervisorCommand: run }))

beforeEach(() => run.mockReset())

it('starts or reuses the exact profile service before the native client attaches', async () => {
  const prepared = {
    appId: 'codex',
    configPath: '/fixture/config.json',
    selection: { profileId: 'work', dataMode: 'shared' },
  } as PreparedRunCommand
  run.mockResolvedValue({
    state: { mode: 'service', phase: 'ready' },
    target: { configPath: prepared.configPath, appId: 'codex', selection: prepared.selection },
  })
  const output = vi.fn()
  await ensureClientService(prepared, { env: { CORDISX_HOME: '/fixture' }, stdout: output })
  const [invocation, runtime] = run.mock.calls[0]!
  expect(invocation).toMatchObject({ action: 'start', mode: 'service', app: 'codex', profile: 'work' })
  runtime.stdout('hidden service startup output')
  expect(output).not.toHaveBeenCalled()
  run.mockResolvedValueOnce({
    state: { mode: 'service', phase: 'ready' },
    target: {
      configPath: prepared.configPath,
      appId: 'codex',
      selection: { ...prepared.selection, profileId: 'other' },
    },
  })
  await expect(ensureClientService(prepared, {})).rejects.toThrow('service owner did not become ready')
})
