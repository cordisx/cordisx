export const nativeAccountResource = {
  URL,
  document: { querySelectorAll: () => [] },
  performance: { getEntriesByType: () => [{ name: 'app://-/assets/app-initial-unknown.js' }] },
}
