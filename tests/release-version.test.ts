import { describe, expect, it } from 'vitest'
import { releasePackageDefinitions, releasePackageNames } from '../scripts/release-packages.mjs'
import { releaseFromTag } from '../scripts/release-version.mjs'

describe('repository release tags', () => {
  it.each([
    ['v1.2.3', { version: '1.2.3', distTag: 'latest', prerelease: false }],
    ['v0.1.0-alpha.4', { version: '0.1.0-alpha.4', distTag: 'alpha', prerelease: true }],
    ['v0.1.0-beta.8', { version: '0.1.0-beta.8', distTag: 'beta', prerelease: true }],
    ['v2.0.0-rc.1', { version: '2.0.0-rc.1', distTag: 'rc', prerelease: true }],
  ])('maps %s to its npm channel', (tag, expected) => {
    expect(releaseFromTag(tag)).toMatchObject(expected)
  })

  it.each(['0.1.0-beta.8', 'v01.0.0', 'v1.0.0-preview.1', 'v1.0.0-beta.01', 'v1.0.0+build.1'])(
    'rejects unsupported release tag %s',
    tag => {
      expect(() => releaseFromTag(tag)).toThrow()
    },
  )

  it('always releases the CLI and creator together in dependency order', () => {
    expect(releasePackageNames()).toEqual(['cordisx', 'create-cordisx-plugin'])
    expect(releasePackageDefinitions.every(Object.isFrozen)).toBe(true)
    releasePackageNames().reverse()
    expect(releasePackageNames()).toEqual(['cordisx', 'create-cordisx-plugin'])
  })
})
