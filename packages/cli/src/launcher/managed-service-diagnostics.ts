import { diagnostic, diagnosticError, diagnosticRef } from '../diagnostics/context.js'
import type { ManagedServiceRecord } from './managed-service-runtime-record.js'
import type { DiagnosticEvent } from '../diagnostics/context.js'

const sinks = new WeakMap<ManagedServiceRecord, (event: DiagnosticEvent) => void>()
export function bindManagedServiceDiagnostics(
  record: ManagedServiceRecord,
  emit: (event: DiagnosticEvent) => void,
): void {
  sinks.set(record, emit)
}

export function managedServiceDiagnostic(
  record: ManagedServiceRecord,
  event: string,
  fields: Omit<DiagnosticEvent, 'event'> = {},
): void {
  const emit = sinks.get(record) ?? diagnostic
  emit({
    event,
    pluginRef: diagnosticRef(record.binding.identity.pluginId),
    serviceRef: diagnosticRef(record.definition.serviceId),
    serviceGeneration: record.binding.serviceGeneration,
    ownership: record.processOwnership,
    discovery: record.definition.discovery.kind,
    state: record.state,
    ...fields,
  })
}
export { diagnosticError }
