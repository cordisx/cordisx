const coordinatedPackages = ['cordisx', 'create-cordisx-plugin']

export function betaReleasePackages(scope = 'coordinated') {
  if (scope === 'cli') return ['cordisx']
  if (scope === 'coordinated') return [...coordinatedPackages]
  throw new Error('--scope must be cli or coordinated')
}
