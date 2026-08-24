import type { CordisXJsonScalar, CordisXPageControls, CordisXPageSelectControl } from '../contracts.js'
import { HostFormAdapter } from './host-form.js'

class PageSelect<Value extends CordisXJsonScalar> implements CordisXPageSelectControl<Value> {
  readonly root: HTMLDivElement
  private control: ReturnType<HostFormAdapter['select']> | undefined
  private selected: Value | undefined
  private closed = false

  constructor(
    private readonly document: Document,
    private readonly forms: HostFormAdapter,
    private readonly options: {
      readonly id?: string
      readonly label: string
      readonly disabled?: boolean
      readonly clearable?: boolean
      readonly onChange: (value: Value | undefined) => void
    },
    choices: readonly { readonly label: string; readonly value: Value; readonly disabled?: boolean }[],
    value?: Value,
  ) {
    this.root = document.createElement('div')
    this.root.dataset.cordisxHostPageControl = 'select'
    this.root.dataset.cordisxNoDrag = 'true'
    this.set(choices, value)
  }

  get value(): Value | undefined {
    return this.selected
  }

  set(choices: readonly { readonly label: string; readonly value: Value; readonly disabled?: boolean }[], value?: Value): void {
    if (this.closed) return
    this.selected = value
    this.control?.dispose()
    const control = this.forms.select<Value>(this.options.label, choices, value, next => {
      this.selected = next
      this.options.onChange(next)
    }, {
      ...(this.options.id === undefined ? {} : { id: this.options.id }),
      ...(this.options.disabled === undefined ? {} : { disabled: this.options.disabled }),
      ...(this.options.clearable === undefined ? {} : { clearable: this.options.clearable }),
    })
    this.control = control
    this.root.replaceChildren(control)
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.control?.dispose()
    this.root.remove()
  }
}

/** Host implementation of the restricted contributed-page control surface. */
export class HostPageControls implements CordisXPageControls {
  private readonly document: Document
  private readonly forms: HostFormAdapter
  private readonly controls = new Set<CordisXPageSelectControl>()
  private closed = false

  constructor(document: Document, portalParent?: HTMLElement) {
    this.document = document
    this.forms = new HostFormAdapter(document, portalParent)
  }

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
    const control = new PageSelect(this.document, this.forms, options, options.options, options.value)
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
