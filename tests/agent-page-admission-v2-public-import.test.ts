import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('formal page admission v2 public imports', () => {
  it('typechecks a mounted-page consumer through cordisx/contracts only', () => {
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
        'tests/fixtures/agent-page-admission-v2-external-consumer.ts',
      ], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
    ).not.toThrow()
  })
})
