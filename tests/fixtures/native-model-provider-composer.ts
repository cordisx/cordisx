import { vi } from 'vitest'

export function composer(
  document: Document,
  threadId: string | null = 'thread-1',
  model = 'model-a',
  attachControl = true,
) {
  document.body.innerHTML = `<main data-codex-composer-root data-composer-placement="${threadId ? 'thread' : 'home'}">
    ${threadId ? `<i data-above-composer-conversation-id="${threadId}"></i>` : ''}
    <footer data-composer-footer-responsive>
      <span><button data-codex-intelligence-trigger="true" aria-haspopup="menu">Model</button></span>
    </footer>
  </main>`
  const elements = [...document.querySelectorAll<HTMLElement>('*')]
  for (const element of elements) {
    element.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 20,
      bottom: 20,
      width: 20,
      height: 20,
      toJSON: () => ({}),
    })
  }
  const trigger = document.querySelector<HTMLElement>('[data-codex-intelligence-trigger]')!
  const selectModel = vi.fn(async (nextModel: string, nextEffort: string) => {
    const fiber = (trigger as any).__reactFiber$test
    if (fiber) {
      fiber.return.memoizedProps.model = nextModel
      fiber.return.memoizedProps.reasoningEffort = nextEffort
    }
  })
  const attachNativeControl = () => {
    Object.defineProperty(trigger, '__reactFiber$test', {
      configurable: true,
      value: {
        memoizedProps: {},
        return: {
          memoizedProps: {
            model: 'model-a',
            reasoningEffort: 'high',
            models: [{
              model,
              supportedReasoningEfforts: [
                { reasoningEffort: 'low' },
                { reasoningEffort: 'high' },
              ],
            }],
            modelOptions: [{ model: { model: 'model-a' }, disabledReason: null }],
            powerSelections: [
              { model: 'model-a', reasoningEffort: 'low' },
              { model: 'model-a', reasoningEffort: 'high' },
            ],
            menuView: 'simple',
            open: false,
            showReasoningEffortControls: true,
            onSelectModelOption: () => {},
            onToggleMenuView: () => {},
            onSelectModel: selectModel,
            onSelectReasoningEffort: () => {},
          },
        },
      },
    })
  }
  if (attachControl) attachNativeControl()
  return { attachNativeControl, selectModel, trigger }
}
