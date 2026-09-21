export type ShortcutPresentation = { status: 'available'; avatar?: string } | { status: 'unavailable' }
export function presentation(value: unknown): ShortcutPresentation {
  if (!value || typeof value !== 'object' || (value as { status?: unknown }).status !== 'available') {
    return { status: 'unavailable' }
  }
  const avatar = (value as { avatar?: unknown }).avatar
  return {
    status: 'available',
    ...(typeof avatar === 'string' && avatar.length <= 65536
        && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar)
      ? { avatar }
      : {}),
  }
}
