import { diagnostic, diagnosticError, diagnosticRef } from '../diagnostics/context.js'
import type { ManagedServiceRecord } from './managed-service-runtime-record.js'
import type { DiagnosticEvent } from '../diagnostics/context.js'

export function managedServiceDiagnostic(
  record: ManagedServiceRecord,
  event: string,
  fields: Omit<DiagnosticEvent, 'event'> = {},
): void {
  diagnostic({
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
