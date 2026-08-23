import { describe, expect, it } from 'vitest'
import {
  isNpmRegistryPropagationError,
  npmMaintainerNames,
  npmPackItem,
  npmViewItem,
} from '../scripts/npm-pack-report.mjs'

const packed = {
  name: 'cordisx',
  version: '0.1.0-beta.0',
  filename: 'cordisx-0.1.0-beta.0.tgz',
  integrity: 'sha512-example',
  files: [{ path: 'package.json' }],
}

describe('npm pack report compatibility', () => {
  it('reads the npm 10 array report', () => {
    expect(npmPackItem([packed], 'cordisx')).toBe(packed)
  })

  it('reads the npm 12 workspace-keyed report', () => {
    expect(npmPackItem({ cordisx: packed }, 'cordisx')).toBe(packed)
  })

  it('fails closed when the requested package is absent', () => {
    expect(() => npmPackItem({}, 'cordisx')).toThrow('npm pack did not report cordisx')
  })
})

describe('npm view report compatibility', () => {
  it('reads the npm 10 direct result', () => {
    expect(npmViewItem(packed, 'cordisx')).toBe(packed)
  })

  it('reads the npm 12 single-result array', () => {
    expect(npmViewItem([packed], 'cordisx')).toBe(packed)
  })

  it('fails closed for ambiguous npm view output', () => {
    expect(() => npmViewItem([], 'cordisx')).toThrow('npm view returned 0 results for cordisx')
    expect(() => npmViewItem([packed, packed], 'cordisx')).toThrow(
      'npm view returned 2 results for cordisx',
    )
  })
})

describe('npm maintainer compatibility', () => {
  it('extracts names from npm string and object forms', () => {
    expect(npmMaintainerNames([
      'yijie4188 <yijie4188@example.com>',
      { name: 'release-bot', email: 'release-bot@example.com' },
    ])).toEqual(['yijie4188', 'release-bot'])
  })

  it('ignores incomplete entries', () => {
    expect(npmMaintainerNames([null, {}, 42])).toEqual([])
  })
})

describe('npm registry propagation errors', () => {
  it('retries only missing-version and missing-package responses', () => {
    expect(isNpmRegistryPropagationError({ commandOutput: 'npm error code ETARGET' })).toBe(true)
    expect(isNpmRegistryPropagationError({ commandOutput: 'npm error code E404' })).toBe(true)
    expect(isNpmRegistryPropagationError({ commandOutput: 'npm error code E401' })).toBe(false)
    expect(isNpmRegistryPropagationError(new Error('ETARGET'))).toBe(false)
  })
})
