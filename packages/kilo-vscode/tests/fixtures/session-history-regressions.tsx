/** @jsxImportSource solid-js */
import assert from "node:assert/strict"
import { Window } from "happy-dom"
import type {
  ExtensionMessage,
  SessionFavoritesState,
  SessionInfo,
  SessionTagsState,
  WebviewMessage,
} from "../../webview-ui/src/types/messages"
import { post } from "../../webview-ui/src/utils/webview-message"

const window = new Window({ url: "http://localhost" })
window.document.write("<!doctype html><html><head></head><body></body></html>")
Object.defineProperty(window, "origin", { value: window.location.origin })
Object.defineProperty(window.document, "hasFocus", { value: () => true })

const sent: WebviewMessage[] = []
const tags: SessionTagsState = {
  tags: [
    { id: "tag-favorite", name: "Favorite tag", color: "Red" },
    { id: "tag-plain", name: "Plain tag", color: "Blue" },
    { id: "tag-outside", name: "Outside tag", color: "Green" },
    { id: "tag-child", name: "Child tag", color: "Purple" },
  ],
  sessions: {
    "history-favorite": ["tag-favorite"],
    "history-plain": ["tag-plain"],
    "outside-favorite": ["tag-outside"],
    "child-tagged": ["tag-child"],
  },
}
const favorites: SessionFavoritesState = { sessions: ["history-favorite", "outside-favorite"] }
const dispatch = (data: ExtensionMessage) => post(data)
const api = {
  postMessage: (message: WebviewMessage) => {
    sent.push(message)
    if (message.type === "requestSessionTags") {
      dispatch({ type: "sessionTagsLoaded", state: tags })
      return
    }
    if (message.type === "requestSessionFavorites") {
      dispatch({ type: "sessionFavoritesLoaded", state: favorites })
    }
  },
  getState: () => ({ sidebarSessionTabIDs: [], sidebarActiveSessionTabID: undefined }),
  setState: (_state: unknown) => undefined,
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
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  getComputedStyle: window.getComputedStyle.bind(window),
  acquireVsCodeApi: () => api,
})

const { createSignal } = await import("solid-js")
const { render } = await import("solid-js/web")
const { StoryProviders, mockSessionValue } = await import("../../webview-ui/src/stories/StoryProviders")
const { SessionContext } = await import("../../webview-ui/src/context/session")
const HistoryView = (await import("../../webview-ui/src/components/history/HistoryView")).default

const now = "2026-01-01T00:00:00.000Z"
const favoriteID = "history-favorite"
const plainID = "history-plain"
const outsideID = "outside-favorite"
const childID = "child-tagged"
const source: SessionInfo[] = [
  { id: favoriteID, title: "Favorite root", parentID: null, createdAt: now, updatedAt: now },
  { id: plainID, title: "Plain root", parentID: null, createdAt: now, updatedAt: now },
  { id: outsideID, title: "Outside root", parentID: null, createdAt: now, updatedAt: now },
  { id: childID, title: "Tagged child", parentID: plainID, createdAt: now, updatedAt: now },
]
const sourceBefore = structuredClone(source)
const [scope, setScope] = createSignal<ReadonlySet<string>>(new Set([favoriteID, plainID, childID]))
const base = mockSessionValue({ id: "not-in-history" })
let loadMoreCalls = 0
const session = {
  ...base,
  currentSessionID: () => undefined,
  currentSession: () => undefined,
  sessions: () => source,
  loadMoreSessions: () => {
    loadMoreCalls++
  },
  sessionsHasMore: () => true,
  sessionsLoadingMore: () => false,
}
const selected: string[] = []
const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () => (
    <StoryProviders sessionTags={null} sessionFavorites={null} noPadding>
      <SessionContext.Provider value={session as never}>
        <HistoryView sessionIds={scope} onSelectSession={(id) => selected.push(id)} />
      </SessionContext.Provider>
    </StoryProviders>
  ),
  root,
)

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

function row(id: string) {
  const value = root.querySelector<HTMLElement>(`#history-panel-local [data-slot="list-item"][data-key="${id}"]`)
  assert(value, `history row ${id} is mounted`)
  return value
}

