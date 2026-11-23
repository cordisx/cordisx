/** Release profile fences only after every renderer retirement is confirmed. */
export async function closeBootstrapFences(
  retirements: Iterable<Promise<boolean>>,
  fences: readonly ({ close(): Promise<void> } | undefined)[],
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const results = await Promise.race([
      Promise.all(retirements),
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), 15_000)
      }),
    ])
    if (!results || !results.every(Boolean)) return false
    await Promise.all(fences.map(async fence => await fence?.close()))
    return true
  } catch {
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
