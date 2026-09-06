import { describe } from 'vitest'
import { registerHistoryTests } from './suites/navigation.history.js'
import { registerOutletsTests } from './suites/navigation.outlets.js'

describe('NavigationRegistry', () => {
  registerHistoryTests()
  registerOutletsTests()
})
