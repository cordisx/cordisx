const NPM_PACKAGE_NAME = /^(?:[a-z0-9-][a-z0-9._-]*|@[a-z0-9_.!~*'()-]+\/[a-z0-9_-][a-z0-9._-]*)$/
const RESERVED_NPM_PACKAGE_NAMES = new Set(['node_modules', 'favicon.ico'])

export function isValidMarketplacePackageName(value: string): boolean {
  return value.length <= 214 && NPM_PACKAGE_NAME.test(value) && !RESERVED_NPM_PACKAGE_NAMES.has(value)
}

export function marketplacePackageNamespace(value: string): string | undefined {
  if (!value.startsWith('@')) return undefined
  return value.slice(0, value.indexOf('/'))
}
