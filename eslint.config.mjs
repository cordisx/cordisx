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
  {
    files: ['packages/cli/src/renderer/model-provider-selector.tsx'],
    // Model-menu feedback belongs to the common notification boundary, including
    // readiness. Block the previous render paths before they can reach a preview.
    // Safe copy passed to an owner notification action is not inline content.
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{
          name: './model-startup-status.js',
          importNames: ['ModelStartupStatus'],
          message:
            'Do not render startup message rows in model menus; use provider object state or common notifications.',
        }],
      }],
      'no-restricted-syntax': ['error', {
        selector:
          'JSXExpressionContainer MemberExpression[object.name="copy"][property.name=/^(switching|accepted|switched|updated|busy|failed|loadFailed|unavailable|loading|switchUnsupported|switchReconciliation|unsupportedIntent|submitRejected|actionFailed)$/]:not(JSXAttribute MemberExpression)',
        message: 'Operation feedback must use useModelProviderNotifications, never JSX in the selector.',
      }, {
        selector: 'JSXExpressionContainer > Identifier[name=/^(error|status|feedback|visibleMenuFeedback)$/]',
        message: 'Do not restore inline feedback or local live regions in the selector.',
      }, {
        selector: 'JSXAttribute[name.name=/^(aria-live|dangerouslySetInnerHTML)$/]',
        message: 'Model menus must not own live announcements or raw HTML; use common notifications.',
      }, {
        selector: 'JSXAttribute[name.name="role"][value.value="alert"]',
        message: 'Operation alerts belong to common notifications, never the model selector.',
      }, {
        selector:
          'CallExpression[callee.property.name=/^(createElement|append|appendChild|insertBefore|insertAdjacentElement|insertAdjacentHTML|replaceChildren)$/]',
        message: 'Do not inject ad-hoc message nodes into the selector; author controls in JSX and use notifications.',
      }, {
        selector: 'AssignmentExpression[left.property.name=/^(innerHTML|outerHTML|textContent)$/]',
        message: 'Do not inject message content into model-menu DOM; use common notifications.',
      }],
    },
  },
])
