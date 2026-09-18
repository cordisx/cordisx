import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'

it('binds development management to the home default profile without publishing an RPC endpoint', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-dev-management-'))
  onTestFinished(async () => await rm(root, { recursive: true, force: true }))
  const project = path.join(root, 'project')
  const entry = path.join(project, 'demo.ts')
  const home = path.join(root, 'home')
  const configPath = path.join(home, 'config.json')
  await mkdir(project, { recursive: true })
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }))
  await writeFile(entry, "export default { name: 'demo', apply() {} }\n")
  await runCordisXCli(['setup'], { env: { CORDISX_HOME: home }, stdout: () => undefined })
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    defaultApp: string
    apps: Record<string, unknown>
  }
  config.defaultApp = 'preview-host'
  config.apps['preview-host'] = {
    defaultProfile: 'review',
    profiles: { review: { displayName: 'Review', dataMode: 'shared' } },
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)

  await runCordisXCli(['dev', entry, '--executable', process.execPath], {
    cwd: project,
    env: { CORDISX_HOME: home },
    internalSharedHomeDir: root,
    internalRunInjectedHost: async input => {
      expect(input.pluginManagement).toMatchObject({ profileId: 'review' })
      expect(await input.pluginManagement!.service.query()).toMatchObject({
        profileId: 'review',
        runtime: { kind: 'inactive' },
      })
      const snapshot = await input.pluginManagement!.service.query()
      await input.pluginManagement!.service.execute({
        kind: 'source-add',
        source: { url: 'https://example.com/catalog.json', enabled: true },
      }, snapshot.revision)
    },
    stdout: () => undefined,
  })

  const persisted = JSON.parse(await readFile(configPath, 'utf8')) as {
    apps: { 'preview-host': { profiles: { review: { management: { sources: Array<{ url: string }> } } } } }
  }
  expect(persisted.apps['preview-host'].profiles.review.management.sources).toContainEqual(
    expect.objectContaining({ url: 'https://example.com/catalog.json' }),
  )
  await expect(access(path.join(home, 'run', 'preview-host', 'review', 'management.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
}, 30_000)
