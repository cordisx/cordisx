import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import {
  type ShortcutPresentationJob,
  updateShortcutPresentation,
} from '../packages/cli/src/cli/shortcut-presentation-worker.js'
import { createShortcut } from '../packages/cli/src/shortcuts/create.js'
import { readSupervisorState } from '../packages/cli/src/cli/supervisor-state.js'

vi.mock('../packages/cli/src/shortcuts/create.js', () => ({ createShortcut: vi.fn(), reuseShortcut: vi.fn() }))
vi.mock('../packages/cli/src/cli/supervisor-state.js', () => ({ readSupervisorState: vi.fn() }))
vi.mock(
  '../packages/cli/src/cli/supervisor-control.js',
  () => ({
    requestShortcutPresentation: async () => ({ status: 'available', avatar: { kind: 'fixture' } }),
    requestDockRefresh: async () => true,
  }),
)
afterEach(() => vi.clearAllMocks())
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
