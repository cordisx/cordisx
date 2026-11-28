import path from 'node:path'
import { build, transform } from 'esbuild'
import { createStandaloneMarketplaceTrustFilter } from './standalone-marketplace-trust.js'

const RUNTIME_NAME = '__cordisxStandaloneHostCore'
const MAX_RUNTIME_BYTES = 64 * 1024 * 1024

/** Cache only immutable Host code for this owner. Per-renderer composition never enters the cache. */
export class StandaloneRuntimeBundleCache {
  private runtime: { readonly path: string; readonly value: Promise<string> } | undefined
  private closed = false

  async compose(source: string, runtimeImport: string): Promise<string> {
    const header = 'import { installCordisX, installCordisXComposition } from ' + JSON.stringify(runtimeImport)
    if (this.closed || !path.isAbsolute(runtimeImport) || !source.startsWith(header + '\n')) {
      throw new Error('standalone-runtime-bundle-unavailable')
    }
    const entry = 'const { installCordisX, installCordisXComposition } = ' + RUNTIME_NAME + ';\n'
      + source.slice(header.length)
    const [runtime, composition] = await Promise.all([
      this.sharedRuntime(runtimeImport),
      transform(entry, {
        loader: 'ts',
        format: 'esm',
        target: ['chrome120'],
        minifyWhitespace: true,
        minifySyntax: true,
        minifyIdentifiers: false,
        legalComments: 'inline',
      }),
    ])
    if (this.closed) throw new Error('standalone-runtime-bundle-unavailable')
    return runtime + '\n' + composition.code
  }

  close(): void {
    this.closed = true
    this.runtime = undefined
  }

  private sharedRuntime(runtimeImport: string): Promise<string> {
    if (this.closed || this.runtime && this.runtime.path !== runtimeImport) {
      throw new Error('standalone-runtime-bundle-unavailable')
    }
    if (this.runtime) return this.runtime.value
    const value = this.compile(runtimeImport)
    const current = { path: runtimeImport, value }
    this.runtime = current
    void value.catch(() => {
      if (this.runtime === current) this.runtime = undefined
    })
    return value
  }

  private async compile(runtimeImport: string): Promise<string> {
    const extension = runtimeImport.endsWith('.ts') ? 'ts' : 'js'
    const renderer = path.dirname(runtimeImport)
    const trust = createStandaloneMarketplaceTrustFilter([
      path.join(renderer, 'marketplace-trust.' + extension),
      path.join(renderer, '..', 'permission-model-v4.' + extension),
    ])
    const result = await build({
      stdin: {
        contents: 'export { installCordisX, installCordisXComposition } from ' + JSON.stringify(runtimeImport),
        resolveDir: renderer,
        sourcefile: 'cordisx-standalone-runtime.js',
      },
      bundle: true,
      format: 'iife',
      globalName: RUNTIME_NAME,
      platform: 'browser',
      target: ['chrome120'],
      sourcemap: false,
      minifyWhitespace: true,
      minifySyntax: true,
      minifyIdentifiers: false,
      legalComments: 'inline',
      plugins: [trust.plugin],
      loader: { '.svg': 'text', '.css': 'text', '.png': 'dataurl' },
      write: false,
      logLevel: 'silent',
    })
    const output = result.outputFiles[0]
    if (
      !trust.applied() || result.warnings.length > 0 || !output || output.contents.byteLength > MAX_RUNTIME_BYTES
      || this.closed
    ) {
      throw new Error('standalone-runtime-bundle-unavailable')
    }
    return output.text
  }
}
