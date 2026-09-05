import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { c as createTar } from 'tar'
import { afterEach, describe, expect, it } from 'vitest'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../packages/cli/src/platform-contracts.js'
import {
  createHostPermissionReviewAuthority,
  hashPackageTree,
  type HostResolvedRuntimeManifest,
  PackageLifecycleAuthority,
  stagePluginPackageSourceV1,
} from '../packages/cli/src/launcher/packages/index.js'
import { loadStagedPluginPackage, removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'

const packageSchema =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-package.v2.schema.json'
const temporary = new Set<string>()

afterEach(async () => {
  await Promise.all([...temporary].map(async (root) => {
    const homeDir = path.join(root, 'home')
    const digests = await readdir(path.join(homeDir, 'packages', 'sha256')).catch(() => [])
    await Promise.all(digests.map(digest => removeStagedPluginPackage(homeDir, `sha256:${digest}`)))
    await rm(root, { recursive: true, force: true })
  }))
  temporary.clear()
})

async function fixture(id = 'source-fixture') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-source-v1-'))
  temporary.add(root)
  const homeDir = path.join(root, 'home')
  const source = path.join(root, 'source')
  await mkdir(path.join(source, 'src'), { recursive: true })
  const runtime = {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
    schemaVersion: 1,
    id,
    capabilities: [],
  } as const
  const runtimeText = `${JSON.stringify(runtime, null, 2)}\n`
  await writeFile(path.join(source, 'runtime.json'), runtimeText)
  await writeFile(path.join(source, 'src/index.ts'), 'export function apply() {}\n')
  await writeFile(
    path.join(source, 'cordisx-package.json'),
    `${
      JSON.stringify(
        {
          $schema: packageSchema,
          schemaVersion: 2,
          id,
          version: '1.0.0',
          entry: './src/index.ts',
          distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
          compatibility: { runtimeAbi: 1, protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V1] },
          dependencies: [],
          runtimeManifest: {
            path: './runtime.json',
            schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
            digest: `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`,
          },
        },
        null,
        2,
      )
    }\n`,
  )
  return { root, homeDir, source, runtime }
}

async function writeRuntimeSource(source: string, runtimeText: string): Promise<`sha256:${string}`> {
  const digest = `sha256:${createHash('sha256').update(runtimeText).digest('hex')}` as const
  await writeFile(path.join(source, 'runtime.json'), runtimeText)
  const packagePath = path.join(source, 'cordisx-package.json')
  const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as { runtimeManifest: { digest: string } }
  manifest.runtimeManifest.digest = digest
  await writeFile(packagePath, `${JSON.stringify(manifest, null, 2)}\n`)
  return digest
}

const runtimeValidators = {
  [CORDISX_PLUGIN_MANIFEST_SCHEMA_V1]: (value: unknown) => value as HostResolvedRuntimeManifest,
}

