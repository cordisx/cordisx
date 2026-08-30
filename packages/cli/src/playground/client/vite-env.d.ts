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
  readonly status: string
}

interface PlaygroundRuntimeSnapshot {
  readonly plugins: readonly PlaygroundPluginSnapshot[]
}

interface PlaygroundRuntime {
  snapshot(): PlaygroundRuntimeSnapshot
  playgroundMockAgentLoop?(): import('../../renderer/playground-mock-agent-loop.js').PlaygroundMockAgentLoopSnapshot
}

interface Window {
  __cordisxRuntime?: PlaygroundRuntime
  __cordisxConfigRequestV1?: (payload: string) => void
  __cordisxProviderRequestV1?: (payload: string) => void
  __cordisxProviderReceiveV1?: (payload: string) => void
  __cordisxConfigReceiveV1?: (payload: string) => void
  __cordisxServiceConfigRequestV1?: (payload: string) => void
  __cordisxServiceConfigReceiveV1?: (payload: string) => void
  __cordisxChannelCredentialRequestV1?: (payload: string) => void
  __cordisxChannelCredentialReceiveV1?: (payload: string) => void
}
