import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { type Plugin, transform } from 'esbuild'

/** Keep owner-private trust roots out of an independently served renderer. */
export function createStandaloneMarketplaceTrustFilter(modulePaths: readonly string[]): {
  readonly plugin: Plugin
  readonly applied: () => boolean
} {
  const expected = new Set(modulePaths.map(modulePath => path.resolve(modulePath)))
  const seen = new Set<string>()
  return {
    applied: () => expected.size > 0 && [...expected].every(modulePath => seen.has(modulePath)),
    plugin: {
      name: 'standalone-public-marketplace-trust',
      setup(build) {
        build.onLoad({ filter: /(?:marketplace-trust|permission-model-v4)\.(?:js|ts)$/ }, async input => {
          const modulePath = path.resolve(input.path)
          if (!expected.has(modulePath)) return undefined
          const source = await readFile(input.path, 'utf8')
          const result = await transform(source, {
            loader: input.path.endsWith('.ts') ? 'ts' : 'js',
            minifySyntax: true,
            define: { __CORDISX_STANDALONE_PUBLIC_TRUST__: 'true' },
          })
          seen.add(modulePath)
          return { contents: result.code, loader: 'js', resolveDir: path.dirname(input.path) }
        })
      },
    },
  }
}
