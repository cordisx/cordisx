import { createRoot, type Root } from 'react-dom/client'
import { ConfigProvider, Select } from 'tdesign-react'
import type { CordisXJsonScalar, CordisXPageControls, CordisXPageSelectControl } from '../contracts.js'

interface PageSelectOptions<Value extends CordisXJsonScalar> {
  readonly id?: string
  readonly label: string
  readonly disabled?: boolean
  readonly clearable?: boolean
  readonly onChange: (value: Value | undefined) => void
}

class PageSelect<Value extends CordisXJsonScalar> implements CordisXPageSelectControl<Value> {
  readonly root: HTMLDivElement
  private readonly reactRoot: Root
  private selected: Value | undefined
  private closed = false

  constructor(
    document: Document,
    private readonly options: PageSelectOptions<Value>,
    choices: readonly { readonly label: string; readonly value: Value; readonly disabled?: boolean }[],
    value?: Value,
  ) {
    this.root = document.createElement('div')
    this.root.className = 'cxp-page-control'
    this.root.dataset.cordisxHostPageControl = 'select'
    this.root.dataset.cordisxNoDrag = 'true'
    this.reactRoot = createRoot(this.root)
    this.set(choices, value)
  }

  get value(): Value | undefined { return this.selected }

  set(choices: readonly { readonly label: string; readonly value: Value; readonly disabled?: boolean }[], value?: Value): void {
    if (this.closed) return
    this.selected = value
    const indexed = choices.map((choice, index) => ({ ...choice, key: String(index) }))
    const selectedKey = indexed.find(choice => Object.is(choice.value, value))?.key
    const attach = () => this.root
    this.reactRoot.render(<ConfigProvider globalConfig={{ attach }}><Select
      {...(this.options.id === undefined ? {} : { id: this.options.id })}
      aria-label={this.options.label}
      {...(selectedKey === undefined ? {} : { value: selectedKey })}
      options={indexed.map(choice => ({ label: choice.label, value: choice.key, ...(choice.disabled === undefined ? {} : { disabled: choice.disabled }) }))}
      {...(this.options.disabled === undefined ? {} : { disabled: this.options.disabled })}
      {...(this.options.clearable === undefined ? {} : { clearable: this.options.clearable })}
      onChange={key => {
        const next = indexed.find(choice => choice.key === String(key))?.value
        this.selected = next
        this.options.onChange(next)
      }}
    /></ConfigProvider>)
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.reactRoot.unmount()
    this.root.remove()
  }
}

/** React/TDesign implementation of the restricted contributed-page control surface. */
export class HostPageControls implements CordisXPageControls {
  private readonly controls = new Set<CordisXPageSelectControl>()
  private closed = false

  constructor(private readonly document: Document, _portalParent?: HTMLElement) {}

  select<Value extends CordisXJsonScalar>(options: {
    readonly id?: string
    readonly label: string
    readonly options: readonly { readonly label: string; readonly value: Value; readonly disabled?: boolean }[]
    readonly value?: Value
    readonly disabled?: boolean
    readonly clearable?: boolean
    readonly onChange: (value: Value | undefined) => void
  }): CordisXPageSelectControl<Value> {
    if (this.closed) throw new Error('page controls are disposed')
    const control = new PageSelect(this.document, options, options.options, options.value)
    this.controls.add(control)
    return control
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const control of this.controls) control.dispose()
    this.controls.clear()
  }
}
