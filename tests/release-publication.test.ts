import { describe, expect, it, vi } from 'vitest'
import { publishReleasePackages } from '../scripts/release-publication.mjs'
import { retryRegistryPropagation } from '../scripts/registry-release-propagation.mjs'

const version = '0.1.0-beta.10'
const distTag = 'beta'
const gitHead = '1234567890abcdef'
const packages = [
  { name: 'cordisx', workspace: 'cordisx' },
  { name: 'create-cordisx-plugin', workspace: 'create-cordisx-plugin' },
]

function fixture(name: string, overrides = {}) {
  return {
    name,
    version,
    gitHead,
    license: 'AGPL-3.0-or-later',
    repository: { url: 'git+https://github.com/cordisx/cordisx.git' },
    bin: { [name]: 'dist/cli.js' },
    engines: { node: '>=22.19' },
    dist: {
      integrity: `sha512-${name}`,
      attestations: {
        url: 'https://registry.npmjs.org/-/npm/v1/attestations/example',
        provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
      },
    },
    ...overrides,
  }
}

function options(viewVersion: ReturnType<typeof vi.fn>, publish = vi.fn(async () => undefined)) {
  const manifests = new Map(packages.map(pkg => [pkg.name, fixture(pkg.name)]))
  const packs = new Map(packages.map(pkg => [pkg.name, { integrity: `sha512-${pkg.name}` }]))
  return {
    packages,
    manifests,
    packs,
    version,
    distTag,
    gitHead,
    viewVersion,
    assertRegistryPackage: vi.fn(async () => undefined),
    publish,
    retry: (label: string, operation: (attempt: number) => Promise<unknown>) =>
      retryRegistryPropagation(label, operation, {
        initialDelayMs: 1,
        maxDelayMs: 1,
        timeoutMs: 100,
        wait: async () => undefined,
      }),
    log: vi.fn(),
  }
}

