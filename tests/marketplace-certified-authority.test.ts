import { chmod, lstat, mkdir, mkdtemp, readFile, stat, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MARKETPLACE_TRUST_SOURCE,
  ensureHomeConfig,
  updateHomeConfigAtomic,
  type HomeConfigMarketplaceTrustSource,
} from '../packages/cli/src/config/home-config.js'
import {
  LauncherMarketplaceCertifiedAuthority,
  type LauncherMarketplaceFeedFetcher,
} from '../packages/cli/src/launcher/marketplace-certified-authority.js'

const PLUGIN_SOURCE = 'https://github.com/cordisx/trusted-smoke'
const INTEGRITY = `sha256:${'a'.repeat(64)}`
const ALTERNATE_ROOT = 'https://marketplace.example/trust.json'
const BASE_FEED = JSON.parse(await readFile(new URL('./fixtures/marketplace-trust-v3.json', import.meta.url), 'utf8')) as Record<string, unknown>

interface Fixture {
  readonly homeDir: string
  readonly configPath: string
}

async function fixture(sources: readonly HomeConfigMarketplaceTrustSource[] = [{
  url: DEFAULT_MARKETPLACE_TRUST_SOURCE,
  enabled: true,
}]): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-certified-authority-'))
  const homeDir = path.join(root, 'home')
  const configPath = path.join(homeDir, 'config.json')
  await ensureHomeConfig(configPath)
  await updateHomeConfigAtomic(current => ({ ...current, marketplaceTrustSources: sources }), configPath)
  return { homeDir, configPath }
}

function trustFeed(options: {
  readonly root?: string
  readonly generatedAt?: string
  readonly status?: 'active' | 'revoked'
  readonly expiresAt?: string
  readonly mutate?: (feed: Record<string, unknown>) => void
} = {}): string {
  const feed = structuredClone(BASE_FEED) as Record<string, unknown>
  feed.generatedAt = options.generatedAt ?? '2026-08-24T12:31:00Z'
  const trust = feed.trust as Record<string, unknown>
  trust.root = options.root ?? DEFAULT_MARKETPLACE_TRUST_SOURCE
  const certification = (feed.certifications as Array<Record<string, unknown>>)[0] as Record<string, unknown>
  certification.expiresAt = options.expiresAt ?? '2027-08-20T00:00:00Z'
  certification.status = options.status ?? 'active'
  if (options.status === 'revoked') certification.revokedAt = '2026-08-24T18:00:00Z'
  else delete certification.revokedAt
  options.mutate?.(feed)
  return JSON.stringify(feed)
}

function exactIdentity(integrity = INTEGRITY): Record<string, string> {
  return { source: PLUGIN_SOURCE, pluginId: 'trusted-smoke', version: '1.2.3', integrity }
}

async function open(
  target: Fixture,
  fetcher: LauncherMarketplaceFeedFetcher,
  options: { readonly now?: () => number; readonly requestTimeoutMs?: number; readonly maxConcurrentFetches?: number } = {},
): Promise<LauncherMarketplaceCertifiedAuthority> {
  return await LauncherMarketplaceCertifiedAuthority.open({
    ...target,
    profileId: 'default',
    fetcher,
    watchConfig: false,
    ...options,
  })
}

