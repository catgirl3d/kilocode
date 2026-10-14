/** @jsxImportSource solid-js */
import assert from "node:assert/strict"
import { Window } from "happy-dom"
import type {
  ExtensionMessage,
  SessionFavoritesState,
  SessionTagsState,
  VSCodeAPI,
  WebviewMessage,
} from "../../webview-ui/src/types/messages"

const window = new Window({ url: "http://localhost" })
window.document.write("<!doctype html><html><head></head><body></body></html>")
Object.defineProperty(window, "origin", { value: window.location.origin })
Object.defineProperty(window.document, "hasFocus", { value: () => true })
const media = {
  matches: false,
  media: "",
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
}
Object.assign(window, { matchMedia: () => media })

const tasks = new Map<number, () => void>()
let nextTask = 0
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const fakeSetTimeout = ((callback: () => void) => {
  const id = ++nextTask
  tasks.set(id, callback)
  return id
}) as typeof setTimeout
const fakeClearTimeout = ((id: ReturnType<typeof setTimeout>) => {
  tasks.delete(Number(id))
}) as typeof clearTimeout
const clock = {
  pending: () => tasks.size,
  reset: () => tasks.clear(),
  runOne: () => {
    const entry = tasks.entries().next()
    if (entry.done) return false
    tasks.delete(entry.value[0])
    entry.value[1]()
    return true
  },
  runAll: () => {
    while (clock.runOne()) {}
  },
}

const sent: WebviewMessage[] = []
const mode = { favorites: "hold" as "hold" | "sync", tags: "hold" as "hold" | "sync" }
const favoriteState: SessionFavoritesState = { sessions: ["ses-provider"] }
const tagState: SessionTagsState = {
  tags: [{ id: "tag-provider", name: "Provider tag", color: "Red" }],
  sessions: { "ses-provider": ["tag-provider"] },
}
let deliver = (_message: ExtensionMessage) => {}
const api: VSCodeAPI = {
  postMessage: (message) => {
    sent.push(message)
    if (message.type === "requestSessionFavorites") {
      if (mode.favorites === "sync") deliver({ type: "sessionFavoritesLoaded", state: favoriteState })
      return
    }
    if (message.type === "requestSessionTags") {
      if (mode.tags === "sync") deliver({ type: "sessionTagsLoaded", state: tagState })
    }
  },
  getState: () => ({ sidebarSessionTabIDs: [], sidebarActiveSessionTabID: undefined }),
  setState: () => {},
}

Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  localStorage: window.localStorage,
  sessionStorage: window.sessionStorage,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  Element: window.Element,
  HTMLElement: window.HTMLElement,
  HTMLHeadElement: window.HTMLHeadElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLTextAreaElement: window.HTMLTextAreaElement,
  SVGElement: window.SVGElement,
  MutationObserver: window.MutationObserver,
  IntersectionObserver: window.IntersectionObserver,
  ResizeObserver: window.ResizeObserver,
  CustomEvent: window.CustomEvent,
  customElements: window.customElements,
  Event: window.Event,
  InputEvent: window.InputEvent,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  MessageEvent: window.MessageEvent,
  PointerEvent: window.PointerEvent,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
  acquireVsCodeApi: () => api,
  setTimeout: fakeSetTimeout,
  clearTimeout: fakeClearTimeout,
})

const { createRoot } = await import("solid-js")
const { render } = await import("solid-js/web")
const { post } = await import("../../webview-ui/src/utils/webview-message")
const { requestSnapshot } = await import("../../webview-ui/src/context/host-snapshot")
const { VSCodeProvider } = await import("../../webview-ui/src/context/vscode")
const { SessionFavoritesProvider, useSessionFavorites } = await import("../../webview-ui/src/context/session-favorites")
const { SessionTagsProvider, useSessionTags } = await import("../../webview-ui/src/context/session-tags")
const { ProviderShell } = await import("../../webview-ui/src/context/provider-shell")

deliver = (message) => post(message)

async function flush() {
  const first = Promise.withResolvers<void>()
  queueMicrotask(first.resolve)
  await first.promise
  const second = Promise.withResolvers<void>()
  queueMicrotask(second.resolve)
  await second.promise
}

function requestCount(type: "requestSessionFavorites" | "requestSessionTags") {
  return sent.filter((message) => message.type === type).length
}

function favoriteActions() {
  return sent.flatMap((message) => (message.type === "sessionFavoriteAction" ? [message] : []))
}

function snapshotScene() {
  let loaded = false
  const requests: string[] = []
  const handlers = new Set<(message: ExtensionMessage) => void>()
  const scene = createRoot((dispose) => {
    requestSnapshot({
      request: () => requests.push("request"),
      ready: () => loaded,
      onMessage: (handler) => {
        handlers.add(handler)
        return () => handlers.delete(handler)
      },
      delay: 20,
    })
    return { dispose }
  })
  return {
    dispose: scene.dispose,
    emit: (message: ExtensionMessage) => [...handlers].forEach((handler) => handler(message)),
    handlers,
    requests,
    setLoaded: (value: boolean) => (loaded = value),
  }
}

