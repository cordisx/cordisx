import type {
  GameUiReplyV1,
  GameUiRequestV1,
  GameUiSeatV1,
  GameUiSnapshotV1,
  IsolatedGameUiV1,
} from '@cordisx/protocol/isolated-game-ui/v1'
import { encodeRestrictedJson } from '../restricted-content/json.js'
import { htmlDocument } from './bundle.js'
const ROOM_ACTIONS = ['ready', 'cancel-ready', 'start', 'funding', 'next-round'] as const
type RoomAction = typeof ROOM_ACTIONS[number]
// Structural projection keeps this experimental implementation compatible with older installed typings.
interface ParticipantProjection {
  readonly seatIndex: number
  readonly name: string
  readonly kind: 'human' | 'agent' | 'bot'
  readonly avatar?: string
  readonly isOwner: boolean
}
type RoomWorkflowSnapshot = GameUiSnapshotV1 & {
  readonly roomActions?: readonly RoomAction[]
  readonly participants?: readonly ParticipantProjection[]
}
const AVATAR_DATA_URL =
  /^data:image\/(?:png|jpeg|webp);base64,(?=[A-Za-z0-9+/])(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?(?![\s\S])/
function validParticipants(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value) || value.length > 32) return false
  const seats = new Set<number>()
  return value.every(participant => {
    if (!participant || typeof participant !== 'object' || Array.isArray(participant)) return false
    if (
      Object.keys(participant).some(key => !['seatIndex', 'name', 'kind', 'avatar', 'isOwner'].includes(key))
      || !Number.isSafeInteger(participant.seatIndex) || participant.seatIndex < 0 || participant.seatIndex > 31
      || seats.has(participant.seatIndex) || typeof participant.name !== 'string'
      || !participant.name || participant.name.length > 256 || Array.from(participant.name).length > 128
      || !['human', 'agent', 'bot'].includes(participant.kind) || typeof participant.isOwner !== 'boolean'
      || (participant.avatar !== undefined
        && (typeof participant.avatar !== 'string' || participant.avatar.length > 65536
          || !AVATAR_DATA_URL.test(participant.avatar)))
    ) return false
    seats.add(participant.seatIndex)
    return true
  })
}
/** Opaque-origin execution, not a claim of complete network egress isolation. */
export function createIsolatedGameUiService(
  active: () => boolean,
  theme?: { read: () => 'light' | 'dark'; subscribe: (update: () => void) => () => void },
): IsolatedGameUiV1 {
  let disposed = false
  let pendingMounts = 0
  const seats = new Set<GameUiSeatV1>()
  const elements = new WeakSet<HTMLElement>()
  return {
    contract: 'cordisx.isolated-game-ui/v1',
    supportedBridgeVersions: [1],
    async mount(input) {
      if (disposed || !active()) return { status: 'unavailable', code: 'disposed' }
      if (
        !input.element?.ownerDocument || typeof input.title !== 'string' || typeof input.onRequest !== 'function'
        || elements.has(input.element) || seats.size + pendingMounts >= 16
      ) {
        return { status: 'unavailable', code: 'load-failed' }
      }
      elements.add(input.element)
      pendingMounts++
      const token = crypto.randomUUID()
      let html: string
      try {
        html = await htmlDocument(input.bundle, token)
      } catch {
        pendingMounts--
        elements.delete(input.element)
        return { status: 'unavailable', code: 'invalid-bundle' }
      }
      pendingMounts--
      if (disposed || !active()) {
        elements.delete(input.element)
        return { status: 'unavailable', code: 'disposed' }
      }
      const frame = input.element.ownerDocument.createElement('iframe')
      frame.title = input.title.slice(0, 200)
      frame.setAttribute('sandbox', 'allow-scripts')
      frame.setAttribute(
        'allow',
        "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'; usb 'none'; serial 'none'; hid 'none'; display-capture 'none'",
      )
      frame.referrerPolicy = 'no-referrer'
      frame.style.cssText = 'display:block;width:100%;height:100%;min-height:420px;border:0;background:transparent'
      let ended = false
      let connected = false
      let loaded = false
      let snapshot: RoomWorkflowSnapshot | undefined
      let busy = false
      let port: MessagePort | undefined
      let count = 0
      let period = 0
      const requests = new Map<string, { encoded: string; reply: Promise<GameUiReplyV1> }>()
      const live = () => !ended && !disposed && active() && frame.isConnected
      const sendSnapshot = () => {
        if (snapshot && connected && live()) port?.postMessage({ version: 1, type: 'snapshot', snapshot })
      }
      const fail = (code: string) => {
        seat.dispose()
        input.onUnavailable?.(code)
      }
      const timer = setTimeout(() => fail('handshake-timeout'), 10000)
      const receive = async ({ data }: MessageEvent) => {
        if (!live()) {
          seat.dispose()
          return
        }
        const now = performance.now()
        if (now - period > 1000) {
          period = now
          count = 0
        }
        if (++count > 60) {
          fail('message-rate-limit')
          return
        }
        let encoded: string
        try {
          encoded = encodeRestrictedJson(data, 8192)
        } catch {
          fail('invalid-message')
          return
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          fail('invalid-message')
          return
        }
        if (data.version !== 1) {
          fail('unsupported-version')
          return
        }
        if (data.type === 'ready' && !connected) {
          connected = true
          clearTimeout(timer)
          sendSnapshot()
          return
        }
        if (!connected) return
        if (data.type === 'snapshot-request') {
          sendSnapshot()
          return
        }
        if (
          data.type !== 'request' || typeof data.requestId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(data.requestId)
        ) return
        const reply = (value: GameUiReplyV1) => {
          if (live()) port?.postMessage({ version: 1, type: 'reply', requestId: data.requestId, reply: value })
        }
        const cached = requests.get(data.requestId)
        if (cached) {
          reply(cached.encoded === encoded ? await cached.reply : { status: 'rejected', code: 'request-id-conflict' })
          return
        }
        if (requests.size >= 256) {
          reply({ status: 'rejected', code: 'request-limit' })
          return
        }
        if (!snapshot || data.matchId !== snapshot.matchId || data.sequence !== snapshot.sequence) {
          reply({ status: 'rejected', code: 'stale-state' })
          return
        }
        if (
          Object.keys(data).some(k =>
            !['version', 'type', 'requestId', 'matchId', 'sequence', 'kind', 'payload'].includes(k)
          ) || !['action', 'room-action', 'exit', 'next-round'].includes(data.kind)
        ) return
        const roomOperation = data.kind === 'room-action'
            && data.payload && typeof data.payload === 'object' && !Array.isArray(data.payload)
            && Object.keys(data.payload).length === 1 && typeof data.payload.operation === 'string'
            && ['ready', 'cancel-ready', 'start', 'funding'].includes(data.payload.operation)
          ? data.payload.operation as Exclude<RoomAction, 'next-round'>
          : undefined
        if (data.kind === 'room-action' && roomOperation === undefined) {
          reply({ status: 'rejected', code: 'invalid-action' })
          return
        }
        const roomActionDenied = data.kind === 'room-action'
          && (snapshot.readOnly || !snapshot.roomActions?.includes(roomOperation!))
        const nextRoundDenied = data.kind === 'next-round' && snapshot.roomActions !== undefined
          && (snapshot.readOnly || !snapshot.roomActions.includes('next-round'))
        if (
          busy || (data.kind === 'action' && (snapshot.readOnly || !snapshot.canAct))
          || roomActionDenied || nextRoundDenied
        ) {
          reply({ status: 'rejected', code: 'not-actionable' })
          return
        }
        try {
          encodeRestrictedJson(data.payload, 4096)
        } catch {
          reply({ status: 'rejected', code: 'invalid-action' })
          return
        }
        const request: GameUiRequestV1 = {
          requestId: data.requestId,
          matchId: data.matchId,
          sequence: data.sequence,
          kind: data.kind,
          payload: data.payload,
        }
        busy = true
        const current = snapshot
        const task = Promise.resolve().then(() => input.onRequest(request)).catch((): GameUiReplyV1 => ({
          status: 'uncertain',
          code: 'transport-error',
        })).then(result => {
          const value: GameUiReplyV1 = result && ['accepted', 'rejected', 'uncertain'].includes(result.status)
            ? { status: result.status, ...(typeof result.code === 'string' ? { code: result.code.slice(0, 100) } : {}) }
            : { status: 'uncertain' }
          if (
            snapshot !== current || value.status === 'rejected'
            || !['action', 'room-action'].includes(request.kind)
          ) busy = false
          return value
        })
        requests.set(data.requestId, { encoded, reply: task })
        reply(await task)
      }
      const hello = (event: MessageEvent) => {
        if (
          !live() || event.source !== frame.contentWindow || event.origin !== 'null'
          || event.data?.type !== 'game-ui-hello' || event.data.token !== token || port
        ) return
        if (!Array.isArray(event.data.versions) || !event.data.versions.includes(1)) {
          fail('unsupported-version')
          return
        }
        const channel = new MessageChannel()
        port = channel.port1
        port.onmessage = receive
        port.start()
        frame.contentWindow!.postMessage({ type: 'game-ui-connect', token }, '*', [channel.port2])
      }
      const ownerWindow = input.element.ownerDocument.defaultView!
      ownerWindow.addEventListener('message', hello)
      frame.addEventListener('load', () => {
        if (loaded) fail('frame-navigated')
        loaded = true
      })
      const unsubscribeTheme = theme?.subscribe(() => {
        if (snapshot && snapshot.theme !== theme.read()) {
          snapshot = { ...snapshot, theme: theme.read() }
          sendSnapshot()
        }
      })
      const seat: GameUiSeatV1 = {
        publish(value) {
          if (!live()) {
            seat.dispose()
            return
          }
          const candidate: RoomWorkflowSnapshot = { ...value, theme: theme?.read() ?? value.theme }
          if (
            Object.keys(candidate).some(key =>
              ![
                'matchId',
                'sequence',
                'observation',
                'status',
                'canAct',
                'readOnly',
                'roomActions',
                'participants',
                'theme',
              ]
                .includes(key)
            )
            || !validParticipants(candidate.participants)
            || !Number.isSafeInteger(candidate.sequence) || candidate.sequence < 0
            || typeof candidate.matchId !== 'string'
            || candidate.matchId.length > 256 || !candidate.matchId || typeof candidate.status !== 'string'
            || typeof candidate.canAct !== 'boolean' || typeof candidate.readOnly !== 'boolean'
            || !['light', 'dark'].includes(candidate.theme)
          ) throw Error('invalid-snapshot')
          if (
            candidate.roomActions !== undefined
            && (!Array.isArray(candidate.roomActions) || candidate.roomActions.length > ROOM_ACTIONS.length
              || new Set(candidate.roomActions).size !== candidate.roomActions.length
              || candidate.roomActions.some(action => !ROOM_ACTIONS.includes(action)))
          ) throw Error('invalid-snapshot')
          if (snapshot && (snapshot.matchId !== candidate.matchId || candidate.sequence < snapshot.sequence)) {
            throw Error('stale-state')
          }
          if (
            snapshot && candidate.sequence === snapshot.sequence
            && JSON.stringify({ ...snapshot, theme: candidate.theme }) !== JSON.stringify(candidate)
          ) throw Error('stale-state')
          if (snapshot && JSON.stringify(snapshot) === JSON.stringify(candidate)) return
          const cloned = JSON.parse(encodeRestrictedJson(candidate, 262144)) as RoomWorkflowSnapshot
          if (!snapshot || cloned.sequence > snapshot.sequence) busy = false
          snapshot = cloned
          sendSnapshot()
        },
        dispose() {
          if (ended) return
          ended = true
          clearTimeout(timer)
          unsubscribeTheme?.()
          ownerWindow.removeEventListener('message', hello)
          port?.postMessage({ version: 1, type: 'disposed' })
          port?.close()
          frame.remove()
          requests.clear()
          elements.delete(input.element)
          seats.delete(seat)
        },
      }
      seats.add(seat)
      elements.add(input.element)
      frame.srcdoc = html
      input.element.append(frame)
      return { status: 'accepted', value: seat }
    },
    dispose() {
      disposed = true
      for (const seat of seats) seat.dispose()
    },
  }
}
