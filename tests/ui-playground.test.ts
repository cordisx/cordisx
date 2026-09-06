import { describe } from 'vitest'
import { registerNavigationTests } from './suites/ui-playground.navigation.js'
import { registerRuntimeTests } from './suites/ui-playground.runtime.js'

describe('UI Playground', () => {
  registerNavigationTests()
  registerRuntimeTests()
})
