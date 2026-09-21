import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createReleaseManifest,
  createReleaseState,
  verifyReleaseState,
  writeReleaseFiles,
} from '../scripts/release-manifest.mjs'
import {
  advanceReleaseRecovery,
  assertReleaseRecoveryPackage,
  loadReleaseRecovery,
  releaseRecoveryStages,
} from '../scripts/release-recovery-state.mjs'

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-publication-state-'))
  created.push(root)
  const packageRoot = path.join(root, 'packages')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(packageRoot)
  const packageFiles = [
    ['cordisx', 'cordisx.tgz', 'cordisx tarball'],
    ['create-cordisx-plugin', 'creator.tgz', 'creator tarball'],
  ] as const
  for (const [, file, contents] of packageFiles) await writeFile(path.join(packageRoot, file), contents)
  const manifest = await createReleaseManifest({
    createdAt: '2026-09-21T00:00:00.000Z',
    source: { repository: 'cordisx/cordisx', commitSha, clean: true },
    release: {
      tag: 'v0.1.0-beta.20',
      version: '0.1.0-beta.20',
      registry: 'https://registry.npmjs.org',
      distTag: 'beta',
    },
    packages: packageFiles.map(([name, file, contents]) => ({
      name,
      version: '0.1.0-beta.20',
      dependencies: { runtime: {}, optional: {}, bundled: [] },
      tarball: { path: path.join(packageRoot, file), integrity: integrity(contents) },
    })),
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
  })
  const state = createReleaseState(manifest, { at: '2026-09-21T00:00:01.000Z' })
  const manifestFile = path.join(root, 'release-manifest.json')
  const stateFile = path.join(root, 'release-state.json')
  await writeReleaseFiles({ manifestFile, stateFile, manifest, state })
  return { root, packageRoot, manifestFile, stateFile, manifest, state }
}

describe('npm publication release-state adapter', () => {
  it('loads only a manifest and state bound to the exact release identity', async () => {
    const input = await fixture()
    await expect(loadReleaseRecovery({
      manifestFile: input.manifestFile,
      stateFile: input.stateFile,
      artifactRoot: input.packageRoot,
      commitSha,
      tag: 'v0.1.0-beta.20',
      version: '0.1.0-beta.20',
      registry: 'https://registry.npmjs.org',
      distTag: 'beta',
      packages: ['cordisx', 'create-cordisx-plugin'],
    })).resolves.toMatchObject({
      recovery: { checkpoint: 'PREPARED', nextPhase: 'PUBLISHED' },
    })

    await expect(loadReleaseRecovery({
      manifestFile: input.manifestFile,
      stateFile: input.stateFile,
      artifactRoot: input.packageRoot,
      commitSha,
      tag: 'v0.1.0-beta.20',
      version: '0.1.0-beta.20',
      registry: 'https://registry.example.com',
      distTag: 'beta',
      packages: ['cordisx', 'create-cordisx-plugin'],
    })).rejects.toThrow('release manifest registry mismatch')
  })

  it('persists canonical phase evidence with operational run metadata', async () => {
    const input = await fixture()
    const next = await advanceReleaseRecovery(
      input.stateFile,
      input.state,
      input.manifest,
      'PUBLISHED',
      {
        packages: ['cordisx', 'create-cordisx-plugin'],
        submittedPackages: ['cordisx'],
        matchedPackages: ['create-cordisx-plugin'],
        workflowRunId: '1234',
        workflowRunAttempt: 2,
      },
      { commitSha, at: '2026-09-21T00:01:00.000Z' },
    )

    expect(verifyReleaseState(next, input.manifest, { commitSha })).toEqual({
      checkpoint: 'PUBLISHED',
      nextPhase: 'VISIBLE',
      complete: false,
    })
    expect(JSON.parse(await readFile(input.stateFile, 'utf8')).phases.PUBLISHED.evidence).toMatchObject({
      workflowRunId: '1234',
      workflowRunAttempt: 2,
      submittedPackages: ['cordisx'],
    })
  })

  it('uses only the canonical release phases for resume planning', () => {
    expect(releaseRecoveryStages('PUBLISHED')).toEqual(['PUBLISHED', 'VISIBLE', 'VERIFIED', 'DISTRIBUTED'])
    expect(releaseRecoveryStages('VERIFIED')).toEqual(['VERIFIED', 'DISTRIBUTED'])
    expect(releaseRecoveryStages('DISTRIBUTED')).toEqual(['DISTRIBUTED'])
    expect(releaseRecoveryStages(null)).toEqual([])
    expect(releaseRecoveryStages('PUBLISHED')).not.toContain('build')
  })

  it('checks registry content against manifest tarball identity and commit', async () => {
    const { manifest } = await fixture()
    expect(() =>
      assertReleaseRecoveryPackage(
        {
          version: manifest.release.version,
          gitHead: commitSha,
          dist: { integrity: manifest.packages[0].tarball.integrity },
        },
        'cordisx',
        manifest,
      )
    ).not.toThrow()
    expect(() =>
      assertReleaseRecoveryPackage(
        {
          version: manifest.release.version,
          gitHead: commitSha,
          dist: { integrity: 'sha512-different' },
        },
        'cordisx',
        manifest,
      )
    ).toThrow('cordisx registry tarball integrity mismatch')
  })
})
