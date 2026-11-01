import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { supervisorEntryArgs } from './supervisor-entry.js'

const loader = ['--require', '/repo/node_modules/tsx/dist/preflight.cjs', '--import', 'file:///repo/tsx/loader.mjs']

describe('supervisorEntryArgs', () => {
  it('keeps the packaged launch to the built entry without parent node flags', () => {
    expect(supervisorEntryArgs('file:///pkg/dist/cli/supervisor-command.js', ['--inspect'])).toEqual([
      '/pkg/dist/cli.js',
    ])
  })

  it('forwards loader flags and the TypeScript entry from a source checkout', () => {
    expect(supervisorEntryArgs('file:///repo/packages/cli/src/cli/supervisor-command.ts', loader)).toEqual([
      ...loader,
      '/repo/packages/cli/src/cli.ts',
    ])
  })

  it('resolves an existing entry for this checkout', () => {
    const args = supervisorEntryArgs(new URL('./supervisor-command.ts', import.meta.url).href, [])
    expect(existsSync(args.at(-1)!)).toBe(true)
  })
})
