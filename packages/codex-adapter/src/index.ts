import type { AdapterBundle, NativeScriptResource } from './contracts.js'
import { analyzeNativeSubmissionTransforms } from './native-submission-structure.js'
import { legacyNativeSubmissionResources } from './native-submission-legacy-resources.js'
import { nativeAgentTaskTransforms } from './native-agent-task-transform.js'
import { discoverNativeAccountCapabilityFromSyntax } from './native-account-structure.js'
import { parseNativeSource, type SyntaxNode } from './native-source-structure.js'
export type * from './contracts.js'

const syntaxes = new WeakMap<readonly NativeScriptResource[], ReadonlyMap<NativeScriptResource, SyntaxNode>>()

// Kept in lockstep by the independent artifact check, unrelated to Host/Creator versions.
export const bundle: AdapterBundle = {
  apiVersion: 1,
  relayContract: 1,
  version: '0.1.0-beta.1',
  resourceHints: [
    ['submitTarget', 'options', 'openingPromptForHistory'],
    ['context', 'configOverrides', 'requiresThreadReferences'],
    ['configOverrides', 'threadStartKind', 'requiresThreadReferences'],
    ['context', 'targetConversationId', 'clientUserMessageId'],
    ['inheritThreadSettings', 'usePermissionSelection'],
    ['projectAssignment', 'conversationResponse', 'localTurnMetadata'],
    ['sendRequest', 'turn/start', 'getAppServerVersion'],
    ['onSelectModel', 'onSelectModelOption', 'reasoningEffort'],
    ['accessInputs', 'readAccountInfo'],
    ['accountInfo', 'readAccountInfo'],
    ['create_thread', 'argumentsValue', 'sourceThreadId', 'parentTurnId'],
  ],
  modules: [
    {
      id: 'submission',
      requires: [],
      composes: [],
      analyze({ resources }) {
        const legacy = legacyNativeSubmissionResources(resources)
        if (legacy) return { transforms: legacy }
        const result = analyzeNativeSubmissionTransforms(resources)
        syntaxes.set(resources, result.syntaxByResource)
        return { transforms: result.transforms }
      },
    },
    {
      id: 'tasks',
      requires: [{ id: 'submission', samePackage: true }],
      composes: ['submission'],
      analyze({ appVersion, buildNumber, resources, transforms }) {
        const result = nativeAgentTaskTransforms(
          appVersion,
          buildNumber,
          resources,
          transforms,
          syntaxes.get(resources),
        )
        if (!result.available) throw new Error('Native task creation structure unavailable')
        return { transforms: result.transforms }
      },
    },
    {
      id: 'account',
      requires: [],
      composes: [],
      analyze({ resources }) {
        const candidates = resources.flatMap(resource => {
          try {
            return [
              discoverNativeAccountCapabilityFromSyntax(
                resource,
                syntaxes.get(resources)?.get(resource) ?? parseNativeSource(resource.source),
                resources,
              ),
            ]
          } catch {
            return []
          }
        })
        if (candidates.length !== 1) {
          throw new Error(`Native account service: expected one structure, found ${candidates.length}`)
        }
        return { accountCapability: candidates[0]! }
      },
    },
  ],
}
