import { defineConfig, globalIgnores } from 'eslint/config'
import sourcePolicy from '@cordisx/eslint-config'
import parser from '@typescript-eslint/parser'

export default defineConfig([
  // Build outputs and verified generated/vendor artifacts; maintained tests stay included.
  globalIgnores([
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/coverage/**',
    '**/.cache/**',
    'packages/cli/src/renderer/manager-collection-unicode-17.generated.ts',
    'packages/cli/src/renderer/manager/data/contributors.generated.ts',
  ]),
  {
    files: ['**/*.{js,mjs,cjs,jsx}'],
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    extends: [sourcePolicy],
  },
  { files: ['**/*.{ts,mts,cts,tsx}'], languageOptions: { parser }, extends: [sourcePolicy] },
])
