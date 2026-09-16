const releaseTagPattern = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?)$/

const prereleaseChannels = new Set(['alpha', 'beta', 'rc'])

export function releaseFromTag(tag) {
  if (typeof tag !== 'string') throw new Error('release tag must be a string')
  const match = releaseTagPattern.exec(tag)
  if (!match) throw new Error('release tag must be v<semver> without build metadata')

  const version = match[1]
  const prerelease = match[2]
  if (prerelease === undefined) {
    return { tag, version, distTag: 'latest', prerelease: false }
  }

  const identifiers = prerelease.split('.')
  for (const identifier of identifiers) {
    if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')) {
      throw new Error('numeric prerelease identifiers must not contain leading zeroes')
    }
  }
  const distTag = identifiers[0]
  if (!prereleaseChannels.has(distTag)) {
    throw new Error('prerelease channel must be alpha, beta, or rc')
  }
  return { tag, version, distTag, prerelease: true }
}
