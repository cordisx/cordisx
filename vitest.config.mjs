// Vitest 3 default discovery, retained for the catch-all core project.
const configDefaults = {
  include: ['**/*.{test,spec}.?(c|m)[jt]s?(x)'],
  exclude: [
    '**/node_modules/**',
    '**/dist/**',
    '**/cypress/**',
    '**/.{idea,git,cache,output,temp}/**',
    '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
  ],
}

// Projects partition the suite. Keep unfamiliar tests in core rather than dropping them.
const browser = ['tests/**/*.browser.test.*', 'tests/**/*native-browser.test.*']
const integration = [
  'tests/**/*.integration.test.*',
  'tests/native-vite-*.test.*',
  'tests/plugin-bundle-composition.test.*',
  'tests/local-development-generation.test.*',
  'tests/local-development-package-*.test.*',
  'tests/playground-*.test.*',
  'tests/shared-react-runtime.test.*',
]
const renderer = [
  'tests/**/*.test.tsx',
  'tests/{manager,navigation,markdown,host-theme,icon-theme,notifications,composer-visual,restricted-content,renderer}-*.test.*',
]
const groups = [
  { name: 'browser', include: browser, exclude: [] },
  { name: 'integration', include: integration, exclude: browser },
  { name: 'renderer', include: renderer, exclude: [...browser, ...integration] },
  { name: 'core', include: configDefaults.include, exclude: [...browser, ...integration, ...renderer] },
]

export default {
  test: {
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    projects: groups.map(({ name, include, exclude }) => ({
      extends: true,
      test: { name, include, exclude: [...configDefaults.exclude, ...exclude] },
    })),
  },
}
