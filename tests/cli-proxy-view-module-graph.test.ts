import path from 'node:path'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { modelKey, parsedModel, sessionKey } from '../packages/cli/src/plugins/cli-proxy-api/model.js'

describe('CLI Proxy provider fleet modules', () => {
  it('bundles the view, model, and maintained stylesheet into one real browser graph', async () => {
    const result = await build({
      entryPoints: [path.resolve('packages/cli/src/plugins/cli-proxy-api/view.tsx')],
      bundle: true,
      write: false,
      metafile: true,
      platform: 'browser',
      format: 'esm',
      jsx: 'automatic',
      jsxImportSource: 'cordisx/react',
      external: [
        '@deepseek-ai/cordis',
        'cordisx/react',
        'cordisx/react/jsx-runtime',
        'cordisx/ui',
      ],
      loader: { '.css': 'text' },
    })

    const inputs = Object.keys(result.metafile.inputs).map(input => input.replaceAll('\\', '/'))
    expect(inputs.some(input => input.endsWith('/cli-proxy-api/view.tsx'))).toBe(true)
    expect(inputs.some(input => input.endsWith('/cli-proxy-api/model.ts'))).toBe(true)
    expect(inputs.some(input => input.endsWith('/cli-proxy-api/view.css'))).toBe(true)
    expect(result.outputFiles[0]?.text).toContain('.cxp-fleet')
  })

  it('round-trips only complete provider and session references', () => {
    const model = { providerId: 'gateway-a', modelId: 'gpt-codex' }
    const session = { providerId: 'gateway-a', remoteSessionId: 'session-1' }

    expect(parsedModel(modelKey(model))).toEqual(model)
    expect(sessionKey(session)).toBe(JSON.stringify(['gateway-a', 'session-1']))
    expect(parsedModel(JSON.stringify(['gateway-a']))).toBeUndefined()
    expect(parsedModel(JSON.stringify(['gateway-a', 42]))).toBeUndefined()
    expect(parsedModel('{')).toBeUndefined()
  })
})
