import brain from '../../../assets/icons/lucide-0.468.0/brain.svg'

const mask = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(brain)}")`

/** Host-private Lucide brain glyph for the model disclosure only. */
export function BrainIcon({ className }: { readonly className?: string }) {
  return (
    <span
      className={['cordisx-host-icon', className].filter(Boolean).join(' ')}
      data-icon-source="lucide@0.468.0/brain"
      aria-hidden="true"
      draggable={false}
      style={{
        backgroundColor: 'currentColor',
        blockSize: 18,
        display: 'block',
        inlineSize: 18,
        mask,
        maskPosition: 'center',
        maskRepeat: 'no-repeat',
        maskSize: 'contain',
        WebkitMask: mask,
        WebkitMaskPosition: 'center',
        WebkitMaskRepeat: 'no-repeat',
        WebkitMaskSize: 'contain',
      }}
    />
  )
}
