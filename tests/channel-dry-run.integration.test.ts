import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'

describe('Channel planning integration', () => {
  it('does not start a configured Channel or create profile data during a named dry run', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-channel-dry-run-integration-'))
    const home = path.join(root, 'home')
    const entry = path.join(root, 'channel.mjs')
    await writeFile(entry, 'throw new Error("Channel must not start during dry run")\n')
    const runtime = { env: { CORDISX_HOME: home }, stdout: () => undefined }
    await runCordisXCli(['setup'], runtime)
    const configPath = path.join(home, 'config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { plugins: unknown[] }
    config.plugins = [{ id: 'channel', entry, enabled: true, config: {} }]
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
    await runCordisXCli(['codex', 'work', '--dry-run', '--executable', process.execPath], runtime)
    await expect(access(path.join(home, 'apps', 'codex', 'profiles', 'work'))).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(root, { recursive: true, force: true })
  }, 30_000)
})
