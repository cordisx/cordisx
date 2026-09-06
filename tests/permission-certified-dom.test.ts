import { describe } from 'vitest'
import { registerCertificationTests } from './suites/permission-certified-dom.certification.js'
import { registerGenerationTests } from './suites/permission-certified-dom.generation.js'

describe('certified DOM authorization through the single PermissionBroker', () => {
  registerCertificationTests()
  registerGenerationTests()
})
