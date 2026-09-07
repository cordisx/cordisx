import type { ComposerDictationStateV2 } from '@cordisx/protocol/extension-point-visual/v2'
/** Version-sensitive probes verified against the 26.901.51231 installation source.
 * These nodes never cross the Host renderer boundary. Unknown labels fail closed.
 */
export type NativeComposerAction = 'voice' | 'send' | 'stop' | 'cancel' | 'queue' | 'steer' | 'resume' | 'end-voice'
const ACTION_LABELS: Readonly<Record<string, NativeComposerAction>> = Object.freeze({
  '开启语音聊天': 'voice',
  '开始新的语音聊天': 'voice',
  '发送': 'send',
  '转录并发送': 'send',
  'Transcribe and send': 'send',
  '停止': 'stop',
  '加入队列': 'queue',
  '调整方向': 'steer',
  '继续': 'resume',
  '取消语音聊天': 'cancel',
  '停止语音聊天': 'end-voice',
  '正在结束语音聊天…': 'end-voice',
  'Start voice chat': 'voice',
  'Start new voice chat': 'voice',
  Send: 'send',
  Stop: 'stop',
  Queue: 'queue',
  Steer: 'steer',
  Resume: 'resume',
  'Cancel voice chat': 'cancel',
  'Stop voice chat': 'end-voice',
  'Ending voice chat…': 'end-voice',
})

export interface NativeComposerVisualSeat {
  readonly frame: HTMLElement
  readonly button: HTMLButtonElement
  readonly visual: Element
  readonly action: NativeComposerAction
  readonly enabled: boolean
  readonly busy: boolean
  readonly draftEmpty: boolean
  readonly accessibleLabel: string
  readonly dictation: ComposerDictationStateV2
}
export type NativeComposerVisualProbe =
  | Readonly<{ status: 'available'; seat: NativeComposerVisualSeat }>
  | Readonly<{ status: 'pending' | 'unavailable'; reason: string }>

function visible(element: Element): boolean {
  const view = element.ownerDocument.defaultView
  if (view === null || element.closest('[inert], [aria-hidden="true"]') !== null) return false
  const bounds = element.getBoundingClientRect()
  const style = view.getComputedStyle(element)
  return element.isConnected && bounds.width > 0 && bounds.height > 0
    && style.display !== 'none' && style.visibility !== 'hidden'
    && bounds.right > 0 && bounds.bottom > 0 && bounds.left < view.innerWidth && bounds.top < view.innerHeight
}

const DICTATION_LABELS: Readonly<Record<string, ComposerDictationStateV2>> = {
  Dictate: 'idle',
  '听写': 'idle',
  'Stop dictation': 'recording',
  '停止听写': 'recording',
  'Finishing dictation': 'transcribing',
  '正在完成听写': 'transcribing',
  'Starting dictation; click to cancel': 'starting',
  'Retry dictation': 'retry',
  '重试听写': 'retry',
}
function dictationState(footer: HTMLElement): ComposerDictationStateV2 {
  const controls = [...footer.querySelectorAll<HTMLButtonElement>('button[aria-label]')]
    .filter(visible)
    .filter(button => DICTATION_LABELS[button.getAttribute('aria-label') ?? ''] !== undefined)
  if (controls.length !== 1) return 'unavailable'
  const button = controls[0]!
  const state = DICTATION_LABELS[button.getAttribute('aria-label') ?? '']!
  const busy = button.getAttribute('aria-busy')
  if (busy !== null && busy !== 'true' && busy !== 'false') return 'unavailable'
  // Native GLs uses aria-busy for both startup and final transcription.
  if (state === 'starting') return 'starting'
  const sendingTranscript = [...footer.querySelectorAll<HTMLButtonElement>('button[aria-label]')]
    .filter(visible)
    .some(control =>
      ['Transcribe and send', '转录并发送'].includes(control.getAttribute('aria-label') ?? '')
      && control.getAttribute('aria-busy') === 'true'
    )
  return busy === 'true' || sendingTranscript ? 'transcribing' : state
}