describe('Launcher Marketplace Certified authority', () => {
  it('returns only the exact Certified projection from Host-private source configuration', async () => {
    const target = await fixture()
    const text = trustFeed()
    const authority = await open(target, async url => ({ url, status: 200, text }))
    try {
      const result = await authority.lookup(exactIdentity())
      expect(result.projection).toEqual(expect.objectContaining({
        kind: 'cordisx-certified-permission-eligibility',
        source: PLUGIN_SOURCE,
        pluginId: 'trusted-smoke',
        version: '1.2.3',
        integrity: INTEGRITY,
        feed: expect.objectContaining({ root: DEFAULT_MARKETPLACE_TRUST_SOURCE }),
      }))
      expect(Object.keys(result.projection ?? {})).not.toContain('official')
      expect((await authority.lookup(exactIdentity(`sha256:${'b'.repeat(64)}`))).projection).toBeUndefined()
    } finally {
      await authority.dispose()
    }
  })

  it('rejects renderer/plugin self-report fields and tombstones a successful malicious feed', async () => {
    const target = await fixture()
    let text = trustFeed()
    const authority = await open(target, async url => ({ url, status: 200, text }))
    try {
      await expect(authority.lookup({ ...exactIdentity(), certification: { status: 'active' } }))
        .rejects.toThrow('certification is unsupported')
      await expect(authority.lookup({ ...exactIdentity(), official: true }))
        .rejects.toThrow('official is unsupported')

      text = trustFeed({
        generatedAt: '2026-08-25T12:31:00Z',
        mutate(feed) {
          ((feed.plugins as Array<Record<string, unknown>>)[0] as Record<string, unknown>).certified = true
        },
      })
      await authority.refresh()
      expect(authority.snapshot().projections).toEqual([])

      text = trustFeed()
      await authority.refresh()
      expect(authority.snapshot().projections).toEqual([])
    } finally {
      await authority.dispose()
    }
  })

  it('removes a projection on source disable/removal and requires a fresh fetch before re-enable', async () => {
    const target = await fixture()
    const text = trustFeed()
    let fetches = 0
    const authority = await open(target, async url => {
      fetches += 1
      return { url, status: 200, text }
    })
    try {
      const revisions: number[] = []
      authority.subscribe(revision => revisions.push(revision))
      const before = authority.snapshot().revision
      await updateHomeConfigAtomic(current => ({ ...current, marketplaceTrustSources: [] }), target.configPath)
      await authority.refresh()
      expect(authority.snapshot().projections).toEqual([])
      expect(authority.snapshot().revision).toBeGreaterThan(before)
      const disabledFetches = fetches
      await authority.refresh()
      expect(fetches).toBe(disabledFetches)

      await updateHomeConfigAtomic(current => ({
        ...current,
        marketplaceTrustSources: [{ url: DEFAULT_MARKETPLACE_TRUST_SOURCE, enabled: true }],
      }), target.configPath)
      await authority.refresh()
      expect(fetches).toBe(disabledFetches + 1)
      expect(authority.snapshot().projections).toHaveLength(1)
      expect(revisions.length).toBeGreaterThanOrEqual(2)
    } finally {
      await authority.dispose()
    }
  })

  it('watches Host config replacement and emits invalidation without renderer participation', async () => {
    const target = await fixture()
    const text = trustFeed()
    const authority = await LauncherMarketplaceCertifiedAuthority.open({
      ...target,
      profileId: 'default',
      fetcher: async url => ({ url, status: 200, text }),
    })
    try {
      const before = authority.snapshot().revision
      const invalidated = new Promise<number>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('config watcher did not invalidate')), 2_000)
        authority.subscribe(revision => {
          clearTimeout(timeout)
          resolve(revision)
        })
      })
      await updateHomeConfigAtomic(current => ({ ...current, marketplaceTrustSources: [] }), target.configPath)
      expect(await invalidated).toBeGreaterThan(before)
      expect(authority.snapshot().projections).toEqual([])
    } finally {
      await authority.dispose()
    }
  })

  it('persists a monotonic rollback fence so old active replay cannot replace a revocation', async () => {
    const target = await fixture()
    let text = trustFeed()
    let authority = await open(target, async url => ({ url, status: 200, text }))
    expect(authority.snapshot().projections).toHaveLength(1)
    await authority.dispose()

    text = trustFeed({ status: 'revoked', generatedAt: '2026-08-25T12:31:00Z' })
    authority = await open(target, async url => ({ url, status: 200, text }))
    expect(authority.snapshot().projections).toEqual([])
    const revokedRevision = authority.snapshot().revision
    await authority.dispose()

    text = trustFeed({ generatedAt: '2026-08-24T12:31:00Z' })
    authority = await open(target, async url => ({ url, status: 200, text }))
    try {
      expect(authority.snapshot().projections).toEqual([])
      expect(authority.snapshot().revision).toBe(revokedRevision)
    } finally {
      await authority.dispose()
    }
  })

  it('fails closed on same-revision divergence and exact artifact identity mismatch', async () => {
    const target = await fixture()
    let text = trustFeed()
    const authority = await open(target, async url => ({ url, status: 200, text }))
    try {
      text = trustFeed({ mutate(feed) { feed.name = 'Divergent Marketplace' } })
      await authority.refresh()
      expect(authority.snapshot().projections).toEqual([])

      text = trustFeed()
      await authority.refresh()
      expect(authority.snapshot().projections).toEqual([])

      text = trustFeed({
        generatedAt: '2026-08-25T12:31:00Z',
        mutate(feed) {
          const plugin = (feed.plugins as Array<Record<string, unknown>>)[0] as Record<string, unknown>
          ;(plugin.artifact as Record<string, unknown>).integrity = `sha256:${'c'.repeat(64)}`
        },
      })
      await authority.refresh()
      expect(authority.snapshot().projections).toEqual([])

      text = trustFeed({ generatedAt: '2026-08-26T12:31:00Z' })
      await authority.refresh()
      expect(authority.snapshot().projections).toHaveLength(1)
    } finally {
      await authority.dispose()
    }
  })

  it('does not follow a fetch result to an unconfigured final trust root', async () => {
    const target = await fixture()
    let redirected = false
    const authority = await open(target, async url => ({
      url: redirected ? ALTERNATE_ROOT : url,
      status: 200,
      text: trustFeed({ root: redirected ? ALTERNATE_ROOT : url }),
    }))
    try {
      expect(authority.snapshot().projections).toHaveLength(1)
      redirected = true
      await authority.refresh()
      expect(authority.snapshot().projections).toEqual([])
    } finally {
      await authority.dispose()
    }
  })

  it('excludes an exact artifact asserted by more than one configured trust root', async () => {
    const target = await fixture([
      { url: DEFAULT_MARKETPLACE_TRUST_SOURCE, enabled: true },
      { url: ALTERNATE_ROOT, enabled: true },
    ])
    const authority = await open(target, async url => ({ url, status: 200, text: trustFeed({ root: url }) }))
    try {
      expect(authority.snapshot().projections).toEqual([])
      expect((await authority.lookup(exactIdentity())).projection).toBeUndefined()
    } finally {
      await authority.dispose()
    }
  })

  it('cuts off expiry locally and emits revision-only invalidation without a feed replacement', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-25T00:00:00Z'))
    const target = await fixture()
    const text = trustFeed({ expiresAt: '2026-08-25T00:00:01Z' })
    const authority = await open(target, async url => ({ url, status: 200, text }))
    try {
      expect(authority.snapshot().projections).toHaveLength(1)
      const before = authority.snapshot().revision
      const invalidated = new Promise<number>(resolve => authority.subscribe(resolve))
      await vi.advanceTimersByTimeAsync(1_001)
      const revision = await invalidated
      expect(revision).toBeGreaterThan(before)
      expect(authority.snapshot().projections).toEqual([])
    } finally {
      await authority.dispose()
      vi.useRealTimers()
    }
  })

  it('bounds feed concurrency and request timeout', async () => {
    const sources = Array.from({ length: 5 }, (_, index) => ({
      url: `https://marketplace.example/${index}.json`,
      enabled: true,
    }))
    const target = await fixture(sources)
    let active = 0
    let maximum = 0
    const authority = await open(target, async url => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise<void>(resolve => setImmediate(resolve))
      active -= 1
      return { url, status: 503, text: '' }
    }, { maxConcurrentFetches: 2 })
    expect(maximum).toBe(2)
    await authority.dispose()

    const timeoutTarget = await fixture()
    const startedAt = Date.now()
    const timedOut = await open(timeoutTarget, async () => await new Promise<never>(() => undefined), { requestTimeoutMs: 10 })
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(timedOut.snapshot().projections).toEqual([])
    await timedOut.dispose()
  })

  it.skipIf(process.platform === 'win32')('keeps state private and rejects a symbolic-link state target', async () => {
    const target = await fixture()
    const text = trustFeed()
    const authority = await open(target, async url => ({ url, status: 200, text }))
    const stateFile = path.join(target.homeDir, 'state', 'marketplace-certified', 'default.v1.json')
    expect((await stat(stateFile)).mode & 0o777).toBe(0o600)
    expect((await stat(path.dirname(stateFile))).mode & 0o777).toBe(0o700)
    await authority.dispose()

    const second = await fixture()
    const directory = path.join(second.homeDir, 'state', 'marketplace-certified')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const outside = path.join(path.dirname(second.homeDir), 'outside.json')
    await symlink(outside, path.join(directory, 'default.v1.json'))
    await expect(open(second, async url => ({ url, status: 200, text }))).rejects.toThrow('regular file')
    expect((await lstat(path.join(directory, 'default.v1.json'))).isSymbolicLink()).toBe(true)
  })
})
