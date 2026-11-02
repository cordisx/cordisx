// Source-only native installation fixture; use React runtime without building Host distribution.
import base from '../vitest.config.mjs'
export default {
  ...base,
  resolve: {
    alias: {
      'cordisx/react/jsx-dev-runtime': 'react/jsx-dev-runtime',
      'cordisx/react/jsx-runtime': 'react/jsx-runtime',
    },
  },
}
