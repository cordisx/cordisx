import { describe, expect, it } from 'vitest'
import { npmPackItem, npmViewItem } from '../scripts/npm-pack-report.mjs'

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
