import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { auditProductionRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { loadConfig } from '../packages/cli/src/launcher/config.js'

// The audited beta.4 failure produced a 97,923,894-byte inline-map payload.
// A no-plugin production build is the stable baseline: keep a material margin
// below the observed CDP failure class without constraining plugin content.
const NO_PLUGIN_PRODUCTION_BUNDLE_BUDGET_BYTES = 40_000_000

describe('production renderer bundle', () => {
  it('keeps the no-plugin CDP payload map-free and below the audited startup budget', async () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const config = await loadConfig(path.join(projectRoot, 'cordisx.config.example.json'))
    const audit = await auditProductionRendererBundle({ ...config, plugins: [] })

    expect(audit.hasInlineSourceMap).toBe(false)
    expect(audit.bytes).toBeLessThanOrEqual(NO_PLUGIN_PRODUCTION_BUNDLE_BUDGET_BYTES)
  }, 90_000)
})
