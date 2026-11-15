export interface FeishuFailureDiagnostic {
  readonly stage: 'directory' | 'inbound'
  readonly httpStatus?: number
  readonly platformCode?: number
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Allow numeric transport/business metadata only; Axios messages/config/headers are private. */
export function feishuFailureDiagnostic(
  stage: FeishuFailureDiagnostic['stage'],
  error: unknown,
): FeishuFailureDiagnostic {
  const value = record(error), response = record(value.response), data = record(response.data)
  const status = response.status, code = data.code ?? value.code
  return {
    stage,
    ...(Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599
      ? { httpStatus: Number(status) }
      : {}),
    ...(Number.isSafeInteger(code) && Number(code) >= 0 ? { platformCode: Number(code) } : {}),
  }
}

export function feishuDirectoryFailureCode(diagnostic: FeishuFailureDiagnostic): string {
  return diagnostic.httpStatus === 401 || diagnostic.httpStatus === 403
      || diagnostic.platformCode === 99991672 || diagnostic.platformCode === 99991679
    ? 'CHANNEL_DIRECTORY_PERMISSION_DENIED'
    : 'CHANNEL_DIRECTORY_FAILED'
}
