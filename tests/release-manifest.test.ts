import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  advanceReleaseState,
  createReleaseManifest,
  createReleaseState,
  readReleaseFiles,
  releaseManifestDigest,
  verifyReleaseManifest,
  verifyReleaseState,
  writeReleaseFiles,
} from '../scripts/release-manifest.mjs'

const commitSha = '1234567890abcdef1234567890abcdef12345678'
const created: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(created.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function integrity(contents: string) {
  return `sha512-${createHash('sha512').update(contents).digest('base64')}`
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-release-manifest-'))
  created.push(root)
  const cordisx = path.join(root, 'cordisx.tgz')
  const creator = path.join(root, 'creator.tgz')
  await writeFile(cordisx, 'cordisx tarball')
  await writeFile(creator, 'creator tarball')
  const input = {
    createdAt: '2026-09-21T00:00:00.000Z',
    source: { repository: 'cordisx/cordisx', commitSha, clean: true },
    release: {
      tag: 'v0.1.0-beta.20',
      version: '0.1.0-beta.20',
      registry: 'https://registry.npmjs.org',
      distTag: 'beta',
    },
    packages: [
      {
        name: 'cordisx',
        version: '0.1.0-beta.20',
        dependencies: {
          runtime: { '@cordisx/protocol': '0.1.0-beta.7' },
          optional: { fsevents: '~2.3.3' },
          bundled: ['@cordisx/schemastery-ui'],
        },
        tarball: { path: cordisx, integrity: integrity('cordisx tarball') },
      },
      {
        name: 'create-cordisx-plugin',
        version: '0.1.0-beta.20',
        dependencies: { runtime: { yaml: '2.8.1' }, optional: {}, bundled: [] },
        tarball: { path: creator, integrity: integrity('creator tarball') },
      },
    ],
    gates: {
      requiredCi: [{
        name: 'Check / full',
        status: 'PASSED',
        commitSha,
        evidenceUrl: 'https://github.com/cordisx/cordisx/actions/runs/1',
      }],
      review: {
        status: 'APPROVED',
        commitSha,
        actor: 'maintainer',
        evidenceUrl: 'https://github.com/cordisx/cordisx/pull/1',
      },
    },
  }
  return { root, cordisx, creator, input }
}

describe('release manifest identity', () => {
  it('records exact package bytes, dependency inputs, CI, review, and release identity', async () => {
    const { root, input } = await fixture()
    const manifest = await createReleaseManifest(input)

    await expect(verifyReleaseManifest(manifest, { artifactRoot: root, commitSha })).resolves.toBe(manifest)
    expect(manifest).toMatchObject({
      source: { commitSha, clean: true },
      release: { version: '0.1.0-beta.20', distTag: 'beta' },
      lifecycle: { phases: ['PUBLISHED', 'VISIBLE', 'VERIFIED', 'DISTRIBUTED'] },
      gates: { review: { status: 'APPROVED' } },
    })
    expect(manifest.packages[0]).toMatchObject({
      dependencies: { runtime: { '@cordisx/protocol': '0.1.0-beta.7' } },
      tarball: { file: 'cordisx.tgz', integrity: integrity('cordisx tarball') },
    })
  })

  it('rejects a tarball whose declared integrity differs from its bytes', async () => {
    const { input } = await fixture()
    input.packages[0].tarball.integrity = integrity('different tarball')
    await expect(createReleaseManifest(input)).rejects.toThrow('tarball integrity does not match its bytes')
  })

  it('invalidates the manifest when the expected commit SHA changes', async () => {
    const { input } = await fixture()
    const manifest = await createReleaseManifest(input)
    await expect(verifyReleaseManifest(manifest, {
      commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    })).rejects.toThrow('release manifest commit SHA mismatch')
  })

  it('rejects changed tarball bytes during recovery verification', async () => {
    const { root, cordisx, input } = await fixture()
    const manifest = await createReleaseManifest(input)
    await writeFile(cordisx, 'mutated after manifest creation')

    await expect(verifyReleaseManifest(manifest, { artifactRoot: root, commitSha })).rejects.toThrow(
      'cordisx tarball size mismatch',
    )
  })

  it('requires all CI and review evidence to bind the same exact commit', async () => {
    const { input } = await fixture()
    input.gates.requiredCi[0].commitSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    await expect(createReleaseManifest(input)).rejects.toThrow('required CI gate Check / full commit SHA mismatch')
  })
})

describe('release recovery state', () => {
  it('advances through distinct phases and resumes at the first incomplete phase', async () => {
    const { input } = await fixture()
    const manifest = await createReleaseManifest(input)
    let state = createReleaseState(manifest, { at: '2026-09-21T00:00:01.000Z' })
    expect(verifyReleaseState(state, manifest)).toEqual({
      checkpoint: 'PREPARED',
      nextPhase: 'PUBLISHED',
      complete: false,
    })

    state = advanceReleaseState(state, manifest, 'PUBLISHED', {
      packages: ['cordisx', 'create-cordisx-plugin'],
    }, {
      at: '2026-09-21T00:01:00.000Z',
      commitSha,
    })
    state = advanceReleaseState(state, manifest, 'VISIBLE', {
      packages: ['cordisx', 'create-cordisx-plugin'],
    }, {
      at: '2026-09-21T00:02:00.000Z',
      commitSha,
    })
    expect(verifyReleaseState(state, manifest, { commitSha })).toEqual({
      checkpoint: 'VISIBLE',
      nextPhase: 'VERIFIED',
      complete: false,
    })
  })

  it('makes a repeated completed phase a no-op instead of repeating work', async () => {
    const { input } = await fixture()
    const manifest = await createReleaseManifest(input)
    const state = advanceReleaseState(
      createReleaseState(manifest),
      manifest,
      'PUBLISHED',
      { packages: ['cordisx', 'create-cordisx-plugin'] },
      { at: '2026-09-21T00:01:00.000Z' },
    )
    expect(advanceReleaseState(state, manifest, 'PUBLISHED', { ignored: true })).toBe(state)
  })

  it('does not checkpoint a phase until evidence covers every package', async () => {
    const { input } = await fixture()
    const manifest = await createReleaseManifest(input)
    const state = createReleaseState(manifest)
    expect(() => advanceReleaseState(state, manifest, 'PUBLISHED', { packages: ['cordisx'] })).toThrow(
      'release phase PUBLISHED evidence must cover the complete package set',
    )
  })

  it('refuses to skip a recovery prerequisite', async () => {
    const { input } = await fixture()
    const manifest = await createReleaseManifest(input)
    const state = createReleaseState(manifest)
    expect(() =>
      advanceReleaseState(state, manifest, 'VERIFIED', {
        packages: ['cordisx', 'create-cordisx-plugin'],
        cleanInstall: true,
      })
    ).toThrow(
      'release phase VERIFIED cannot run before PUBLISHED',
    )
  })

  it('invalidates saved recovery state when the manifest or commit changes', async () => {
    const { input } = await fixture()
    const manifest = await createReleaseManifest(input)
    const state = createReleaseState(manifest)
    const changedManifest = structuredClone(manifest)
    changedManifest.packages[0].tarball.sha512 = 'a'.repeat(128)

    expect(() => verifyReleaseState(state, changedManifest)).toThrow('release state manifest digest mismatch')
    expect(() =>
      verifyReleaseState(state, manifest, {
        commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      })
    ).toThrow('release state does not belong to the checked-out commit')
  })

  it('persists and resumes from the saved recovery point without rebuilding artifacts', async () => {
    const { root, input } = await fixture()
    const manifest = await createReleaseManifest(input)
    const state = advanceReleaseState(
      createReleaseState(manifest),
      manifest,
      'PUBLISHED',
      { packages: ['cordisx', 'create-cordisx-plugin'] },
      { at: '2026-09-21T00:01:00.000Z' },
    )
    const manifestFile = path.join(root, 'release-manifest.json')
    const stateFile = path.join(root, 'release-state.json')
    await writeReleaseFiles({ manifestFile, stateFile, manifest, state })

    const loaded = await readReleaseFiles({ manifestFile, stateFile, artifactRoot: root, commitSha })
    expect(loaded.recovery).toEqual({ checkpoint: 'PUBLISHED', nextPhase: 'VISIBLE', complete: false })
    expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual(state)
  })

  it('refuses to overwrite a one-time manifest and its initial state', async () => {
    const { root, input } = await fixture()
    const manifest = await createReleaseManifest(input)
    const state = createReleaseState(manifest)
    const manifestFile = path.join(root, 'release-manifest.json')
    const stateFile = path.join(root, 'release-state.json')
    await writeReleaseFiles({ manifestFile, stateFile, manifest, state })

    await expect(writeReleaseFiles({ manifestFile, stateFile, manifest, state })).rejects.toMatchObject({
      code: 'EEXIST',
    })
  })

  it('reaches a terminal distributed recovery point only after every phase completes', async () => {
    const { input } = await fixture()
    const manifest = await createReleaseManifest(input)
    let state = createReleaseState(manifest)
    for (const phase of ['PUBLISHED', 'VISIBLE', 'VERIFIED', 'DISTRIBUTED'] as const) {
      state = advanceReleaseState(state, manifest, phase, {
        packages: ['cordisx', 'create-cordisx-plugin'],
        phase,
      }, { at: '2026-09-21T00:10:00.000Z' })
    }
    expect(verifyReleaseState(state, manifest)).toEqual({
      checkpoint: 'DISTRIBUTED',
      nextPhase: null,
      complete: true,
    })
  })
})

describe('release manifest serialization', () => {
  it('uses a stable digest independent of object key insertion order', async () => {
    const { input } = await fixture()
    const manifest = await createReleaseManifest(input)
    const reordered = { ...manifest, release: { ...manifest.release } }
    expect(releaseManifestDigest(reordered)).toBe(releaseManifestDigest(manifest))
  })
})
