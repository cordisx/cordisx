import { access, chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'

describe('functional CordisX CLI', () => {
  it('shares setup with first launch, ignores cwd composition, and reuses an independent shared profile', async () => {
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
    expect(persisted.apps.codex.profiles.work.dataMode).toBe('shared')
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
    await expect(runCordisXCli(['codex', 'work', '--data', 'host-isolated', '--system', '--dry-run'], runtime))
      .rejects.toThrow('--system cannot enforce a host-isolated profile')
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

  it('keeps a shared UI-demo launch in its own persistent Chromium profile', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-run-'))
    const home = path.join(root, 'ui-demos')
    const output: string[] = []
    await runCordisXCli(['codex', 'ui-demo', '--data', 'shared', '--dry-run', '--executable', process.execPath], {
      env: { CORDISX_HOME: home },
      stdout: line => { output.push(line) },
    })
    expect(output.join('\n')).toContain('"chromiumProfile": {\n      "mode": "independent"')
    await expect(access(path.join(home, 'apps', 'codex', 'profiles', 'ui-demo', 'chromium'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('accepts a shared profile Chromium override without changing Host roots', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-run-'))
    const output: string[] = []
    await runCordisXCli([
      'codex', '--data', 'shared', '--profile-dir', path.join(root, 'private-profile'), '--dry-run', '--executable', process.execPath,
    ], { env: { CORDISX_HOME: path.join(root, 'home') }, stdout: line => { output.push(line) } })
    expect(output.join('\n')).toContain(path.join(root, 'private-profile'))
  })

  it('fails instead of claiming readiness when the launched Host exits before injection', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-run-'))
    const executable = path.join(root, 'exits-before-injection')
    await writeFile(executable, '#!/usr/bin/env node\nprocess.exit(0)\n')
    await chmod(executable, 0o755)
    const output: string[] = []
    await expect(runCordisXCli([
      'codex', '--data', 'shared', '--executable', executable,
    ], {
      env: { CORDISX_HOME: path.join(root, 'home') },
      stdout: line => { output.push(line) },
    })).rejects.toThrow('Host exited before CordisX CDP became ready')
    expect(output.join('\n')).toContain('"status": "launching"')
    expect(output.join('\n')).not.toContain('CDP renderer ready')
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

  it('reports the explicit local-dev source and validates its transitive build during dry-run', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-local-dev-'))
    const entry = path.join(root, 'demo.ts')
    const dependency = path.join(root, 'value.ts')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }))
    await writeFile(entry, "import { value } from './value.js'\nexport default { name: value, apply() {} }\n")
    await writeFile(dependency, "export const value = 'demo'\n")
    const output: string[] = []
    await runCordisXCli(['dev', entry, '--dry-run'], { cwd: root, stdout: line => { output.push(line) } })
    expect(JSON.parse(output.at(-1)!) as unknown).toMatchObject({
      status: 'ready',
      mode: 'development',
      origin: 'local-dev',
      pluginId: 'demo',
      sourcePath: entry,
    })
    await writeFile(dependency, 'export const value =\n')
    await expect(runCordisXCli(['dev', entry, '--dry-run'], { cwd: root, stdout: () => undefined })).rejects.toThrow(/Build failed/u)
  })
})
