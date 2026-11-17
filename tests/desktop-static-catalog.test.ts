import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedLaunchPlan } from '../packages/cli/src/adapters/contracts.js'
import {
  type DesktopStaticCatalogLease,
  prepareDesktopStaticCatalog,
} from '../packages/cli/src/launcher/desktop-static-catalog.js'

const roots: string[] = []
const leases: DesktopStaticCatalogLease[] = []
afterEach(async () => {
  await Promise.all(leases.splice(0).map(lease => lease.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-desktop-catalog-test-'))
  roots.push(root)
  const home = path.join(root, 'home'), codexHome = path.join(home, '.codex'), cordisxHome = path.join(root, 'cordisx')
  const contents = path.join(root, 'Codex.app', 'Contents'),
    macos = path.join(contents, 'MacOS'),
    resources = path.join(contents, 'Resources')
  const executable = path.join(macos, 'Codex'), cli = path.join(resources, 'codex')
  const selectedState = path.join(cordisxHome, 'apps', 'codex', 'profiles', 'selected', 'channel-conversations.json')
  await Promise.all([
    mkdir(macos, { recursive: true }),
    mkdir(resources, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
    mkdir(path.dirname(selectedState), { recursive: true }),
  ])
  await writeFile(executable, '')
  await writeFile(cli, "#!/bin/sh\nprintf 'codex-cli 0.167.0-alpha.3.2\\n'\n", { mode: 0o700 })
  await chmod(cli, 0o700)
  await writeFile(
    path.join(codexHome, 'models_cache.json'),
    JSON.stringify({ unrelated: 'private', models: [{ slug: 'model' }] }),
  )
  await writeFile(path.join(codexHome, 'auth.json'), 'private-auth')
  const plan: ResolvedLaunchPlan = {
    version: 1,
    appId: 'codex',
    appName: 'Codex',
    profileId: 'selected',
    dataMode: 'shared',
    executable,
    chromiumProfile: { mode: 'system' },
    environment: {},
    sharedDataRoots: [{ name: 'HOME', path: home, managed: false }, {
      name: 'CODEX_HOME',
      path: codexHome,
      managed: false,
    }],
    isolatedDataRoots: [],
  }
  return { root, home, codexHome, cordisxHome, selectedState, cli, resources, plan }
}
const probe = () => {
  const close = vi.fn(async () => {})
  const request = vi.fn(async (method: string) =>
    method === 'config/read'
      ? { config: { model_catalog_json: null } }
      : { requirements: { modelCatalogJson: null } }
  )
  const startProbe = vi.fn(async () => ({ request, close }))
  return { startProbe, request, close }
}
function input(f: Awaited<ReturnType<typeof fixture>>, startProbe: ReturnType<typeof probe>['startProbe']) {
  return {
    plan: f.plan,
    cordisxHome: f.cordisxHome,
    userHome: f.home,
    cwd: f.root,
    environment: { HOME: f.home, CODEX_HOME: f.codexHome },
    startProbe: startProbe as never,
  }
}

describe('Desktop launch catalog lease', () => {
  it('uses only selected profile opt-in and passes exact launch identity to the shared preflight', async () => {
    const f = await fixture(), p = probe()
    const other = path.join(f.cordisxHome, 'apps', 'codex', 'profiles', 'other', 'channel-conversations.json')
    await mkdir(path.dirname(other), { recursive: true })
    await writeFile(other, JSON.stringify({ continuationDefaults: { policy: { enabled: true } } }))
    expect(await prepareDesktopStaticCatalog(input(f, p.startProbe))).toBeUndefined()
    expect(p.startProbe).not.toHaveBeenCalled()
    await writeFile(f.selectedState, JSON.stringify({ continuationDefaults: { policy: { enabled: true } } }))
    const lease = await prepareDesktopStaticCatalog(input(f, p.startProbe))
    if (lease) leases.push(lease)
    expect(lease).toBeDefined()
    expect(p.startProbe).toHaveBeenCalledWith(
      expect.objectContaining({ codexExecutable: await realpath(f.cli), codexHome: f.codexHome }),
      expect.objectContaining({ environment: expect.objectContaining({ HOME: f.home, CODEX_HOME: f.codexHome }) }),
    )
    expect(p.request).toHaveBeenCalledWith('config/read', { cwd: f.root, includeLayers: false })
    expect(p.close).toHaveBeenCalledOnce()
    const bytes = lease!.bytes
    expect(JSON.parse(Buffer.from(bytes).toString())).toEqual({ models: [{ slug: 'model' }] })
    expect(lease!.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(lease!.nativeVersion).toBe('0.167.0-alpha.3.2')
    expect((await stat(lease!.path)).mode & 0o777).toBe(0o400)
    bytes[0] = 0
    expect(lease!.bytes[0]).not.toBe(0)
    await Promise.all([lease!.close(), lease!.close()])
    await expect(stat(lease!.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path.join(f.codexHome, 'auth.json'), 'utf8')).toBe('private-auth')
    expect(JSON.parse(await readFile(path.join(f.codexHome, 'models_cache.json'), 'utf8')).unrelated).toBe('private')
  })
  it('fails closed on a different HOME or CODEX_HOME and on unknown bundled versions', async () => {
    const f = await fixture(), p = probe()
    await writeFile(f.selectedState, JSON.stringify({ continuationDefaults: { policy: { enabled: true } } }))
    expect(
      await prepareDesktopStaticCatalog({
        ...input(f, p.startProbe),
        environment: { HOME: f.home, CODEX_HOME: path.join(f.root, 'other') },
      }),
    ).toBeUndefined()
    expect(await prepareDesktopStaticCatalog({ ...input(f, p.startProbe), userHome: f.root })).toBeUndefined()
    await writeFile(f.cli, "#!/bin/sh\nprintf 'codex-cli 0.149.1\\n'\n")
    expect(await prepareDesktopStaticCatalog(input(f, p.startProbe))).toBeUndefined()
    expect(p.startProbe).not.toHaveBeenCalled()
  })
  it('uses the selected isolated plan HOME and CODEX_HOME over the parent environment', async () => {
    const f = await fixture(), p = probe()
    await writeFile(f.selectedState, JSON.stringify({ continuationDefaults: { policy: { enabled: true } } }))
    const plan: ResolvedLaunchPlan = {
      ...f.plan,
      dataMode: 'host-isolated',
      environment: { HOME: f.home, CODEX_HOME: f.codexHome },
      sharedDataRoots: [],
      isolatedDataRoots: [{ name: 'HOME', path: f.home, managed: true }, {
        name: 'CODEX_HOME',
        path: f.codexHome,
        managed: true,
      }],
    }
    const lease = await prepareDesktopStaticCatalog({
      ...input(f, p.startProbe),
      plan,
      environment: { HOME: f.root, CODEX_HOME: path.join(f.root, 'other') },
    })
    if (lease) leases.push(lease)
    expect(lease).toBeDefined()
    expect(p.startProbe).toHaveBeenCalledWith(
      expect.objectContaining({ codexHome: f.codexHome }),
      expect.objectContaining({ environment: expect.objectContaining({ HOME: f.home, CODEX_HOME: f.codexHome }) }),
    )
  })
  it('does not replace configured or managed catalogs or use a CLI outside the chosen app', async () => {
    const f = await fixture(), p = probe()
    await writeFile(
      f.selectedState,
      JSON.stringify({ continuations: { session: { livePolicy: { overrides: { enabled: true } } } } }),
    )
    p.request.mockImplementation(async method =>
      method === 'config/read'
        ? { config: { model_catalog_json: '/user/catalog.json' } }
        : { requirements: { modelCatalogJson: null } }
    )
    expect(await prepareDesktopStaticCatalog(input(f, p.startProbe))).toBeUndefined()
    p.request.mockImplementation(async method =>
      method === 'config/read'
        ? { config: { model_catalog_json: null } }
        : { requirements: { modelCatalogJson: '/managed/catalog.json' } }
    )
    expect(await prepareDesktopStaticCatalog(input(f, p.startProbe))).toBeUndefined()
    expect(p.close).toHaveBeenCalledTimes(2)
    const external = path.join(f.root, 'external-codex')
    await writeFile(external, "#!/bin/sh\nprintf 'codex-cli 0.167.0-alpha.3.2\\n'\n", { mode: 0o700 })
    await rm(f.cli)
    await symlink(external, f.cli)
    expect(await prepareDesktopStaticCatalog(input(f, p.startProbe))).toBeUndefined()
    expect(p.startProbe).toHaveBeenCalledTimes(2)
  })
  it('closes a failed preflight and refuses a Resources directory outside the selected bundle', async () => {
    const f = await fixture(), p = probe()
    await writeFile(f.selectedState, JSON.stringify({ continuationDefaults: { policy: { enabled: true } } }))
    p.request.mockRejectedValue(new Error('preflight failed'))
    expect(await prepareDesktopStaticCatalog(input(f, p.startProbe))).toBeUndefined()
    expect(p.close).toHaveBeenCalledOnce()
    const externalResources = path.join(f.root, 'external-resources')
    await mkdir(externalResources)
    await writeFile(path.join(externalResources, 'codex'), "#!/bin/sh\nprintf 'codex-cli 0.167.0-alpha.3.2\\n'\n", {
      mode: 0o700,
    })
    await rm(f.resources, { recursive: true })
    await symlink(externalResources, f.resources)
    expect(await prepareDesktopStaticCatalog(input(f, p.startProbe))).toBeUndefined()
    expect(p.startProbe).toHaveBeenCalledOnce()
  })
})