describe('formal source-v1 and package-v2 edge adapter', () => {
  it.each(['local-directory', 'local-package', 'downloaded-tarball'] as const)(
    'snapshots and stages %s into the single immutable #73 package store',
    async (kind) => {
      const { root, homeDir, source } = await fixture()
      let location = pathToFileURL(source).href
      if (kind !== 'local-directory') {
        const archive = path.join(root, `${kind}.tgz`)
        await createTar({ cwd: source, file: archive, gzip: true }, ['.'])
        location = pathToFileURL(archive).href
      }
      const staged = await stagePluginPackageSourceV1({
        kind,
        location,
        ...(kind === 'downloaded-tarball' ? { downloadedFrom: 'https://downloads.example/plugin.tgz' } : {}),
      }, { homeDir, runtimeValidators })
      expect(staged.manifest).toMatchObject({ id: 'source-fixture', version: '1.0.0' })
      expect(await loadStagedPluginPackage(homeDir, staged.digest)).toMatchObject({ digest: staged.digest })
      const stored = await readFile(
        path.join(homeDir, 'packages', 'sha256', staged.digest.slice(7), 'manifest.json'),
        'utf8',
      )
      expect(stored).toContain('cordisx.launcher-staged-package/v3')
      expect(stored).not.toContain('"capabilities"')
      await removeStagedPluginPackage(homeDir, staged.digest)
    },
  )

  it('keeps source and normalized runtime digests distinct across immutable readback', async () => {
    const { homeDir, source, runtime } = await fixture()
    const sourceText = `\n${JSON.stringify(runtime, null, '\t')}   \n`
    const sourceDigest = await writeRuntimeSource(source, sourceText)
    const staged = await stagePluginPackageSourceV1({
      kind: 'local-directory',
      location: pathToFileURL(source).href,
    }, { homeDir, runtimeValidators })
    const storeRoot = path.join(homeDir, 'packages', 'sha256', staged.digest.slice(7))
    const envelope = JSON.parse(await readFile(path.join(storeRoot, 'manifest.json'), 'utf8')) as {
      contract: string
      package: { runtimeManifest: { digest: string } }
      runtimeObject: { sourceDigest: string; storedDigest: string }
    }
    const storedRuntime = await readFile(path.join(storeRoot, 'runtime-manifest.json'))
    const storedDigest = `sha256:${createHash('sha256').update(storedRuntime).digest('hex')}`
    expect(envelope).toMatchObject({
      contract: 'cordisx.launcher-staged-package/v3',
      package: { runtimeManifest: { digest: sourceDigest } },
      runtimeObject: { sourceDigest, storedDigest },
    })
    expect(storedDigest).not.toBe(sourceDigest)
    expect((await loadStagedPluginPackage(homeDir, staged.digest)).manifest.runtimeManifest).toEqual(runtime)
  })

  it('verifies source and separated runtime integrity before activation', async () => {
    const { homeDir, source } = await fixture()
    const digest = await hashPackageTree(source)
    await expect(stagePluginPackageSourceV1({
      kind: 'local-directory',
      location: pathToFileURL(source).href,
      expectedDigest: `sha256:${'0'.repeat(64)}`,
    }, { homeDir, runtimeValidators })).rejects.toMatchObject({ code: 'integrity-mismatch' })
    expect(digest).toMatch(/^[a-f0-9]{64}$/)

    const runtimePath = path.join(source, 'runtime.json')
    await writeFile(runtimePath, `${await readFile(runtimePath, 'utf8')} `)
    await expect(stagePluginPackageSourceV1({
      kind: 'local-directory',
      location: pathToFileURL(source).href,
    }, { homeDir, runtimeValidators })).rejects.toMatchObject({ code: 'integrity-mismatch' })
  })

  it('rejects normalized runtime object tampering even when JSON semantics are unchanged', async () => {
    const { homeDir, source } = await fixture()
    const staged = await stagePluginPackageSourceV1({
      kind: 'local-directory',
      location: pathToFileURL(source).href,
    }, { homeDir, runtimeValidators })
    const storeRoot = path.join(homeDir, 'packages', 'sha256', staged.digest.slice(7))
    const runtimePath = path.join(storeRoot, 'runtime-manifest.json')
    if (process.platform !== 'win32') {
      await chmod(storeRoot, 0o700)
      await chmod(runtimePath, 0o600)
    }
    await writeFile(runtimePath, `${await readFile(runtimePath, 'utf8')} `)
    await expect(loadStagedPluginPackage(homeDir, staged.digest))
      .rejects.toThrow('runtime manifest failed integrity readback')
  })

  it('pins normalized runtime objects through restart, last-good, and deferred GC', async () => {
    const { homeDir, source } = await fixture()
    const staged = await stagePluginPackageSourceV1({
      kind: 'local-directory',
      location: pathToFileURL(source).href,
    }, { homeDir, runtimeValidators })
    const permissionAuthority = createHostPermissionReviewAuthority(
      async () => {
        throw new Error('permission review is not expected')
      },
      async () => undefined,
    )
    const options = {
      homeDir,
      profileId: 'default',
      runtimeGeneration: 'runtime-1',
      permissionAuthority,
    }
    const authority = await PackageLifecycleAuthority.open(options)
    const installed: CordisXPluginActivationRecordV1 = {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1,
      recordKind: 'candidate',
      transactionId: 'install-source-fixture',
      profileId: 'default',
      revision: 1,
      lastGoodRevision: 0,
      runtimeGeneration: 'runtime-1',
      plugins: [{
        id: 'source-fixture',
        version: '1.0.0',
        digest: staged.digest,
        moduleGeneration: 'source-fixture-1',
        enabled: true,
        dependencies: [],
      }],
    }
    await authority.activation.writeCandidate(installed)
    await authority.activation.commitCandidate(installed.transactionId)
    await authority.activation.writeCandidate({
      ...installed,
      transactionId: 'uninstall-source-fixture',
      revision: 2,
      lastGoodRevision: 1,
      plugins: [],
    })
    await authority.activation.commitCandidate('uninstall-source-fixture')

    const reopened = await PackageLifecycleAuthority.open(options)
    expect((await loadStagedPluginPackage(homeDir, staged.digest)).digest).toBe(staged.digest)
    expect(await reopened.collectGarbage(0)).toEqual([])
    await reopened.releaseLastGood(1)
    expect(await reopened.collectGarbage(0)).toEqual([staged.digest])
  })

  it('rejects non-exact versions and duplicate or self dependencies', async () => {
    const { homeDir, source } = await fixture()
    const manifestPath = path.join(source, 'cordisx-package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: string; dependencies: unknown[] }
    manifest.version = '^1.0.0'
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
    await expect(stagePluginPackageSourceV1({ kind: 'local-directory', location: pathToFileURL(source).href }, {
      homeDir,
      runtimeValidators,
    })).rejects.toMatchObject({ code: 'invalid-package-manifest' })
    manifest.version = '1.0.0'
    manifest.dependencies = [{ id: 'source-fixture', version: '1.0.0' }]
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
    await expect(stagePluginPackageSourceV1({ kind: 'local-directory', location: pathToFileURL(source).href }, {
      homeDir,
      runtimeValidators,
    })).rejects.toMatchObject({ code: 'invalid-package-manifest' })
  })

  it('rejects launcher-owned credential/transport/process values and invalid discovery attribution', async () => {
    const { homeDir, source } = await fixture()
    const runtimePath = path.join(source, 'runtime.json')
    const runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as Record<string, unknown>
    runtime.secretRef = 'keychain:should-not-tunnel'
    const runtimeText = `${JSON.stringify(runtime)}\n`
    await writeFile(runtimePath, runtimeText)
    const packagePath = path.join(source, 'cordisx-package.json')
    const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as { runtimeManifest: { digest: string } }
    manifest.runtimeManifest.digest = `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`
    await writeFile(packagePath, `${JSON.stringify(manifest)}\n`)
    await expect(stagePluginPackageSourceV1({ kind: 'local-directory', location: pathToFileURL(source).href }, {
      homeDir,
      runtimeValidators,
    })).rejects.toMatchObject({ code: 'launcher-config-tunnel' })
    await expect(stagePluginPackageSourceV1({
      kind: 'downloaded-tarball',
      location: pathToFileURL(packagePath).href,
      downloadedFrom: 'file:///not-marketplace-trust',
    }, { homeDir, runtimeValidators })).rejects.toMatchObject({ code: 'invalid-package-source' })
  })
})
