import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'

describe('functional CordisX CLI', () => {
  it('shares setup with first launch, ignores cwd composition, and reuses an isolated profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-run-'))
    const project = path.join(root, 'project')
    const home = path.join(root, 'home')
    await import('node:fs/promises').then(async fs => await fs.mkdir(project))
    await writeFile(path.join(project, 'cordisx.config.json'), JSON.stringify({
      version: 1,
      plugins: [{ id: 'must-not-load', entry: './missing.ts' }],
    }))
    const output: string[] = []
    const runtime = {
      cwd: project,
      env: { CORDISX_HOME: home },
      stdout: (line: string): void => { output.push(line) },
    }

    await runCordisXCli(['setup'], runtime)
    await runCordisXCli(['codex', 'work', '--dry-run', '--executable', process.execPath], runtime)
    await runCordisXCli(['codex', 'work', '--dry-run', '--executable', process.execPath], runtime)

    const persisted = JSON.parse(await readFile(path.join(home, 'config.json'), 'utf8')) as {
      plugins: unknown[]
      apps: { codex: { profiles: { work: { dataMode: string } } } }
    }
    expect(persisted.plugins).toEqual([])
    expect(persisted.apps.codex.profiles.work.dataMode).toBe('isolated')
    expect(output.filter(line => line.includes('created codex/work'))).toHaveLength(1)
    expect(output.some(line => line.includes('plugins: (none)'))).toBe(true)
    await expect(access(path.join(home, 'apps', 'codex', 'profiles', 'work', 'chromium'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails an unavailable adapter explicitly without falling back to Codex', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-run-'))
    await expect(runCordisXCli(['claude-code', '--dry-run'], {
      env: { CORDISX_HOME: path.join(root, 'home') },
      stdout: () => undefined,
    })).rejects.toThrow('host adapter is not installed: claude-code')
  })

  it('rejects attach/system profile conflicts before persisting a new profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-run-'))
    const home = path.join(root, 'home')
    const runtime = { env: { CORDISX_HOME: home }, stdout: () => undefined }
    await expect(runCordisXCli(['codex', 'work', '--attach', '--dry-run'], runtime))
      .rejects.toThrow('--attach cannot select a named profile')
    await expect(runCordisXCli(['codex', 'work', '--system', '--dry-run'], runtime))
      .rejects.toThrow('--system cannot enforce an isolated host-data profile')
    const config = await readFile(path.join(home, 'config.json'), 'utf8')
    expect(config).not.toContain('work')
  })

  it('reports a system Chromium projection without creating an unused profile directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-run-'))
    const home = path.join(root, 'home')
    const output: string[] = []
    await runCordisXCli(['codex', '--system', '--dry-run', '--executable', process.execPath], {
      env: { CORDISX_HOME: home },
      stdout: line => { output.push(line) },
    })
    expect(output.join('\n')).toContain('"chromiumProfile": {\n      "mode": "system"')
    await expect(access(path.join(home, 'apps', 'codex', 'profiles', 'default'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a shared UI-demo launch on the existing Host profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-run-'))
    const home = path.join(root, 'ui-demos')
    const output: string[] = []
    await runCordisXCli(['codex', 'ui-demo', '--data', 'shared', '--dry-run', '--executable', process.execPath], {
      env: { CORDISX_HOME: home },
      stdout: line => { output.push(line) },
    })
    expect(output.join('\n')).toContain('"chromiumProfile": {\n      "mode": "system"')
    await expect(access(path.join(home, 'apps', 'codex', 'profiles', 'ui-demo'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not let a shared profile silently open a new Chromium directory', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-run-'))
    await expect(runCordisXCli([
      'codex', '--data', 'shared', '--profile-dir', path.join(root, 'private-profile'), '--dry-run', '--executable', process.execPath,
    ], { env: { CORDISX_HOME: path.join(root, 'home') }, stdout: () => undefined })).rejects.toThrow(
      '--profile-dir requires --data isolated; shared reuses the current Host profile',
    )
  })

  it('fails closed when a development system launch port is already occupied', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-run-'))
    const configPath = path.join(root, 'cordisx.config.json')
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('missing occupied port')
    await writeFile(configPath, JSON.stringify({
      version: 1, codex: { debugPort: address.port }, plugins: [],
    }))
    try {
      await expect(runCordisXCli([
        'dev', '--config', configPath, '--system', '--executable', process.execPath,
      ], { cwd: root, stdout: () => undefined })).rejects.toThrow(
        `loopback CDP port is unavailable: ${address.port}`,
      )
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    }
  })
})