describe('release publication convergence', () => {
  it('submits every missing package before waiting for the first package to become visible', async () => {
    const visible = new Set<string>()
    const submitted: string[] = []
    const viewVersion = vi.fn(async (name: string) => visible.has(name) ? fixture(name) : undefined)
    const publish = vi.fn(async pkg => {
      submitted.push(pkg.name)
      if (submitted.length === packages.length) {
        for (const released of packages) visible.add(released.name)
      }
    })

    await publishReleasePackages(options(viewVersion, publish))
    expect(submitted).toEqual(['cordisx', 'create-cordisx-plugin'])
  })

  it('uses one shared propagation window instead of serial package waits', async () => {
    let elapsed = 0
    const submittedAt = new Map<string, number>()
    const viewVersion = vi.fn(async (name: string) => {
      const submitted = submittedAt.get(name)
      return submitted !== undefined && elapsed - submitted >= 7 * 60 * 1000 ? fixture(name) : undefined
    })
    const input = options(viewVersion, vi.fn(async pkg => submittedAt.set(pkg.name, elapsed)))
    input.retry = (label, operation) =>
      retryRegistryPropagation(label, operation, {
        initialDelayMs: 5000,
        maxDelayMs: 60_000,
        timeoutMs: 10 * 60 * 1000,
        wait: async delay => {
          elapsed += delay
        },
        now: () => elapsed,
        log: vi.fn(),
      })

    await publishReleasePackages(input)

    expect([...submittedAt.values()]).toEqual([0, 0])
    expect(elapsed).toBe(435_000)
    expect(elapsed).toBeLessThan(870_000)
  })

  it('skips an already published package, submits the missing package, then verifies both', async () => {
    let creatorVisible = false
    const viewVersion = vi.fn(async (name: string) => {
      if (name === 'cordisx') return fixture(name)
      return creatorVisible ? fixture(name) : undefined
    })
    const publish = vi.fn(async pkg => {
      expect(pkg.name).toBe('create-cordisx-plugin')
      creatorVisible = true
    })

    await expect(publishReleasePackages(options(viewVersion, publish))).resolves.toEqual([
      { name: 'cordisx' },
      { name: 'create-cordisx-plugin' },
    ])
    expect(publish).toHaveBeenCalledOnce()
  })

  it('treats a publish conflict as pending readback, not proof of matching content', async () => {
    const visible = new Set<string>()
    const viewVersion = vi.fn(async (name: string) => visible.has(name) ? fixture(name) : undefined)
    const publish = vi.fn(async pkg => {
      visible.add(pkg.name)
      if (pkg.name === 'cordisx') {
        const error = new Error('You cannot publish over the previously published versions')
        Object.assign(error, { commandOutput: 'npm error code EPUBLISHCONFLICT' })
        throw error
      }
    })

    await expect(publishReleasePackages(options(viewVersion, publish))).resolves.toHaveLength(2)
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('does not checkpoint a publish conflict before immutable readback succeeds', async () => {
    let reads = 0
    const viewVersion = vi.fn(async (name: string) => {
      reads += 1
      return reads <= packages.length ? undefined : fixture(name, { gitHead: 'different' })
    })
    const publish = vi.fn(async () => {
      const error = new Error('You cannot publish over the previously published versions')
      Object.assign(error, { commandOutput: 'npm error code EPUBLISHCONFLICT' })
      throw error
    })
    const completePhase = vi.fn(async () => undefined)

    await expect(publishReleasePackages({
      ...options(viewVersion, publish),
      completePhase,
    })).rejects.toThrow('registry gitHead mismatch')
    expect(completePhase).not.toHaveBeenCalled()
  })

  it('fails before publishing when an existing tarball digest differs', async () => {
    const viewVersion = vi.fn(async (name: string) =>
      fixture(name, {
        dist: { ...fixture(name).dist, integrity: 'sha512-wrong' },
      })
    )
    const input = options(viewVersion)

    await expect(publishReleasePackages(input)).rejects.toThrow('registry tarball integrity mismatch')
    expect(input.publish).not.toHaveBeenCalled()
  })

  it('fails before publishing when an existing gitHead differs', async () => {
    const viewVersion = vi.fn(async (name: string) => fixture(name, { gitHead: 'different' }))
    const input = options(viewVersion)

    await expect(publishReleasePackages(input)).rejects.toThrow('registry gitHead mismatch')
    expect(input.publish).not.toHaveBeenCalled()
  })

  it('resumes visibility without publishing or rebuilding', async () => {
    let attempt = 0
    const viewVersion = vi.fn(async (name: string) => attempt === 0 ? undefined : fixture(name))
    const input = options(viewVersion)
    const build = vi.fn()
    input.retry = async (_label, operation) => {
      attempt += 1
      return operation(attempt)
    }

    await expect(publishReleasePackages({
      ...input,
      startPhase: 'VISIBLE',
    })).resolves.toHaveLength(2)
    expect(input.publish).not.toHaveBeenCalled()
    expect(build).not.toHaveBeenCalled()
  })

  it('records canonical phase evidence without defining a second recovery schema', async () => {
    const visible = new Set<string>()
    const completePhase = vi.fn(async () => undefined)
    const viewVersion = vi.fn(async (name: string) => visible.has(name) ? fixture(name) : undefined)
    const input = options(viewVersion, vi.fn(async pkg => visible.add(pkg.name)))

    await publishReleasePackages({
      ...input,
      completePhase,
      run: { workflowRunId: '1234', workflowRunAttempt: 2 },
    })

    expect(completePhase).toHaveBeenNthCalledWith(1, {
      phase: 'PUBLISHED',
      evidence: {
        packages: ['cordisx', 'create-cordisx-plugin'],
        submittedPackages: ['cordisx', 'create-cordisx-plugin'],
        matchedPackages: [],
        publishConflicts: [],
        workflowRunId: '1234',
        workflowRunAttempt: 2,
      },
    })
    expect(completePhase).toHaveBeenNthCalledWith(2, {
      phase: 'VISIBLE',
      evidence: {
        packages: ['cordisx', 'create-cordisx-plugin'],
        registryReadbackAttempt: 1,
        immutableMetadata: true,
        provenance: true,
        workflowRunId: '1234',
        workflowRunAttempt: 2,
      },
    })
  })
})
