import { describe, expect, it } from 'vitest'
import { betaReleasePackages } from '../scripts/beta-release-scope.mjs'

describe('beta publication scope', () => {
  it('preserves coordinated publication order by default', () => {
    expect(betaReleasePackages()).toEqual(['cordisx', 'create-cordisx-plugin'])
    expect(betaReleasePackages('coordinated')).toEqual(['cordisx', 'create-cordisx-plugin'])
  })

  it('restricts CLI publication and registry verification to cordisx', () => {
    expect(betaReleasePackages('cli')).toEqual(['cordisx'])
  })

  it.each(['', 'all', 'create-cordisx-plugin', 'CLI'])('rejects unknown scope %j', scope => {
    expect(() => betaReleasePackages(scope)).toThrow('--scope must be cli or coordinated')
  })

  it('does not retain mutations made by an earlier caller', () => {
    betaReleasePackages().reverse()
    expect(betaReleasePackages()).toEqual(['cordisx', 'create-cordisx-plugin'])
  })
})
