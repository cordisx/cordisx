import { randomBytes } from 'node:crypto'
import { ContextObservations } from '../launcher/context-observations.js'
import { NativeContextObserver } from '../launcher/native-context-observer.js'
import { HostAgentContextBridge } from '../launcher/agent-context-bridge.js'

/** Launch-owned observation state and private renderer binding. */
export function rendererAgentContext() {
  const observations = new ContextObservations()
  const observer = new NativeContextObserver(observations)
  const token = randomBytes(32).toString('hex')
  return {
    token,
    observer,
    binding: {
      token,
      createBridge: () => new HostAgentContextBridge(observations),
      authorize: (id: string) => observer.has(id),
    },
  }
}