clock.reset()
const missing = snapshotScene()
assert.equal(missing.requests.length, 1, "the snapshot helper requests immediately")
assert.equal(clock.pending(), 1, "the snapshot helper queues one fallback")
assert.equal(clock.runOne(), true)
assert.equal(missing.requests.length, 2, "an unloaded snapshot gets one fallback request")
assert.equal(clock.pending(), 0, "the fallback is not repeated")
missing.dispose()

clock.reset()
const loaded = snapshotScene()
loaded.setLoaded(true)
assert.equal(clock.runOne(), true)
assert.equal(loaded.requests.length, 1, "a snapshot loaded before the fallback is not requested twice")
loaded.dispose()

clock.reset()
const retried = snapshotScene()
retried.emit({ type: "extensionDataReady" })
assert.equal(retried.requests.length, 2, "extensionDataReady retries a missing snapshot once")
assert.equal(clock.pending(), 0, "the extensionDataReady retry cancels the fallback")
retried.emit({ type: "extensionDataReady" })
assert.equal(retried.requests.length, 2, "repeated extensionDataReady does not retry again")
assert.equal(retried.handlers.size, 0, "the retry listener is removed after the first ready event")
retried.dispose()

clock.reset()
const disposedSnapshot = snapshotScene()
disposedSnapshot.dispose()
assert.equal(clock.pending(), 0, "disposing the snapshot helper clears its fallback")
assert.equal(disposedSnapshot.handlers.size, 0, "disposing the snapshot helper removes its listener")
assert.equal(clock.runOne(), false)
disposedSnapshot.emit({ type: "extensionDataReady" })
assert.equal(disposedSnapshot.requests.length, 1, "a disposed snapshot helper ignores late ready events")

mode.favorites = "hold"
mode.tags = "hold"
clock.reset()
let favorites!: ReturnType<typeof useSessionFavorites>
let tags!: ReturnType<typeof useSessionTags>
const ProviderProbe = () => {
  favorites = useSessionFavorites()
  tags = useSessionTags()
  return null
}
const providerRoot = document.createElement("div")
document.body.append(providerRoot)
const providerDispose = render(
  () => (
    <VSCodeProvider>
      <SessionFavoritesProvider>
        <SessionTagsProvider>
          <ProviderProbe />
        </SessionTagsProvider>
      </SessionFavoritesProvider>
    </VSCodeProvider>
  ),
  providerRoot,
)
await flush()
assert.equal(requestCount("requestSessionFavorites"), 1, "the real favorites provider requests its snapshot once")
assert.equal(requestCount("requestSessionTags"), 1, "the real tags provider requests its snapshot once")
assert.equal(favorites.ready(), false, "the real favorites provider stays unloaded without a host reply")
assert.equal(tags.ready(), false, "the real tags provider stays unloaded without a host reply")

let favorite: { ok: boolean; error?: string } | undefined
let tag: { ok: boolean; error?: string } | undefined
void favorites.mutate({ type: "set", sessionID: "ses-unloaded", favorite: true }).then((value) => {
  favorite = value
})
void tags.mutate({ type: "assign", sessionID: "ses-unloaded", id: "tag-provider", assigned: true }).then((value) => {
  tag = value
})
await flush()
assert.deepEqual(favorite, { ok: false }, "an unloaded favorites provider sends no mutation")
assert.deepEqual(tag, { ok: false }, "an unloaded tags provider sends no mutation")
assert.equal(sent.filter((message) => message.type === "sessionFavoriteAction").length, 0)
assert.equal(sent.filter((message) => message.type === "sessionTagAction").length, 0)

mode.favorites = "sync"
mode.tags = "sync"
post({ type: "extensionDataReady" })
await flush()
assert.equal(requestCount("requestSessionFavorites"), 2, "extensionDataReady retries the real favorites provider")
assert.equal(requestCount("requestSessionTags"), 2, "extensionDataReady retries the real tags provider")
assert.equal(favorites.ready(), true, "the real favorites provider captures the retried snapshot")
assert.equal(tags.ready(), true, "the real tags provider captures the retried snapshot")
assert.deepEqual(favorites.state(), favoriteState)
assert.deepEqual(tags.state(), tagState)
assert.deepEqual(tags.forSession("ses-provider"), tagState.tags, "the real tags consumer resolves assigned tags")
post({ type: "extensionDataReady" })
await flush()
assert.equal(requestCount("requestSessionFavorites"), 2, "a second ready event does not reload favorites")
assert.equal(requestCount("requestSessionTags"), 2, "a second ready event does not reload tags")

