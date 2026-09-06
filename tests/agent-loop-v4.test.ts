import { describe } from 'vitest'
import { registerCausationTests } from './suites/agent-loop-v4.causation.js'
import { registerLifecycleTests } from './suites/agent-loop-v4.lifecycle.js'

describe('AgentLoop v4 renderer adapter', () => {
  registerCausationTests()
  registerLifecycleTests()
})
