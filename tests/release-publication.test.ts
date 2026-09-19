import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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

describe('release scripts under native Node ESM', () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url))

  it('links the publication module without the Vitest module transformer', () => {
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `
      import assert from 'node:assert/strict'
      import { publishReleasePackages } from './scripts/release-publication.mjs'
      assert.equal(typeof publishReleasePackages, 'function')
    `,
    ], { cwd, encoding: 'utf8' })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
  })

  it.each(['release.mjs', 'check-registry-release.mjs'])('%s reaches argument validation in Node', script => {
    // An invalid tag stops before any registry, package or publication operation.
    const result = spawnSync(process.execPath, [`scripts/${script}`, '--tag', 'invalid'], {
      cwd,
      encoding: 'utf8',
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('release tag must be v<semver> without build metadata')
    expect(result.stderr).not.toContain('does not provide an export')
  })
})

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
    viewTags: vi.fn(async () => ({ latest: '0.0.0', beta: version })),
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
      { name: 'cordisx', latest: '0.0.0' },
      { name: 'create-cordisx-plugin', latest: '0.0.0' },
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
})
