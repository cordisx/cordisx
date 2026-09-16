export const releasePackageDefinitions = Object.freeze([
  Object.freeze({ name: 'cordisx', workspace: 'cordisx', directory: 'packages/cli' }),
  Object.freeze({
    name: 'create-cordisx-plugin',
    workspace: 'create-cordisx-plugin',
    directory: 'packages/create-cordisx-plugin',
  }),
])

export function releasePackageNames() {
  return releasePackageDefinitions.map(pkg => pkg.name)
}