let firstDone = false
let secondDone = false
let one: { ok: boolean; error?: string } | undefined
let two: { ok: boolean; error?: string } | undefined
const first = favorites.mutate({ type: "set", sessionID: "ses-first", favorite: true })
const second = favorites.mutate({ type: "set", sessionID: "ses-second", favorite: false })
void first.then((value) => {
  firstDone = true
  one = value
})
void second.then((value) => {
  secondDone = true
  two = value
})
const actions = favoriteActions().slice(-2)
assert.equal(actions.length, 2, "two ready mutations each cross the host boundary")
assert.notEqual(actions[0]!.requestID, actions[1]!.requestID, "ready mutations use unique request IDs")
assert.notEqual(actions[0]!.requestID, "")
assert.notEqual(actions[1]!.requestID, "")
assert.deepEqual(actions[0]!.action, { type: "set", sessionID: "ses-first", favorite: true })
assert.deepEqual(actions[1]!.action, { type: "set", sessionID: "ses-second", favorite: false })
post({ type: "sessionFavoriteResult", requestID: "unknown-request", ok: true })
post({ type: "sessionTagsLoaded", state: { tags: [], sessions: {} } })
await flush()
assert.equal(firstDone, false, "an unknown reply does not settle the first mutation")
assert.equal(secondDone, false, "an unknown reply does not settle the second mutation")
assert.deepEqual(favorites.state(), favoriteState, "an unrelated tags snapshot does not change favorites")
post({ type: "sessionFavoriteResult", requestID: actions[1]!.requestID, ok: false, error: "storage" })
post({ type: "sessionFavoriteResult", requestID: actions[0]!.requestID, ok: true })
await flush()
assert.equal(firstDone, true)
assert.equal(secondDone, true)
assert.equal(one?.ok, true, "the first mutation follows its own reply")
assert.equal(one?.error, undefined)
assert.equal(two?.ok, false, "the second mutation follows its own reply")
assert.equal(two?.error, "storage")
providerDispose()

mode.favorites = "hold"
clock.reset()
let cleanupFavorites!: ReturnType<typeof useSessionFavorites>
const CleanupProbe = () => {
  cleanupFavorites = useSessionFavorites()
  return null
}
const cleanupRoot = document.createElement("div")
document.body.append(cleanupRoot)
const cleanupDispose = render(
  () => (
    <VSCodeProvider>
      <SessionFavoritesProvider>
        <CleanupProbe />
      </SessionFavoritesProvider>
    </VSCodeProvider>
  ),
  cleanupRoot,
)
await flush()
assert.equal(requestCount("requestSessionFavorites"), 3)
post({ type: "sessionFavoritesLoaded", state: { sessions: ["ses-clean"] } })
await flush()
const pendingFavorite = cleanupFavorites.mutate({ type: "set", sessionID: "ses-pending", favorite: true })
const actionsBeforeCleanup = favoriteActions().length
let done = false
let result: { ok: boolean; error?: string } | undefined
void pendingFavorite.then((value) => {
  done = true
  result = value
})
cleanupDispose()
await flush()
assert.equal(done, true, "disposing favorites settles the pending mutation")
assert.deepEqual(result, { ok: false }, "disposing favorites resolves pending mutations as false")
assert.equal(clock.pending(), 0, "disposing favorites clears the snapshot fallback timer")
post({ type: "sessionFavoritesLoaded", state: { sessions: ["ses-late"] } })
post({ type: "extensionDataReady" })
clock.runAll()
assert.deepEqual(cleanupFavorites.state(), { sessions: ["ses-clean"] }, "disposed favorites ignore late snapshots")
let late = false
let answer: { ok: boolean; error?: string } | undefined
const after = cleanupFavorites.mutate({ type: "set", sessionID: "ses-after-dispose", favorite: true })
void after.then((value) => {
  late = true
  answer = value
})
await flush()
assert.equal(late, true, "disposed favorites settle later mutations")
assert.deepEqual(answer, { ok: false }, "disposed favorites reject later mutations")
assert.equal(favoriteActions().length, actionsBeforeCleanup, "disposed favorites send no later mutation")

mode.favorites = "sync"
mode.tags = "sync"
clock.reset()
let rootFavorites!: ReturnType<typeof useSessionFavorites>
let rootTags!: ReturnType<typeof useSessionTags>
const RootProbe = () => {
  rootFavorites = useSessionFavorites()
  rootTags = useSessionTags()
  return null
}
const shellRoot = document.createElement("div")
document.body.append(shellRoot)
const shellDispose = render(
  () => (
    <ProviderShell.Root>
      <RootProbe />
    </ProviderShell.Root>
  ),
  shellRoot,
)
await flush()
assert.equal(requestCount("requestSessionFavorites"), 4, "ProviderShell.Root mounts the real favorites provider")
assert.equal(requestCount("requestSessionTags"), 3, "ProviderShell.Root mounts the real tags provider")
assert.equal(rootFavorites.ready(), true, "ProviderShell.Root exposes a loaded favorites provider")
assert.equal(rootTags.ready(), true, "ProviderShell.Root exposes a loaded tags provider")
assert.deepEqual(rootFavorites.state(), favoriteState)
assert.deepEqual(rootTags.state(), tagState)
assert.deepEqual(rootTags.forSession("ses-provider"), tagState.tags)
shellDispose()
assert.equal(clock.pending(), 0, "ProviderShell.Root disposes provider fallback timers")

Object.assign(globalThis, { setTimeout: realSetTimeout, clearTimeout: realClearTimeout })
assert.equal(providerRoot.childNodes.length, 0)
assert.equal(cleanupRoot.childNodes.length, 0)
assert.equal(shellRoot.childNodes.length, 0)
