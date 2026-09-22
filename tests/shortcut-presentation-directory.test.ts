import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import {
  type ShortcutPresentationJob,
  updateShortcutPresentation,
} from '../packages/cli/src/cli/shortcut-presentation-worker.js'
import { createShortcut } from '../packages/cli/src/shortcuts/create.js'
import { hasMatchingProcessIdentity, readSupervisorState } from '../packages/cli/src/cli/supervisor-state.js'
import { requestDockRefresh } from '../packages/cli/src/cli/supervisor-control.js'

vi.mock('../packages/cli/src/shortcuts/create.js', () => ({ createShortcut: vi.fn(), reuseShortcut: vi.fn() }))
vi.mock('../packages/cli/src/cli/supervisor-state.js', () => ({
  readSupervisorState: vi.fn(),
  hasMatchingProcessIdentity: vi.fn(),
}))
vi.mock(
  '../packages/cli/src/cli/supervisor-control.js',
  () => ({
    requestShortcutPresentation: async () => ({ status: 'available', avatar: { kind: 'fixture' } }),
    requestDockRefresh: vi.fn(),
  }),
)
afterEach(() => vi.clearAllMocks())
beforeEach(() => {
  vi.mocked(hasMatchingProcessIdentity).mockResolvedValue(true)
  vi.mocked(requestDockRefresh).mockResolvedValue(true)
})
it('creates a missing private presentation parent before generating the running icon', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'startup-icon-'))
  const directory = path.join(root, 'presentation', 'profiles')
  vi.mocked(readSupervisorState).mockResolvedValue(
    {
      phase: 'ready',
      instanceToken: 'generation',
      pid: 1,
      processStartedAt: 's',
      hostPid: 2,
      hostProcessStartedAt: 'h',
    } as never,
  )
  vi.mocked(createShortcut).mockImplementation(async () => {
    expect((await stat(directory)).isDirectory()).toBe(true)
    return {} as never
  })
  try {
    await updateShortcutPresentation(
      {
        schemaVersion: 1,
        paths: {},
        instanceToken: 'generation',
        launchIdentity: { supervisorPid: 1, supervisorStartedAt: 's', hostPid: 2, hostStartedAt: 'h' },
        output: { directory },
        updateShortcut: true,
        reuseExistingAvatar: false,
      } as ShortcutPresentationJob,
    )
    expect(createShortcut).toHaveBeenCalledTimes(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('ignores stale ready state when the Host has exited or its PID was reused', async () => {
  vi.mocked(readSupervisorState).mockResolvedValue({
    phase: 'ready',
    instanceToken: 'generation',
    pid: 1,
    processStartedAt: 's',
    hostPid: 2,
    hostProcessStartedAt: 'h',
  } as never)
  vi.mocked(hasMatchingProcessIdentity).mockImplementation(async pid => pid === 1)
  await updateShortcutPresentation({
    paths: {},
    instanceToken: 'generation',
    updateShortcut: true,
    launchIdentity: { supervisorPid: 1, supervisorStartedAt: 's', hostPid: 2, hostStartedAt: 'h' },
  } as ShortcutPresentationJob)
  expect(createShortcut).not.toHaveBeenCalled()
  expect(requestDockRefresh).not.toHaveBeenCalled()
})

it('ignores a refresh rejection only if the requesting generation has exited', async () => {
  vi.mocked(readSupervisorState).mockResolvedValue({
    phase: 'ready',
    instanceToken: 'generation',
    pid: 1,
    processStartedAt: 's',
    hostPid: 2,
    hostProcessStartedAt: 'h',
  } as never)
  const job = {
    paths: {},
    instanceToken: 'generation',
    updateShortcut: false,
    launchIdentity: { supervisorPid: 1, supervisorStartedAt: 's', hostPid: 2, hostStartedAt: 'h' },
  } as ShortcutPresentationJob
  vi.mocked(requestDockRefresh).mockResolvedValue(false)
  await expect(updateShortcutPresentation(job)).rejects.toThrow('Dock icon refresh was rejected')
  vi.mocked(requestDockRefresh).mockImplementation(async () => {
    vi.mocked(hasMatchingProcessIdentity).mockResolvedValue(false)
    return false
  })
  await expect(updateShortcutPresentation(job)).resolves.toBeUndefined()
})