function hasRow(id: string) {
  return root.querySelector(`#history-panel-local [data-slot="list-item"][data-key="${id}"]`) !== null
}

function ids() {
  return [...root.querySelectorAll<HTMLElement>('#history-panel-local [data-slot="list-item"][data-key]')]
    .map((item) => item.dataset.key)
    .filter((id): id is string => id !== undefined)
}

function tag(name: string) {
  const value = root.querySelector<HTMLButtonElement>(
    `#history-panel-local [data-slot="session-tag-filters"] button[aria-label="${name}"]`,
  )
  assert(value, `history exposes the ${name} tag filter`)
  return value
}

function hasTag(name: string) {
  return (
    root.querySelector(`#history-panel-local [data-slot="session-tag-filters"] button[aria-label="${name}"]`) !== null
  )
}

function favoriteButton(id: string) {
  const value = row(id).parentElement?.querySelector<HTMLButtonElement>(
    'button[data-slot="session-row-action"].session-favorite-button',
  )
  assert(value, `history row ${id} has a favorite action`)
  return value
}

function actions() {
  return sent.filter(
    (message): message is Extract<WebviewMessage, { type: "sessionFavoriteAction" }> =>
      message.type === "sessionFavoriteAction",
  )
}

function reply(requestID: string, ok: boolean, sessions?: string[]) {
  if (sessions) dispatch({ type: "sessionFavoritesLoaded", state: { sessions } })
  if (ok) {
    dispatch({ type: "sessionFavoriteResult", requestID, ok: true })
    return
  }
  dispatch({ type: "sessionFavoriteResult", requestID, ok: false, error: "storage" })
}

await settle()
assert.deepEqual([...ids()].sort(), [favoriteID, plainID], "scope and root projection keep only the visible root rows")
assert.equal(hasRow(outsideID), false, "an out-of-scope favorite root is absent from the rows")
assert.equal(hasRow(childID), false, "a child session is absent even when its id is in scope")
assert.equal(hasTag("Outside tag"), false, "an out-of-scope favorite does not leak its tag filter")
assert.equal(hasTag("Child tag"), false, "a child session does not leak its tag filter")
assert.deepEqual(
  [...root.querySelectorAll<HTMLElement>('#history-panel-local [data-slot="session-tag-filters"] button')]
    .map((button) => button.getAttribute("aria-label"))
    .sort(),
  ["Favorite tag", "Plain tag"],
  "tag filters are projected from scoped root sessions",
)
assert.deepEqual(
  [...row(favoriteID).querySelectorAll<HTMLElement>('[data-slot="session-tag"]')].map((item) =>
    item.textContent?.trim(),
  ),
  ["Favorite tag"],
  "the favorite root renders its own tag chip",
)
assert.deepEqual(
  [...row(plainID).querySelectorAll<HTMLElement>('[data-slot="session-tag"]')].map((item) => item.textContent?.trim()),
  ["Plain tag"],
  "the nonfavorite root renders its own tag chip",
)
assert.equal(new Set(ids()).size, ids().length, "flattened groups contain no duplicate row ids")
assert.equal(ids().filter((id) => id === favoriteID).length, 1, "a favorite is not duplicated into a date group")
assert.equal(
  [...root.querySelectorAll<HTMLElement>('#history-panel-local [data-slot="list-header"]')].some(
    (header) => header.textContent?.trim() === "Favorites",
  ),
  true,
  "the favorite root uses the favorites group",
)

const beforeActions = actions().length
favoriteButton(favoriteID).click()
favoriteButton(favoriteID).click()
assert.equal(actions().length, beforeActions + 1, "a second click on one pending favorite emits no second action")
const removeFavorite = actions().at(-1)
assert(removeFavorite)
assert.deepEqual(removeFavorite.action, { type: "set", sessionID: favoriteID, favorite: false })
assert.equal(favoriteButton(favoriteID).disabled, true, "the first row stays pending until its reply")

