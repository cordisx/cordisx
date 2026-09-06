export interface InjectedHostCleanup {
  readonly beforeHostTermination: readonly Promise<unknown>[]
  readonly terminateHost?: () => Promise<unknown>
}

/** Keep CDP alive until renderer and launcher-service cleanup has settled. */
export async function settleInjectedHostCleanup(
  input: InjectedHostCleanup,
): Promise<readonly PromiseSettledResult<unknown>[]> {
  const beforeHostTermination = await Promise.allSettled(input.beforeHostTermination)
  const hostTermination = input.terminateHost === undefined
    ? []
    : await Promise.allSettled([input.terminateHost()])
  return [...beforeHostTermination, ...hostTermination]
}
