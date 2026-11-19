import { bindDiagnostic } from '../diagnostics/context.js'
import type { CdpSession } from './cdp-session.js'

export type NativeTaskCreationUnavailableReason =
  | 'source-structure-unavailable'
  | 'renderer-unavailable'
  | 'adapter-unavailable'
  | 'execution-import-failed'
  | 'initial-marker-unavailable'
  | 'execution-url-mismatch'
  | 'execution-marker-unavailable'
  | 'renderer-probe-failed'
export type NativeTaskCreationStatus =
  | { readonly available: true }
  | { readonly available: false; readonly reason: NativeTaskCreationUnavailableReason }

interface TaskDocument {
  readonly disposed: boolean
  readonly session: CdpSession
}
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

/** Probe only the Host-selected native module and emit bounded transitions, never source or user data. */
export function createNativeTaskCreationReadiness(
  taskExecutionUrl: string | undefined,
  documents: ReadonlyMap<string, TaskDocument>,
): () => Promise<NativeTaskCreationStatus> {
  const report = bindDiagnostic()
  let lastTaskStatus: string | undefined
  const taskCreationStatus = async (): Promise<NativeTaskCreationStatus> => {
    let reason: NativeTaskCreationUnavailableReason = taskExecutionUrl === undefined
      ? 'source-structure-unavailable'
      : 'renderer-unavailable'
    if (taskExecutionUrl !== undefined) {
      for (const owner of documents.values()) {
        if (owner.disposed || owner.session.isClosed()) continue
        const response = await owner.session.send('Runtime.evaluate', {
          expression: `(async()=>{
            if(globalThis.__cordisxNativeAgentTaskAdapter==null)return 'adapter-unavailable';
            const url=${JSON.stringify(taskExecutionUrl)};
            try{await import(url)}catch{return 'execution-import-failed'}
            if(globalThis.__cordisxNativeAgentTask_initial!==true)return 'initial-marker-unavailable';
            if(globalThis.__cordisxNativeAgentTaskExecutionUrl!==url)return 'execution-url-mismatch';
            if(globalThis.__cordisxNativeAgentTask_execution!==true)return 'execution-marker-unavailable';
            return 'available';
          })()`,
          awaitPromise: true,
          returnByValue: true,
        }, 5_000).catch(() => undefined)
        if (owner.disposed || owner.session.isClosed() || ![...documents.values()].includes(owner)) continue
        const value = record(response?.result)?.value
        if (value === 'available') {
          if (lastTaskStatus !== value) report({ event: 'native-task-creation-status', outcome: value })
          lastTaskStatus = value
          return { available: true }
        }
        if (
          typeof value === 'string' && [
            'adapter-unavailable',
            'execution-import-failed',
            'initial-marker-unavailable',
            'execution-url-mismatch',
            'execution-marker-unavailable',
          ].includes(value)
        ) reason = value as NativeTaskCreationUnavailableReason
        else reason = 'renderer-probe-failed'
      }
    }
    if (lastTaskStatus !== reason) report({ event: 'native-task-creation-status', outcome: 'unavailable', reason })
    lastTaskStatus = reason
    return { available: false, reason }
  }
  return taskCreationStatus
}
