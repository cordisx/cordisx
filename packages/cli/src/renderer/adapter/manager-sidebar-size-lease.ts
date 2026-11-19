/** Release Host width projection without overwriting a native sidebar transition. */
export class ManagerSidebarSizeLease {
  private readonly original: { width: string; flexBasis: string }
  private applied: { width: string; flexBasis: string } | undefined

  constructor(private readonly element: HTMLElement) {
    this.original = { width: element.style.width, flexBasis: element.style.flexBasis }
  }

  apply(width: number): void {
    this.element.style.width = `${width}px`
    this.element.style.flexBasis = `${width}px`
    this.applied = { width: this.element.style.width, flexBasis: this.element.style.flexBasis }
  }

  release(): void {
    if (this.applied === undefined) return
    for (const property of ['width', 'flexBasis'] as const) {
      if (this.element.style[property] === this.applied[property]) {
        this.element.style[property] = this.original[property]
      }
    }
    this.applied = undefined
  }
}