favoriteButton(plainID).click()
assert.equal(actions().length, beforeActions + 2, "a different row can emit while the first favorite is pending")
const addPlain = actions().at(-1)
assert(addPlain)
assert.deepEqual(addPlain.action, { type: "set", sessionID: plainID, favorite: true })
assert.equal(favoriteButton(plainID).disabled, true, "the second row has its own pending state")
assert.deepEqual(selected, [], "favorite actions do not select or open a session")

reply(addPlain.requestID, true, [favoriteID, plainID])
await settle()
assert.equal(favoriteButton(plainID).disabled, false, "the successful second-row reply clears only its pending state")
assert.equal(favoriteButton(plainID).getAttribute("aria-pressed"), "true")
assert.equal(favoriteButton(favoriteID).disabled, true, "the first row remains pending after the second row succeeds")
assert.deepEqual([...ids()].sort(), [favoriteID, plainID], "a confirmed favorite update keeps the visible rows scoped")
assert.equal(new Set(ids()).size, ids().length, "confirmed favorites still appear in only one group")

reply(removeFavorite.requestID, false)
await settle()
assert.equal(favoriteButton(favoriteID).disabled, false, "a failed favorite reply clears that row's pending state")
assert.equal(
  favoriteButton(favoriteID).getAttribute("aria-pressed"),
  "true",
  "a failed write preserves the favorite state",
)
assert.equal(
  [...document.querySelectorAll<HTMLElement>('[data-component="toast"] [data-slot="toast-title"]')]
    .at(-1)
    ?.textContent?.trim(),
  "Could not update favorites. Try again.",
  "a failed favorite write shows an error toast",
)

const beforeRetry = actions().length
favoriteButton(favoriteID).click()
assert.equal(actions().length, beforeRetry + 1, "a failed favorite row can be retried")
const retryFavorite = actions().at(-1)
assert(retryFavorite)
assert.deepEqual(retryFavorite.action, { type: "set", sessionID: favoriteID, favorite: false })
reply(retryFavorite.requestID, true, [plainID])
await settle()
assert.equal(favoriteButton(favoriteID).disabled, false, "the successful retry clears the row's pending state")
assert.equal(
  favoriteButton(favoriteID).getAttribute("aria-pressed"),
  "false",
  "the retried favorite update reaches its row",
)
assert.deepEqual(selected, [], "favorite retries still do not select or open a session")

const beforeScopedTagLoad = loadMoreCalls
tag("Favorite tag").click()
await settle()
assert.equal(loadMoreCalls, beforeScopedTagLoad, "selecting a scoped tag does not load another history page")
assert.deepEqual([...ids()].sort(), [favoriteID], "one selected tag keeps only its matching root")
tag("Plain tag").click()
await settle()
assert.deepEqual([...ids()].sort(), [favoriteID, plainID], "multiple selected tags use OR semantics")
tag("Favorite tag").click()
await settle()
assert.deepEqual([...ids()].sort(), [plainID], "removing one selected tag keeps the other tag active")
tag("Plain tag").click()
await settle()
tag("Favorite tag").click()
await settle()
assert.deepEqual([...ids()].sort(), [favoriteID], "the chosen tag is active before a scope change")

const beforeScopeChangeLoad = loadMoreCalls
setScope(new Set([plainID]))
await settle()
assert.equal(loadMoreCalls, beforeScopeChangeLoad, "a scoped tag disappearing does not trigger history pagination")
assert.equal(hasTag("Favorite tag"), false, "a tag outside the new scope is removed from the filter chips")
assert.equal(tag("Plain tag").getAttribute("aria-pressed"), "false", "the removed chosen tag selection is cleared")
assert.deepEqual([...ids()].sort(), [plainID], "clearing the removed chosen tag restores the scoped root")
assert.equal(hasRow(outsideID), false, "scope changes continue to exclude the outside favorite")
assert.equal(hasRow(childID), false, "scope changes continue to exclude child sessions")
assert.equal(hasTag("Outside tag"), false, "scope changes do not expose the outside favorite tag")
assert.equal(hasTag("Child tag"), false, "scope changes do not expose the child tag")
assert.deepEqual(
  source,
  sourceBefore,
  "rendering, filtering, and favorite updates do not mutate source SessionInfo objects",
)

dispose()
