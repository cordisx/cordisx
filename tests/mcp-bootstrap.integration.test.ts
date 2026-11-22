import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { parse } from 'smol-toml'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { prepareProductionHostBootstrap } from '../packages/cli/src/cli/production-host-bootstrap.js'

const observe = vi.hoisted(() => vi.fn())
vi.mock(
  '../packages/cli/src/launcher/desktop-static-catalog.js',
  () => ({ prepareDesktopStaticCatalog: async () => undefined }),
)
vi.mock('../packages/cli/src/launcher/native-submission-composition.js', () => ({
  prepareNativeSubmissionBootstrap: async (_executable: string, options: { environment: NodeJS.ProcessEnv }) => {
    await observe(options.environment)
    return { environment: {}, close: async () => {} }
  },
}))
const roots: string[] = []
afterEach(async () => {
  observe.mockReset()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
it('projects into the effective launch environment before native submission initializes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-mcp-bootstrap-'))
  roots.push(root)
  const effective = path.join(root, 'effective'), wrong = path.join(root, 'wrong')
  const configPath = path.join(root, 'config.json')
  await writeFile(
    configPath,
    JSON.stringify({
      ...createDefaultHomeConfig(),
      mcp: { servers: { sample: { type: 'stdio', command: 'true' } } },
      environmentVariables: [{ name: 'CODEX_HOME', value: effective, enabled: true }],
    }),
  )
  const plan = {
    version: 1,
    appId: 'codex',
    appName: 'Codex',
    profileId: 'default',
    dataMode: 'shared',
    executable: process.execPath,
    chromiumProfile: { mode: 'system' },
    environment: { CODEX_HOME: wrong },
    sharedDataRoots: [],
    isolatedDataRoots: [],
  }
  observe.mockImplementation(async (env: NodeJS.ProcessEnv) => {
    expect(env.CODEX_HOME).toBe(effective)
    expect(parse(await readFile(path.join(effective, 'config.toml'), 'utf8'))).toMatchObject({
      mcp_servers: { sample: { command: 'true' } },
    })
  })
  const result = await prepareProductionHostBootstrap(
    {
      invocation: { action: 'launch', options: {}, hostArgs: [] },
      selection: { profileId: 'default', dataMode: 'shared' },
      adapter: { id: 'codex', resolveLaunchPlan: async () => plan, prepareLaunch: async () => {} },
      stdout: () => {},
      environment: { HOME: root },
      configPath,
      appId: 'codex',
    } as never,
    { env: { HOME: root }, internalNativeSubmissionPlatform: 'darwin' },
    {
      prelaunch: false,
      prepareNativeSubmission: true,
      mainInspector: false,
      markHostLaunched: () => {},
    },
  )
  expect(observe).toHaveBeenCalledOnce()
  expect(result.nativeSubmissionBootstrap).toBeDefined()
  await expect(readFile(path.join(wrong, 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' })
})
