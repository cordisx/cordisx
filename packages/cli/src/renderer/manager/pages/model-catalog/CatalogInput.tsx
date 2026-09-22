import { useLayoutEffect, useRef } from 'react'
import { Input, type InputProps } from 'tdesign-react'

/** TDesign's root receives arbitrary attributes; name its actual editable element. */
export function CatalogInput({ label, ...props }: InputProps & { readonly label: string }) {
  const root = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    root.current?.querySelector('input')?.setAttribute('aria-label', label)
  }, [label])
  return (
    <span ref={root} className="cxmc-input">
      <Input placeholder="" {...props} />
    </span>
  )
}
