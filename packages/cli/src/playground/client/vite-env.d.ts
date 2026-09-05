/// <reference types="vite/client" />

declare module 'virtual:cordisx-composition' {
  export const runtime: PlaygroundRuntime
}

declare module 'virtual:cordisx-playground-fixture' {
  const fixture: {
    readonly name: string
    readonly source: string
    readonly reviewNavigationItem?: string
  }
  export default fixture
}

interface PlaygroundPluginSnapshot {
  readonly id: string
  readonly source: string
  readonly status: string
}

interface PlaygroundRuntimeSnapshot {
  readonly plugins: readonly PlaygroundPluginSnapshot[]
  readonly registrations: readonly PlaygroundRegistrationSnapshot[]
  readonly navigation: {
    readonly routes: readonly PlaygroundRouteSnapshot[]
  }
}

interface PlaygroundRegistrationSnapshot {
  readonly owner: string
  readonly qualifiedId: string
  readonly surface: string
  readonly authorized: boolean
  readonly pointPolicyReason?: string
  readonly item?: {
    readonly route?: {
      readonly id: string
    }
  }
}

interface PlaygroundRouteSnapshot {
  readonly owner: string
  readonly id: string
  readonly definition: {
    readonly outlet: string
  }
}

interface PlaygroundRuntime {
  snapshot(): PlaygroundRuntimeSnapshot
  setExtensionPointPolicy(
    source: string,
    pluginId: string,
    pointId: string,
    policy: 'inherit' | 'allow' | 'deny',
  ): Promise<void>
  setExtensionPointPolicies(
    source: string,
    pluginId: string,
    policies: readonly { readonly pointId: string; readonly policy: 'inherit' | 'allow' | 'deny' }[],
  ): Promise<void>
  playgroundMockAgentLoop?(): import('../../renderer/playground-mock-agent-loop.js').PlaygroundMockAgentLoopSnapshot
  resetPlaygroundMockAgentLoop?(): Readonly<{ before: number; after: number }>
  readonly playgroundRoomSimulationBridge?:
    import('../../renderer/playground-room-simulation-bridge.js').PlaygroundRoomSimulationForwardingClient
  playgroundRouteHistory?(): Readonly<{
    available: boolean
    canGoBack: boolean
    canGoForward: boolean
    reason?: string
  }>
  subscribePlaygroundRouteHistory?(listener: () => void): () => void
  goPlaygroundRouteHistory?(delta: -1 | 1): Promise<void>
}

interface Window {
  __cordisxRuntime?: PlaygroundRuntime
  __cordisxConfigRequestV1?: (payload: string) => void
  __cordisxProviderRequestV1?: (payload: string) => void
  __cordisxProviderReceiveV1?: (payload: string) => void
  __cordisxConfigReceiveV1?: (payload: string) => void
  __cordisxPlaygroundAgentSessionRequestV1?: (payload: string) => void
  __cordisxPlaygroundAgentSessionReceiveV1?: (payload: string) => void
  __cordisxOwnerDocumentRequestV1?: (payload: string) => void
  __cordisxOwnerDocumentReceiveV1?: (payload: string) => void
  __cordisxServiceConfigRequestV1?: (payload: string) => void
  __cordisxServiceConfigReceiveV1?: (payload: string) => void
  __cordisxChannelCredentialRequestV1?: (payload: string) => void
  __cordisxChannelCredentialReceiveV1?: (payload: string) => void
}
