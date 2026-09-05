const MIN_RENDERER_TIMEOUT_MS = 30_000
const MAX_RENDERER_TIMEOUT_MS = 600_000

export function resolveIsolatedSmokeRendererTimeoutMs(value, fallbackMs) {
  if (value === undefined) return fallbackMs
  if (!/^\d+$/u.test(value)) {
    throw new Error('--renderer-timeout-ms must be an integer number of milliseconds')
  }
  const timeoutMs = Number(value)
  if (
    !Number.isSafeInteger(timeoutMs) || timeoutMs < MIN_RENDERER_TIMEOUT_MS
    || timeoutMs > MAX_RENDERER_TIMEOUT_MS
  ) {
    throw new Error(
      `--renderer-timeout-ms must be between ${MIN_RENDERER_TIMEOUT_MS} and ${MAX_RENDERER_TIMEOUT_MS}`,
    )
  }
  return timeoutMs
}
