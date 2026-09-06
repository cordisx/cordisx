import { describe } from 'vitest'
import { registerSelectionTests } from './suites/controlled-surfaces.selection.js'
import { registerLeasesTests } from './suites/controlled-surfaces.leases.js'

describe('controlled extension point runtime', () => {
  registerSelectionTests()
  registerLeasesTests()
})
