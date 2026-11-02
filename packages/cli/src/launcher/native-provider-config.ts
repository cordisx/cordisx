import type { NativeProviderCredentialLease } from './native-submission-controller.js'

function validText(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && !/[\0\r\n]/u.test(value)
}

export function nativeProviderConfig(lease: NativeProviderCredentialLease): Readonly<Record<string, unknown>> {
  const baseUrl = new URL(lease.endpoint.baseUrl)
  const loopback = baseUrl.hostname === '127.0.0.1'
    || baseUrl.hostname === 'localhost'
    || baseUrl.hostname === '[::1]'
  if (
    !['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username !== '' || baseUrl.password !== ''
    || baseUrl.hash !== '' || lease.endpoint.wireApi !== 'responses'
    || (baseUrl.protocol === 'http:' && !loopback)
  ) throw new Error('native provider credential lease endpoint is invalid')
  if (lease.auth.scheme === 'none') {
    return Object.freeze({
      name: 'CordisX managed provider',
      base_url: lease.endpoint.baseUrl,
      wire_api: 'responses',
      requires_openai_auth: false,
    })
  }
  if (
    !validText(lease.auth.command, 4_096)
    || !validText(lease.auth.cwd, 4_096)
    || lease.auth.args.some(argument => argument.length > 16_384 || argument.includes('\0'))
    || !Number.isSafeInteger(lease.auth.timeoutMs) || lease.auth.timeoutMs < 1 || lease.auth.timeoutMs > 60_000
    || !Number.isSafeInteger(lease.auth.refreshIntervalMs)
    || lease.auth.refreshIntervalMs < 1 || lease.auth.refreshIntervalMs > 60_000
  ) throw new Error('native provider credential command is invalid')
  return Object.freeze({
    name: 'CordisX managed provider',
    base_url: lease.endpoint.baseUrl,
    wire_api: 'responses',
    requires_openai_auth: false,
    auth: Object.freeze({
      command: lease.auth.command,
      args: Object.freeze([...lease.auth.args]),
      cwd: lease.auth.cwd,
      timeout_ms: lease.auth.timeoutMs,
      refresh_interval_ms: lease.auth.refreshIntervalMs,
    }),
  })
}