export function probeComposerVisual(document: Document): NativeComposerVisualProbe {
  const frames = [...document.querySelectorAll<HTMLElement>('[data-codex-composer-root][data-composer-placement]')]
    .filter(visible)
  if (frames.length === 0) return { status: 'pending', reason: 'Composer is not mounted' }
  if (frames.length !== 1) return { status: 'unavailable', reason: 'Composer anchor is ambiguous' }
  const frame = frames[0]!
  const footers = [...frame.querySelectorAll<HTMLElement>('[data-composer-footer-responsive]')].filter(visible)
  if (footers.length === 0) return { status: 'unavailable', reason: 'Composer footer is absent' }
  // X3 owns this native primary-control size token. Labels distinguish actual
  // operations (including queue/steer), never inferred from draft contents.
  const buttons = [...frame.querySelectorAll<HTMLButtonElement>('button.size-token-button-composer[aria-label]')]
    .filter(visible)
    .filter(button => footers.some(footer => footer.contains(button)))
    .filter(button => DICTATION_LABELS[button.getAttribute('aria-label') ?? ''] === undefined)
    .filter(button => button.closest('[data-cordisx-surface-host]') === null)
  if (buttons.length !== 1) return { status: 'unavailable', reason: 'Primary control is ambiguous or absent' }
  const button = buttons[0]!
  const footer = button.closest<HTMLElement>('[data-composer-footer-responsive]')!
  const label = button.getAttribute('aria-label') ?? ''
  const action = ACTION_LABELS[label]
  if (action === undefined) return { status: 'unavailable', reason: 'Primary operation is not recognized' }
  const children = [...button.children].filter(child => !child.hasAttribute('data-cordisx-composer-visual'))
  const spinner = children.length === 1 && children[0]!.tagName === 'DIV'
    && children[0]!.classList.contains('motion-safe:animate-spin')
    && children[0]!.children.length === 1 && children[0]!.firstElementChild?.tagName.toLowerCase() === 'svg'
  if (children.length !== 1 || (children[0]!.tagName.toLowerCase() !== 'svg' && !spinner)) {
    return { status: 'unavailable', reason: 'Native inner visual is not uniquely proven' }
  }
  const dictation = dictationState(footer)
  const isDictationLayout = ['Transcribe and send', '转录并发送'].includes(label)
    && ['recording', 'transcribing'].includes(dictation)
  const editors = [...frame.querySelectorAll<HTMLElement>('[contenteditable][role="textbox"], textarea')]
    .filter(editor =>
      editor.tagName === 'TEXTAREA' || editor.getAttribute('contenteditable') === 'true'
      || (isDictationLayout && editor.getAttribute('contenteditable') === 'false')
    )
    .filter(editor => visible(editor) || (isDictationLayout && editor.isConnected))
  if (editors.length !== 1) return { status: 'unavailable', reason: 'Composer editor is ambiguous or absent' }
  const editor = editors[0]!
  const text = editor.tagName === 'TEXTAREA' ? (editor as HTMLTextAreaElement).value : editor.textContent ?? ''
  // X3's morphing variant exposes aria-busy. Its non-morphing variant
  // renders WN's unique spinning DIV only while isLoading is true.
  const busyAttribute = button.getAttribute('aria-busy')
  if (busyAttribute !== null && busyAttribute !== 'true' && busyAttribute !== 'false') {
    return { status: 'unavailable', reason: 'Native busy state is not observable' }
  }
  const busy = busyAttribute === 'true' || spinner
  return {
    status: 'available',
    seat: {
      frame,
      button,
      visual: children[0]!,
      action,
      dictation,
      busy,
      enabled: !button.disabled && button.getAttribute('aria-disabled') !== 'true',
      draftEmpty: text.trim().length === 0,
      accessibleLabel: label,
    },
  }
}
