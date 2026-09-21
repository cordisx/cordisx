const AUTHORITY_PATTERN =
  /((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|token|password|secret|credential|authorization|cookie|set-cookie)\s*[:=]\s*)[^\s,;]+/giu
const URL_PATTERN = /https?:\/\/[^\s'"<>]+/giu
const WINDOWS_PATH_PATTERN = /(^|\s)[A-Za-z]:[\\/][^\s'"<>]+/gu
const POSIX_PATH_PATTERN = /(^|\s)(\/(?:[^\s/]+\/)*[^\s]+)/gu

export function redactDiagnosticAuthorityAndPaths(input: string): string {
  return input
    .replace(AUTHORITY_PATTERN, '$1[redacted]')
    .replace(URL_PATTERN, '[url redacted]')
    .replace(WINDOWS_PATH_PATTERN, '$1[path redacted]')
    .replace(POSIX_PATH_PATTERN, '$1[path redacted]')
}

export function safeDiagnosticMessage(error: unknown, maximum = 512): string {
  return redactDiagnosticAuthorityAndPaths(error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\u0000-\u001f\u007f]/gu, ' ')
    .trim()
    .slice(0, maximum)
}
