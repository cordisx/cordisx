import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertReleaseRecoveryPackage,
  loadReleaseRecoveryState,
  readPreparedArtifactIdentity,
  releaseRecoveryIdentity,
  releaseRecoveryStages,
  updateReleaseRecoveryState,
} from '../scripts/release-recovery-state.mjs'

const identity = releaseRecoveryIdentity({
  tag: 'v0.1.0-beta.20',
  version: '0.1.0-beta.20',
  gitHead: '1234567890abcdef',
  registry: 'https://registry.npmjs.org',
  artifactSha512: 'artifact-sha512',
  packageIntegrities: {
    cordisx: 'sha512-cordisx',
    'create-cordisx-plugin': 'sha512-create-cordisx-plugin',
  },
})

describe('npm release recovery state', () => {
  it('persists a recovery point and resumes it on the next run attempt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-release-state-'))
    const file = path.join(root, 'state.json')
    let state = await loadReleaseRecoveryState(file, { identity, runId: '1234', runAttempt: 1 })
    state = await updateReleaseRecoveryState(file, state, {
      nextAction: 'visibility',
      phaseAttempt: 3,
      uploadedPackages: ['cordisx', 'create-cordisx-plugin'],
    })

    await expect(loadReleaseRecoveryState(file, {
      identity,
      runId: '1234',
      runAttempt: 2,
    })).resolves.toMatchObject({
      runAttempt: 2,
      phaseAttempt: 3,
      nextAction: 'visibility',
      uploadedPackages: ['cordisx', 'create-cordisx-plugin'],
    })
    expect(JSON.parse(await readFile(file, 'utf8')).runAttempt).toBe(1)
  })

  it('fails closed when the saved artifact or package integrity changes', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-release-state-'))
    const file = path.join(root, 'state.json')
    const state = await loadReleaseRecoveryState(file, { identity, runId: '1234', runAttempt: 1 })
    await updateReleaseRecoveryState(file, state, {})

    await expect(loadReleaseRecoveryState(file, {
      identity: { ...identity, artifactSha512: 'different' },
      runId: '1234',
      runAttempt: 2,
    })).rejects.toThrow('release recovery artifactSha512 mismatch')
    await expect(loadReleaseRecoveryState(file, {
      identity: {
        ...identity,
        packageIntegrities: { ...identity.packageIntegrities, cordisx: 'sha512-different' },
      },
      runId: '1234',
      runAttempt: 2,
    })).rejects.toThrow('release recovery package integrity set mismatch')
  })

  it('fails closed when registry content differs from the checkpoint', () => {
    expect(() =>
      assertReleaseRecoveryPackage(
        {
          version: identity.version,
          gitHead: identity.gitHead,
          dist: { integrity: identity.packageIntegrities.cordisx },
        },
        'cordisx',
        identity,
      )
    ).not.toThrow()
    expect(() =>
      assertReleaseRecoveryPackage(
        {
          version: identity.version,
          gitHead: identity.gitHead,
          dist: { integrity: 'sha512-different' },
        },
        'cordisx',
        identity,
      )
    ).toThrow('cordisx registry tarball integrity mismatch')
  })

  it('binds recovery to the prepared artifact identity', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-release-state-'))
    const file = path.join(root, 'prepared.tgz.json')
    await writeFile(
      file,
      JSON.stringify({
        tag: identity.tag,
        version: identity.version,
        gitHead: identity.gitHead,
        packages: ['cordisx', 'create-cordisx-plugin'],
        sha512: identity.artifactSha512,
      }),
    )

    await expect(readPreparedArtifactIdentity(file, {
      tag: identity.tag,
      version: identity.version,
      gitHead: identity.gitHead,
      packages: ['cordisx', 'create-cordisx-plugin'],
    })).resolves.toBe(identity.artifactSha512)
    await expect(readPreparedArtifactIdentity(file, {
      tag: identity.tag,
      version: identity.version,
      gitHead: 'different',
      packages: ['cordisx', 'create-cordisx-plugin'],
    })).rejects.toThrow('prepared release artifact gitHead mismatch')
  })

  it('limits a retry to publication, visibility, verification, and clean install without rebuilding', () => {
    expect(releaseRecoveryStages('upload')).toEqual([
      'upload',
      'visibility',
      'verification',
      'clean-install',
    ])
    expect(releaseRecoveryStages('verification')).toEqual(['verification', 'clean-install'])
    expect(releaseRecoveryStages('clean-install')).toEqual(['clean-install'])
    expect(releaseRecoveryStages('complete')).toEqual([])
    expect(releaseRecoveryStages('upload')).not.toContain('build')
  })
})
