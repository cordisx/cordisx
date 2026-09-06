import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('public Channel service boundary', () => {
  it('typechecks an external consumer without Host-private imports or legacy fields', () => {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url))
    expect(() =>
      execFileSync(process.execPath, [
        tsc,
        '--noEmit',
        '--strict',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--skipLibCheck',
        'tests/fixtures/channel-public-services-external-consumer.ts',
      ], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
    ).not.toThrow()
  })
})
