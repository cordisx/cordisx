export function prepareResponsesRecoveryRequest(
  method: string,
  params: Readonly<Record<string, unknown>>,
  ports: {
    readThread(threadId: string): Promise<{ thread?: { modelProvider?: unknown } }>
    readAccount?(): Promise<unknown>
    prepare(providerId?: string, nativeAccount?: unknown): Promise<Readonly<Record<string, unknown>>>
  },
): Promise<Readonly<Record<string, unknown>>>
export function accountRouting(value: unknown): unknown
export function prepareNativeResponsesRecovery(
  method: string,
  params: Readonly<Record<string, unknown>>,
  ports: {
    nativeCall(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown>
    controlCall(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown>
    nativeOpenAiRecovery: boolean
  },
): Promise<Readonly<Record<string, unknown>>>
