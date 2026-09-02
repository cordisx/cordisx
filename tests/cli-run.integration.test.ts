import { access, chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:net'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'
import { parseOwnerDocumentBindingRequest } from '../packages/cli/src/launcher/owner-document-rpc.js'
import { BrowserOwnerDocumentBridge, CordisXOwnerDocumentBroker } from '../packages/cli/src/renderer/owner-documents.js'
import { defaultIsolatedProfileDir } from '../packages/cli/src/launcher/process.js'
import { LauncherMarketplaceCertifiedAuthority } from '../packages/cli/src/launcher/marketplace-certified-authority.js'

const directGrantStatePath = path.join('state', 'publisher-grants', 'direct-device-bound.v1.json')

async function createLocalDevelopmentFixture(root: string): Promise<{
  readonly project: string
  readonly entry: string
  readonly configPath: string
  readonly executable: string
}> {
  const project = path.join(root, 'project')
  const entry = path.join(project, 'demo.ts')
  const configPath = path.join(project, 'cordisx.config.json')
  const executable = path.join(root, 'exits-before-injection')
  await mkdir(project, { recursive: true })
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }))
  await writeFile(entry, "export default { name: 'demo', apply() {} }\n")
  await writeFile(configPath, JSON.stringify({ version: 1, plugins: [] }))
  await writeFile(executable, '#!/usr/bin/env node\nprocess.exit(0)\n')
  await chmod(executable, 0o755)
  return { project, entry, configPath, executable }
}

