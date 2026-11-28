import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { createStandaloneMarketplaceTrustFilter } from '../packages/cli/src/launcher/standalone-marketplace-trust.js'
import { normalizeCertifiedPermissionProjectionV1 } from '../packages/cli/src/permission-model-v4.js'
import { evaluateMarketplaceTrust } from '../packages/cli/src/renderer/marketplace-trust.js'

it('preserves public Marketplace trust while excluding owner-private trust roots', async () => {
  const modulePath = fileURLToPath(new URL('../packages/cli/src/renderer/marketplace-trust.ts', import.meta.url))
  const filter = createStandaloneMarketplaceTrustFilter([modulePath])
  const built = await build({
    entryPoints: [modulePath],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    minifySyntax: true,
    write: false,
    plugins: [filter.plugin],
  })
  expect(filter.applied()).toBe(true)
  const code = built.outputFiles[0]!.text
  const original = await readFile(modulePath, 'utf8')
  const privateSource = /const INTERNAL_SOURCE = '([^']+)'/u.exec(original)?.[1]
  if (privateSource) expect(code.includes(privateSource)).toBe(false)
  const standalone = await import(
    /* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
  ) as typeof import('../packages/cli/src/renderer/marketplace-trust.js')
  const feed = JSON.parse(await readFile(new URL('./fixtures/marketplace-trust-v3.json', import.meta.url), 'utf8'))
  const plugins = feed.plugins.map((plugin: { source: string; id: string }) => ({
    ...plugin,
    identity: plugin.source + '\u0000' + plugin.id,
  }))
  const options = { feedUrl: feed.trust.root, trustedRoots: [feed.trust.root], now: feed.generatedAt }
  expect(standalone.evaluateMarketplaceTrust(feed, plugins, options)).toEqual(
    evaluateMarketplaceTrust(feed, plugins, options),
  )
  const privateAuthority = /const INTERNAL_TRUST_AUTHORITY = '([^']+)'/u.exec(original)?.[1]
  if (privateAuthority) {
    expect(() =>
      standalone.evaluateMarketplaceTrust(
        {
          ...feed,
          trust: { ...feed.trust, authority: privateAuthority },
        },
        plugins,
        options,
      )
    ).toThrow()
  }
})

it('preserves public certified permission validation in the standalone bundle', async () => {
  const modulePath = fileURLToPath(new URL('../packages/cli/src/permission-model-v4.ts', import.meta.url))
  const filter = createStandaloneMarketplaceTrustFilter([modulePath])
  const built = await build({
    entryPoints: [modulePath],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    minifySyntax: true,
    write: false,
    plugins: [filter.plugin],
  })
  expect(filter.applied()).toBe(true)
  const code = built.outputFiles[0]!.text
  const trustCode = await readFile(
    new URL('../packages/cli/src/renderer/marketplace-trust.ts', import.meta.url),
    'utf8',
  )
  const privateSource = /const INTERNAL_SOURCE = '([^']+)'/u.exec(trustCode)?.[1]
  if (privateSource) expect(code.includes(privateSource)).toBe(false)
  const standalone = await import(
    /* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
  ) as typeof import('../packages/cli/src/permission-model-v4.js')
  const feed = JSON.parse(await readFile(new URL('./fixtures/marketplace-trust-v3.json', import.meta.url), 'utf8'))
  const plugin = feed.plugins[0]
  const key = plugin.source + '\u0000' + plugin.id
  const trust = evaluateMarketplaceTrust(feed, [{ ...plugin, identity: key }], {
    feedUrl: feed.trust.root,
    trustedRoots: [feed.trust.root],
    now: feed.generatedAt,
  })
  const projection = trust.byPluginIdentity.get(key)?.certifiedPermission
  if (!projection) throw new Error('public certification fixture unavailable')
  const identity = { source: plugin.source, pluginId: plugin.id }
  const artifact = { version: plugin.version, integrity: plugin.artifact.integrity }
  const now = new Date(feed.generatedAt)
  const expected = normalizeCertifiedPermissionProjectionV1(projection, identity, artifact, now)
  expect(expected).toBeDefined()
  expect(standalone.normalizeCertifiedPermissionProjectionV1(projection, identity, artifact, now)).toEqual(expected)
})
