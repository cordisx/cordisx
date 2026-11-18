import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { c as createTar } from 'tar'
import { loadConfig } from '../packages/cli/src/launcher/config.js'
import { buildRendererCompositionSource } from '../packages/cli/src/launcher/bundle.js'

const temporary: string[] = []
const schema = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v16.schema.json'
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'configured-plugin-manifest-'))
  temporary.push(root)
  await mkdir(path.join(root, 'dist'))
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}')
  await writeFile(path.join(root, 'dist', 'index.js'), 'export const name = "demo"')
  await writeFile(path.join(root, 'dist', 'service.mjs'), 'export default {}')
  const runtime = {
    $schema: schema,
    schemaVersion: 16,
    id: 'demo',
    capabilities: [],
    services: [{
      id: 'runtime',
      kind: 'channel-adapter',
      entry: './dist/service.mjs',
      configuration: { kind: 'none' },
    }],
  }
  const bytes = JSON.stringify(runtime)
  await writeFile(path.join(root, 'runtime-manifest.json'), bytes)
  const descriptor = {
    $schema: schema.replace('plugin-manifest', 'plugin-package'),
    schemaVersion: 16,
    id: 'demo',
    version: '1.0.0',
    entry: './dist/index.js',
    dependencies: [],
    distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
    compatibility: { runtimeAbi: 1, protocolSchemas: [schema] },
    runtimeManifest: {
      path: './runtime-manifest.json',
      schema,
      digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    },
  }
  await writeFile(path.join(root, 'cordisx-package.json'), JSON.stringify(descriptor))
  const config = path.join(root, 'cordisx.config.json')
  await writeFile(config, JSON.stringify({ version: 1, plugins: [{ id: 'demo', entry: './dist/index.js' }] }))
  return { root, runtime, config, descriptor }
}
afterEach(async () => {
  async function writable(root: string): Promise<void> {
    await chmod(root, 0o700)
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory()) await writable(path.join(root, entry.name))
    }
  }
  for (const root of temporary) await writable(root)
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('direct configured package provenance', () => {
  it('carries verified archive identity through the production renderer composition', async () => {
    const f = await fixture()
    const source = 'https://github.com/cordisx/demo'
    await writeFile(
      path.join(f.root, 'cordisx-package.json'),
      JSON.stringify({ ...f.descriptor, canonicalSource: source }),
    )
    const archive = path.join(f.root, 'demo.tgz')
    await createTar({ cwd: f.root, file: archive, gzip: true }, [
      'package.json',
      'cordisx-package.json',
      'runtime-manifest.json',
      'dist',
    ])
    const integrity = `sha256:${createHash('sha256').update(await readFile(archive)).digest('hex')}`
    await writeFile(f.config, JSON.stringify({ version: 1, plugins: [{ id: 'demo', entry: './demo.tgz' }] }))
    const config = await loadConfig(f.config), plugin = config.plugins[0]!
    expect(plugin).toMatchObject({
      source,
      manifest: f.runtime,
      package: { version: '1.0.0', artifactIntegrity: integrity },
    })
    expect(plugin.entry).toContain('/packages/sha256/')
    expect(plugin.manifestFiles).toEqual([archive])
    const composition = await buildRendererCompositionSource(config, {}, { omitPluginModules: true })
    expect(composition.source).toContain(`source: ${JSON.stringify(source)}`)
    expect(composition.source).toContain(`package: ${JSON.stringify(plugin.package)}`)
    // Rebuilt archives must not inherit the previously certified distribution identity.
    await writeFile(path.join(f.root, 'dist', 'index.js'), 'export const name = "changed"')
    await createTar({ cwd: f.root, file: archive, gzip: true }, [
      'package.json',
      'cordisx-package.json',
      'runtime-manifest.json',
      'dist',
    ])
    expect((await loadConfig(f.config)).plugins[0]!.package!.artifactIntegrity).not.toEqual(integrity)
  })
  it('loads service metadata only from the digest-validated descriptor for the exact entry', async () => {
    const f = await fixture(), plugin = (await loadConfig(f.config)).plugins[0]!
    expect(plugin.manifest).toMatchObject(f.runtime)
    expect(plugin.manifestFiles).toEqual([
      path.join(f.root, 'cordisx-package.json'),
      path.join(f.root, 'runtime-manifest.json'),
    ])
  })
  it('rejects tampered runtime metadata instead of manufacturing an owner', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'runtime-manifest.json'), JSON.stringify({ ...f.runtime, name: 'tampered' }))
    await expect(loadConfig(f.config)).rejects.toThrow('digest mismatch')
  })
  it('does not give another renderer entry the service metadata of a neighboring built entry', async () => {
    const f = await fixture()
    await writeFile(path.join(f.root, 'dist', 'other.js'), 'export const name = "other"')
    await writeFile(f.config, JSON.stringify({ version: 1, plugins: [{ id: 'demo', entry: './dist/other.js' }] }))
    expect((await loadConfig(f.config)).plugins[0]!.manifest).toBeUndefined()
  })
  it('rejects package/plugin id mismatches', async () => {
    const f = await fixture()
    await writeFile(f.config, JSON.stringify({ version: 1, plugins: [{ id: 'different', entry: './dist/index.js' }] }))
    await expect(loadConfig(f.config)).rejects.toThrow()
  })
})