describe('functional CordisX CLI', () => {
  it('opens one Launcher Certified authority for lifecycle and disposes it after dry-run', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-certified-authority-'))
    const home = path.join(root, 'home')
    const dispose = vi.fn(async () => undefined)
    const open = vi.spyOn(LauncherMarketplaceCertifiedAuthority, 'open').mockResolvedValue({
      lookup: vi.fn(async () => ({ revision: 0 })),
      dispose,
    } as unknown as LauncherMarketplaceCertifiedAuthority)
    try {
      await runCordisXCli(['codex', '--dry-run', '--executable', process.execPath], {
        env: { CORDISX_HOME: home },
        stdout: () => undefined,
      })
      expect(open).toHaveBeenCalledTimes(1)
      expect(open).toHaveBeenCalledWith({
        homeDir: home,
        configPath: path.join(home, 'config.json'),
        profileId: 'default',
      })
      expect(dispose).toHaveBeenCalledTimes(1)
    } finally {
      open.mockRestore()
    }
  })

  it('authorizes a launcher-configured plugin through the exact production composition bridge', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-owner-documents-'))
    const home = path.join(root, 'home')
    const entry = path.resolve('tests/fixtures/owner-documents-runtime-plugin.ts')
    const runtime = { env: { CORDISX_HOME: home }, stdout: () => undefined }
    await runCordisXCli(['setup'], runtime)
    const configPath = path.join(home, 'config.json')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as { plugins: unknown[] }
    config.plugins = [{ id: 'owner-documents-runtime', entry, enabled: true, config: {} }]
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
    let result: unknown
    await runCordisXCli(['codex', 'work', '--dry-run', '--executable', process.execPath], {
      ...runtime,
      internalObserveOwnerDocuments: async ({ source, handler }) => {
        const token = source.match(/"token":\s*"([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"/)?.[1]
        if (token === undefined) throw new Error('configured plugin binding is missing')
        const moduleGeneration = (JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8')) as { moduleGeneration: string }).moduleGeneration
        globalThis.__cordisxOwnerDocumentRequestV1 = (payload: string) => {
          void (async () => {
            const request = parseOwnerDocumentBindingRequest(JSON.parse(payload))
            const value = request.operation === 'load' ? await handler.load(request) : await handler.replace(request)
            globalThis.__cordisxOwnerDocumentReceiveV1?.(JSON.stringify({ requestId: request.requestId, ok: true, value }))
          })()
        }
        const identity = { source: pathToFileURL(entry).href, id: 'owner-documents-runtime' }
        const broker = new CordisXOwnerDocumentBroker(new BrowserOwnerDocumentBridge(), [{
          source: identity.source, pluginId: identity.id, moduleGeneration, token,
        }])
        const client = broker.bind({ identity, moduleGeneration, active: () => true })
        result = await client.replace({
          contract: 'cordisx.owner-documents/v1', documentId: 'room-registry', expectedRevision: 0, schemaVersion: 1,
          value: { operationId: 'configured-plugin-operation', state: 'planned' },
        })
        broker.dispose(); delete globalThis.__cordisxOwnerDocumentRequestV1; delete globalThis.__cordisxOwnerDocumentReceiveV1
      },
    })
    expect(result).toMatchObject({ status: 'accepted', snapshot: { revision: 1 } })
  }, 30_000)

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
    const project = path.join(root, 'repository')
    const repositoryGuide = path.join(project, 'AGENTS.md')
    const repositorySkill = path.join(project, '.agents', 'skills', 'repository-helper', 'SKILL.md')
    const sharedHome = path.join(root, 'real-home')
    const executable = path.join(root, 'exits-before-injection')
    await mkdir(path.dirname(repositorySkill), { recursive: true })
    await writeFile(repositoryGuide, 'repository-guide-sentinel\n')
    await writeFile(repositorySkill, 'repository-skill-sentinel\n')
    await writeFile(executable, '#!/usr/bin/env node\nprocess.exit(0)\n')
    await chmod(executable, 0o755)
    const output: string[] = []
    const processCwd = process.cwd()
    await expect(runCordisXCli([
      'codex', '--data', 'shared', '--executable', executable,
    ], {
      cwd: project,
      env: { CORDISX_HOME: path.join(root, 'home') },
      internalSharedHomeDir: sharedHome,
      stdout: line => { output.push(line) },
    })).rejects.toThrow('Host exited before CordisX CDP became ready')
    expect(output.join('\n')).toContain('"status": "launching"')
    expect(output.join('\n')).toContain('[cordisx] built-in Skill installed:')
    expect(output.join('\n')).not.toContain('CDP renderer ready')
    expect(process.cwd()).toBe(processCwd)
    await expect(access(path.join(sharedHome, '.agents', 'skills', 'cordisx-plugin-development', 'SKILL.md')))
      .resolves.toBeUndefined()
    await expect(readFile(repositoryGuide, 'utf8')).resolves.toBe('repository-guide-sentinel\n')
    await expect(readFile(repositorySkill, 'utf8')).resolves.toBe('repository-skill-sentinel\n')
    await expect(access(path.join(project, '.cordisx', 'studio'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(path.join(sharedHome, '.cordisx', 'studio'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('deploys the built-in Skill into host-isolated HOME without copying a shared personal Skill', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-run-isolated-skill-'))
    const cordisxHome = path.join(root, 'cordisx-home')
    const sharedHome = path.join(root, 'shared-home')
    const personalSkill = path.join(sharedHome, '.agents', 'skills', 'personal-only', 'SKILL.md')
    const executable = path.join(root, 'exits-before-injection')
    await mkdir(path.dirname(personalSkill), { recursive: true })
    await writeFile(personalSkill, 'personal-sentinel\n')
    await writeFile(executable, '#!/usr/bin/env node\nprocess.exit(0)\n')
    await chmod(executable, 0o755)

    await expect(runCordisXCli([
      'codex', 'private', '--data', 'host-isolated', '--executable', executable,
    ], {
      env: { CORDISX_HOME: cordisxHome },
      internalSharedHomeDir: sharedHome,
      stdout: () => undefined,
    })).rejects.toThrow('Host exited before CordisX CDP became ready')

    const privateHome = path.join(cordisxHome, 'apps', 'codex', 'profiles', 'private', 'host-home')
    await expect(access(path.join(privateHome, '.agents', 'skills', 'cordisx-plugin-development', 'SKILL.md')))
      .resolves.toBeUndefined()
    await expect(access(path.join(privateHome, '.agents', 'skills', 'personal-only')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(personalSkill, 'utf8')).resolves.toBe('personal-sentinel\n')
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

  it('isolates direct-entry Host state and its default profile in each selected CORDISX_HOME', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-local-dev-state-'))
    const { project, entry, executable } = await createLocalDevelopmentFixture(root)
    const firstHome = path.join(root, 'home-one')
    const secondHome = path.join(root, 'home-two')
    const cwdState = path.join(project, directGrantStatePath)
    await mkdir(path.dirname(cwdState), { recursive: true })
    await writeFile(cwdState, 'project-sentinel\n')
    await mkdir(firstHome, { mode: 0o755 })
    await mkdir(secondHome, { mode: 0o755 })

    const launch = async (home: string): Promise<void> => {
      await expect(runCordisXCli(['dev', entry, '--executable', executable], {
        cwd: project,
        env: { CORDISX_HOME: home },
        internalSharedHomeDir: path.join(root, 'host-home'),
        stdout: () => undefined,
      })).rejects.toThrow('Host exited before CordisX CDP became ready')
    }

    await launch(firstHome)
    const firstStatePath = path.join(firstHome, directGrantStatePath)
    const firstState = JSON.parse(await readFile(firstStatePath, 'utf8')) as Record<string, unknown>
    await writeFile(firstStatePath, `${JSON.stringify({ ...firstState, revision: 7, lastTrustedAt: '2026-08-28T00:00:00.000Z' }, null, 2)}\n`)
    await launch(secondHome)

    expect(JSON.parse(await readFile(firstStatePath, 'utf8'))).toMatchObject({ revision: 7, lastTrustedAt: '2026-08-28T00:00:00.000Z' })
    expect(JSON.parse(await readFile(path.join(secondHome, directGrantStatePath), 'utf8'))).toMatchObject({
      contract: 'cordisx.publisher-grants/direct-device-bound/v1',
      revision: 0,
    })
    await expect(readFile(cwdState, 'utf8')).resolves.toBe('project-sentinel\n')
    await expect(access(defaultIsolatedProfileDir(project, firstHome))).resolves.toBeUndefined()
    await expect(access(defaultIsolatedProfileDir(project, secondHome))).resolves.toBeUndefined()
    if (process.platform !== 'win32') {
      expect((await stat(firstHome)).mode & 0o777).toBe(0o700)
      expect((await stat(secondHome)).mode & 0o777).toBe(0o700)
      expect((await stat(defaultIsolatedProfileDir(project, firstHome))).mode & 0o777).toBe(0o700)
      expect((await stat(defaultIsolatedProfileDir(project, secondHome))).mode & 0o777).toBe(0o700)
    }
  })

  it('keeps config-based development Host state under CORDISX_HOME and leaves cwd state untouched', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-config-dev-state-'))
    const { project, configPath, executable } = await createLocalDevelopmentFixture(root)
    const home = path.join(root, 'home')
    const cwdState = path.join(project, directGrantStatePath)
    await mkdir(path.dirname(cwdState), { recursive: true })
    await writeFile(cwdState, 'config-project-sentinel\n')
    await mkdir(home, { mode: 0o755 })

    await expect(runCordisXCli(['dev', '--config', configPath, '--executable', executable], {
      cwd: project,
      env: { CORDISX_HOME: home },
      stdout: () => undefined,
    })).rejects.toThrow('Host exited before CordisX CDP became ready')

    expect(JSON.parse(await readFile(path.join(home, directGrantStatePath), 'utf8'))).toMatchObject({
      contract: 'cordisx.publisher-grants/direct-device-bound/v1',
      revision: 0,
    })
    await expect(readFile(cwdState, 'utf8')).resolves.toBe('config-project-sentinel\n')
    await expect(access(defaultIsolatedProfileDir(project, home))).resolves.toBeUndefined()
    if (process.platform !== 'win32') {
      expect((await stat(home)).mode & 0o777).toBe(0o700)
      expect((await stat(defaultIsolatedProfileDir(project, home))).mode & 0o777).toBe(0o700)
    }
  })

  it.skipIf(process.platform === 'win32')('rejects a symlinked CORDISX_HOME before either development path can write', async () => {
    for (const mode of ['direct', 'config'] as const) {
      const root = await mkdtemp(path.join(os.tmpdir(), `cordisx-cli-dev-${mode}-symlink-home-`))
      const { project, entry, configPath, executable } = await createLocalDevelopmentFixture(root)
      const target = path.join(root, 'target-home')
      const link = path.join(root, 'linked-home')
      await mkdir(target, { mode: 0o755 })
      await symlink(target, link)
      const args = mode === 'direct'
        ? ['dev', entry, '--executable', executable]
        : ['dev', '--config', configPath, '--executable', executable]

      await expect(runCordisXCli(args, {
        cwd: project,
        env: { CORDISX_HOME: link },
        stdout: () => undefined,
      })).rejects.toThrow('CordisX home must be a real directory')

      expect((await stat(target)).mode & 0o777).toBe(0o755)
      await expect(access(path.join(target, 'state'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(path.join(target, 'projects'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('rejects a non-directory CORDISX_HOME before either development path can write', async () => {
    for (const mode of ['direct', 'config'] as const) {
      const root = await mkdtemp(path.join(os.tmpdir(), `cordisx-cli-dev-${mode}-file-home-`))
      const { project, entry, configPath, executable } = await createLocalDevelopmentFixture(root)
      const home = path.join(root, 'home-file')
      await writeFile(home, 'home-sentinel\n')
      const args = mode === 'direct'
        ? ['dev', entry, '--executable', executable]
        : ['dev', '--config', configPath, '--executable', executable]

      await expect(runCordisXCli(args, {
        cwd: project,
        env: { CORDISX_HOME: home },
        stdout: () => undefined,
      })).rejects.toThrow('failed to create CordisX home directory')
      await expect(readFile(home, 'utf8')).resolves.toBe('home-sentinel\n')
    }
  })

  it.skipIf(process.platform === 'win32')('rejects a non-owned broad CORDISX_HOME before development state writes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-dev-owner-home-'))
    const { project, entry, executable } = await createLocalDevelopmentFixture(root)
    const home = path.join(root, 'foreign-home')
    await mkdir(home, { mode: 0o755 })
    const metadata = await stat(home)
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(metadata.uid + 1)
    try {
      await expect(runCordisXCli(['dev', entry, '--executable', executable], {
        cwd: project,
        env: { CORDISX_HOME: home },
        stdout: () => undefined,
      })).rejects.toThrow('CordisX home must be owned by the current user')
    } finally {
      getuid.mockRestore()
    }
    expect((await stat(home)).mode & 0o777).toBe(0o755)
    await expect(access(path.join(home, 'state'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(path.join(home, 'projects'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('uses an isolated homedir for a fresh default ~/.cordisx development Home', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-dev-default-home-'))
    const { project, entry, executable } = await createLocalDevelopmentFixture(root)
    const isolatedHomedir = path.join(root, 'isolated-user-home')
    const home = path.join(isolatedHomedir, '.cordisx')

    await expect(runCordisXCli(['dev', entry, '--executable', executable], {
      cwd: project,
      env: {},
      homedir: isolatedHomedir,
      internalSharedHomeDir: isolatedHomedir,
      stdout: () => undefined,
    })).rejects.toThrow('Host exited before CordisX CDP became ready')

    await expect(access(path.join(home, directGrantStatePath))).resolves.toBeUndefined()
    await expect(access(defaultIsolatedProfileDir(project, home))).resolves.toBeUndefined()
    if (process.platform !== 'win32') {
      expect((await stat(home)).mode & 0o777).toBe(0o700)
      expect((await stat(defaultIsolatedProfileDir(project, home))).mode & 0o777).toBe(0o700)
    }
  })

  it('keeps both direct-entry and config-based development dry-runs write-free', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-dev-dry-run-state-'))
    const { project, entry, configPath } = await createLocalDevelopmentFixture(root)
    const directHome = path.join(root, 'direct-home')
    const configHome = path.join(root, 'config-home')

    await runCordisXCli(['dev', entry, '--dry-run'], {
      cwd: project,
      env: { CORDISX_HOME: directHome },
      stdout: () => undefined,
    })
    await runCordisXCli(['dev', '--config', configPath, '--dry-run'], {
      cwd: project,
      env: { CORDISX_HOME: configHome },
      stdout: () => undefined,
    })

    await expect(access(directHome)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(configHome)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a relative CORDISX_HOME before a development dry-run can write', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-dev-relative-home-'))
    const { project, entry } = await createLocalDevelopmentFixture(root)
    await expect(runCordisXCli(['dev', entry, '--dry-run'], {
      cwd: project,
      env: { CORDISX_HOME: 'relative-cordisx-home' },
      stdout: () => undefined,
    })).rejects.toThrow('CORDISX_HOME must be an absolute path')
    await expect(access(path.join(project, 'relative-cordisx-home'))).rejects.toMatchObject({ code: 'ENOENT' })
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

  it('deploys the Skill and exposes one scaffolded plugin entry to the Host without creating a managed source', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-cli-scaffolded-plugin-'))
    const project = path.join(root, 'project')
    const home = path.join(root, 'cordisx-home')
    const hostHome = path.join(root, 'host-home')
    const entry = path.join(project, 'send-confetti', 'src', 'send-confetti.ts')
    const observedEnvironment = path.join(root, 'observed-environment.json')
    const executable = path.join(root, 'capture-development-entry')
    await mkdir(path.dirname(entry), { recursive: true })
    await writeFile(path.join(project, 'send-confetti', 'package.json'), JSON.stringify({ name: 'send-confetti', version: '0.1.0' }))
    await writeFile(entry, "export const name = 'send-confetti'\nexport function apply() {}\n")
    await writeFile(executable, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(observedEnvironment)}, JSON.stringify({ entry: process.env.CORDISX_DEV_ENTRY, mode: process.env.CORDISX_DEV_MODE }))\n`)
    await chmod(executable, 0o755)

    const dryOutput: string[] = []
    await runCordisXCli(['dev', entry, '--dry-run'], {
      cwd: project, env: { CORDISX_HOME: home }, stdout: line => { dryOutput.push(line) },
    })
    expect(JSON.parse(dryOutput.at(-1)!) as unknown).toMatchObject({
      status: 'ready', origin: 'local-dev', pluginId: 'send-confetti', sourcePath: entry,
    })

    const output: string[] = []
    await expect(runCordisXCli(['dev', entry, '--executable', executable], {
      cwd: project,
      env: { CORDISX_HOME: home },
      internalSharedHomeDir: hostHome,
      stdout: line => { output.push(line) },
    })).rejects.toThrow('Host exited before CordisX CDP became ready')

    expect(JSON.parse(await readFile(observedEnvironment, 'utf8'))).toEqual({ entry, mode: 'explicit-entry' })
    expect(await readFile(entry, 'utf8')).toContain("export const name = 'send-confetti'")
    await expect(access(path.join(hostHome, '.agents', 'skills', 'cordisx-plugin-development', 'SKILL.md')))
      .resolves.toBeUndefined()
    expect(output.join('\n')).toContain('[cordisx] built-in Skill installed:')
  })
})
