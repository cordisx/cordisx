import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { c as createTar } from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  inspectMarketplaceArtifactPackage,
  parseMarketplaceArtifactBindingRequest,
  previewMarketplaceArtifactPackage,
} from '../packages/cli/src/launcher/marketplace-artifact.js'
import type { PluginLifecycleBridgeHandler } from '../packages/cli/src/launcher/plugin-lifecycle-rpc.js'

const SOURCE = 'https://github.com/example/marketplace-demo'
const DOWNLOAD = 'https://registry.example/@example/marketplace-demo/-/marketplace-demo-1.2.3.tgz'
const roots: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function packageArchive(name = '@example/marketplace-demo', version = '1.2.3'): Promise<Buffer> {
  const root = await mkdtemp(path.join(tmpdir(), 'cordisx-marketplace-test-'))
  roots.push(root)
  await mkdir(path.join(root, 'package'))
  await writeFile(path.join(root, 'package', 'package.json'), JSON.stringify({ name, version, readme: './README.md' }))
  await writeFile(path.join(root, 'package', 'cordisx-package.json'), JSON.stringify({ readme: './README.md' }))
  await writeFile(path.join(root, 'package', 'README.md'), '# Marketplace demo\n')
  const archive = path.join(root, 'artifact.tgz')
  await createTar({ cwd: root, file: archive, gzip: true }, ['package'])
  return await readFile(archive)
}

function request(bytes: Buffer, overrides: Partial<{
  readonly pluginId: string
  readonly version: string
  readonly canonicalSource: string
  readonly packageName: string
  readonly integrity: string
}> = {}) {
  return {
    pluginId: overrides.pluginId ?? 'marketplace-demo',
    version: overrides.version ?? '1.2.3',
    canonicalSource: overrides.canonicalSource ?? SOURCE,
    artifact: {
      publisherIdentity: 'npm:@example',
      packageNamespace: '@example',
      packageName: overrides.packageName ?? '@example/marketplace-demo',
      downloadUrl: DOWNLOAD,
      integrity: overrides.integrity ?? `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    },
  }
}

function handler(expectedSource = SOURCE): {
  readonly value: PluginLifecycleBridgeHandler
  readonly stage: ReturnType<typeof vi.fn>
  readonly inspect: ReturnType<typeof vi.fn>
  readonly archivePaths: string[]
} {
  const archivePaths: string[] = []
  const stage = vi.fn(async (source: {
    readonly kind: string
    readonly location: string
    readonly downloadedFrom?: string
    readonly expectedDigest?: string
    readonly distributionIntegrity?: string
  }) => {
    archivePaths.push(fileURLToPath(source.location))
    expect(source).toMatchObject({ kind: 'downloaded-tarball', downloadedFrom: DOWNLOAD })
    expect(source.distributionIntegrity).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(source).not.toHaveProperty('expectedDigest')
    return {
      manifest: { id: 'marketplace-demo', version: '1.2.3', canonicalSource: expectedSource },
      digest: `sha256:${'b'.repeat(64)}`,
      readme: '# Marketplace demo\n',
    }
  })
  const inspect = vi.fn(async () => ({
    $schema:
      'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-lifecycle-result.v1.schema.json',
    schemaVersion: 1,
    requestId: 'marketplace-test',
    profileId: 'default',
    operation: 'install',
    outcome: 'planned',
    revision: 0,
    runtimeGeneration: 'test',
    scope: 'plugin-generation',
    affectedPluginIds: ['marketplace-demo'],
    candidateId: 'candidate',
  }))
  return {
    value: {
      coordinator: { stagePackageSource: stage, inspectStagedPackage: inspect },
    } as unknown as PluginLifecycleBridgeHandler,
    stage,
    inspect,
    archivePaths,
  }
}

describe('Marketplace artifact installation boundary', () => {
  it('accepts only a consistent HTTPS feed artifact request', () => {
    const bytes = Buffer.from('artifact')
    expect(parseMarketplaceArtifactBindingRequest({
      kind: 'inspect',
      requestId: 'request-1',
      request: request(bytes),
    })).toMatchObject({ kind: 'inspect', requestId: 'request-1' })
    expect(() =>
      parseMarketplaceArtifactBindingRequest({
        kind: 'inspect',
        requestId: 'request-2',
        request: {
          ...request(bytes),
          artifact: { ...request(bytes).artifact, downloadUrl: 'http://registry.example/plugin.tgz' },
        },
      })
    ).toThrow('canonical HTTPS')
  })

  it('verifies raw tarball SHA-256 before staging without reusing it as the package-tree digest', async () => {
    const bytes = await packageArchive()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(bytes, {
          status: 200,
          headers: { 'content-length': String(bytes.byteLength) },
        })
      ),
    )
    const lifecycle = handler()
    await expect(inspectMarketplaceArtifactPackage(lifecycle.value, request(bytes), new AbortController().signal))
      .resolves.toMatchObject({ outcome: 'planned', candidateId: 'candidate' })
    expect(lifecycle.stage).toHaveBeenCalledOnce()
    expect(lifecycle.stage).toHaveBeenCalledWith(expect.objectContaining({
      distributionIntegrity: request(bytes).artifact.integrity,
    }))
    expect(lifecycle.inspect).toHaveBeenCalledOnce()
    await expect(stat(lifecycle.archivePaths[0]!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('previews packaged README without creating an installation candidate', async () => {
    const bytes = await packageArchive()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200 })))
    const lifecycle = handler()
    await expect(previewMarketplaceArtifactPackage(lifecycle.value, request(bytes), new AbortController().signal))
      .resolves.toEqual({ readme: '# Marketplace demo\n' })
    expect(lifecycle.stage).not.toHaveBeenCalled()
    expect(lifecycle.inspect).not.toHaveBeenCalled()
  })

  it('rejects digest and package identity mismatches before lifecycle inspection', async () => {
    const bytes = await packageArchive('@example/other-name')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200 })))
    const digestMismatch = handler()
    await expect(inspectMarketplaceArtifactPackage(
      digestMismatch.value,
      request(bytes, { integrity: `sha256:${'0'.repeat(64)}` }),
      new AbortController().signal,
    )).rejects.toThrow('SHA-256 mismatch')
    expect(digestMismatch.stage).not.toHaveBeenCalled()

    const identityMismatch = handler()
    await expect(inspectMarketplaceArtifactPackage(
      identityMismatch.value,
      request(bytes),
      new AbortController().signal,
    )).rejects.toThrow('package identity does not match package.json')
    expect(identityMismatch.stage).not.toHaveBeenCalled()
  })

  it('rejects packaged CordisX identity mismatches after staging and before candidate creation', async () => {
    const bytes = await packageArchive()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200 })))
    const lifecycle = handler('https://github.com/example/wrong-source')
    await expect(inspectMarketplaceArtifactPackage(lifecycle.value, request(bytes), new AbortController().signal))
      .rejects.toThrow('packaged CordisX manifest')
    expect(lifecycle.stage).toHaveBeenCalledOnce()
    expect(lifecycle.inspect).not.toHaveBeenCalled()
  })
})
