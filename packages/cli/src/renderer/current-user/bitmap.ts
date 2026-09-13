const INLINE_AVATAR =
  /^data:image\/(?:png|jpeg|webp);base64,(?=[A-Za-z0-9+/])(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?(?![\s\S])/
export function inlineAvatar(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 65536 && INLINE_AVATAR.test(value) ? value : undefined
}
/** Host normalizes raster bytes before exposing a bounded, origin-free image to plugins. */
export async function canonicalAvatar(response: Response, signal: AbortSignal): Promise<string | undefined> {
  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (!response.ok || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType ?? '')) {
    await response.body?.cancel()
    return undefined
  }
  const length = Number(response.headers.get('content-length'))
  if (length > 1048576 || !response.body) {
    await response.body?.cancel()
    return undefined
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let size = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > 1048576) return undefined
      chunks.push(new Uint8Array(next.value))
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  signal.throwIfAborted()
  const bitmap = await createImageBitmap(new Blob(chunks, { type: mediaType ?? 'image/png' }), {
    resizeWidth: 96,
    resizeHeight: 96,
    resizeQuality: 'high',
  })
  try {
    signal.throwIfAborted()
    const canvas = new OffscreenCanvas(96, 96)
    const context = canvas.getContext('2d')
    if (!context) return undefined
    context.drawImage(bitmap, 0, 0, 96, 96)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    if (blob.size > 49128) return undefined
    const bytes = new Uint8Array(await blob.arrayBuffer())
    signal.throwIfAborted()
    const encoded = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
    return inlineAvatar(`data:image/png;base64,${encoded}`)
  } finally {
    bitmap.close()
  }
}
