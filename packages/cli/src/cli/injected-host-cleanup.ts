export interface InjectedHostCleanup {
  readonly beforeHostTermination: readonly Promise<unknown>[]
  readonly terminateHost?: () => Promise<unknown>
  readonly recoverAfterHostTermination?: (error: unknown) => unknown | undefined
}

/** Keep CDP alive until renderer and launcher-service cleanup has settled. */
export async function settleInjectedHostCleanup(
  input: InjectedHostCleanup,
): Promise<readonly PromiseSettledResult<unknown>[]> {
  const beforeHostTermination = await Promise.allSettled(input.beforeHostTermination)
  const hostTermination = input.terminateHost === undefined
    ? []
    : await Promise.allSettled([input.terminateHost()])
  const recovered = hostTermination[0]?.status === 'fulfilled' && input.recoverAfterHostTermination !== undefined
    ? beforeHostTermination.map(result => {
      if (result.status === 'fulfilled') return result
      const remaining = input.recoverAfterHostTermination!(result.reason)
      return remaining === undefined
        ? { status: 'fulfilled' as const, value: undefined }
        : { status: 'rejected' as const, reason: remaining }
    })
    : beforeHostTermination
  return [...recovered, ...hostTermination]
}
