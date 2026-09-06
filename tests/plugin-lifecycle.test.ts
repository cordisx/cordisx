import { describe } from 'vitest'
import { registerCleanup } from './suites/plugin-lifecycle.fixtures.js'
import { registerAdmissionTests } from './suites/plugin-lifecycle.admission.js'
import { registerTransactionsTests } from './suites/plugin-lifecycle.transactions.js'

registerCleanup()

describe('launcher plugin lifecycle coordinator', () => {
  registerAdmissionTests()
  registerTransactionsTests()
})
