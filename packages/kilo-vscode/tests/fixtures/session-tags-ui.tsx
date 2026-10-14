/** @jsxImportSource solid-js */
import assert from "node:assert/strict"
import { Window } from "happy-dom"
import type {
  ExtensionMessage,
  SessionInfo,
  SessionFavoritesState,
  SessionTagsState,
  WebviewMessage,
} from "../../webview-ui/src/types/messages"
import { post } from "../../webview-ui/src/utils/webview-message"

const window = new Window({ url: "http://localhost" })
window.document.write("<!doctype html><html><head></head><body></body></html>")
Object.defineProperty(window, "origin", { value: window.location.origin })
Object.defineProperty(window.document, "hasFocus", { value: () => true })

const sent: WebviewMessage[] = []
const writes: unknown[] = []
const empty: SessionTagsState = { tags: [], sessions: {} }
let favoriteState: SessionFavoritesState = { sessions: [] }
let requests = 0
let favoriteRequests = 0
let favoriteResponse: (() => void) | undefined
let favoriteWritesFail = false
const favoriteReplies: Array<"defer" | "drop" | "send"> = ["defer"]
const dispatch = (data: ExtensionMessage) => post(data)
const api = {
  postMessage: (message: WebviewMessage) => {
    sent.push(message)
    if (message.type === "requestSessionColors") {
      dispatch({ type: "sessionColorsLoaded", colors: { "ses-home": "Red", "ses-tagged": "Green" } })
      return
    }
    if (message.type === "requestSessionTags") {
      requests++
      if (requests === 1) dispatch({ type: "sessionTagsLoaded", state: empty })
      return
    }
    if (message.type === "requestSessionFavorites") {
      favoriteRequests++
      const mode = favoriteReplies.shift() ?? "send"
      const send = () => dispatch({ type: "sessionFavoritesLoaded", state: favoriteState })
      if (mode === "defer") favoriteResponse = send
      else if (mode === "send") send()
      return
    }
    if (message.type !== "sessionFavoriteAction") return
    if (favoriteWritesFail) {
      dispatch({ type: "sessionFavoriteResult", requestID: message.requestID, ok: false, error: "storage" })
      return
    }
    if (message.action.type !== "set") {
      dispatch({ type: "sessionFavoriteResult", requestID: message.requestID, ok: false, error: "invalid" })
      return
    }
    const sessions = favoriteState.sessions.filter((id) => id !== message.action.sessionID)
    if (message.action.favorite) sessions.push(message.action.sessionID)
    favoriteState = { sessions }
    dispatch({ type: "sessionFavoritesLoaded", state: favoriteState })
    dispatch({ type: "sessionFavoriteResult", requestID: message.requestID, ok: true })
  },
  getState: () => ({ sidebarSessionTabIDs: ["ses-home"], sidebarActiveSessionTabID: "ses-home" }),
  setState: (state: unknown) => writes.push(state),
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

const { createSignal, Show } = await import("solid-js")
const { render } = await import("solid-js/web")
const { StoryProviders, mockSessionValue, t } = await import("../../webview-ui/src/stories/StoryProviders")
const { SessionTagsProvider, useSessionTags } = await import("../../webview-ui/src/context/session-tags")
const { SessionFavoritesProvider, useSessionFavorites } = await import("../../webview-ui/src/context/session-favorites")
const { SessionContext } = await import("../../webview-ui/src/context/session")
const { LocalTabsProvider } = await import("../../webview-ui/src/context/local-tabs")
const SessionList = (await import("../../webview-ui/src/components/history/SessionList")).default
const { WelcomeEmptyState } = await import("../../webview-ui/src/components/chat/WelcomeEmptyState")
const { TaskHeader } = await import("../../webview-ui/src/components/chat/TaskHeader")
const { SessionTabStrip } = await import("../../webview-ui/src/components/chat/SessionTabStrip")
const { PENDING_TAB_PREFIX } = await import("../../webview-ui/src/utils/local-tabs")
const { SECTION_COLORS } = await import("../../webview-ui/agent-manager/section-colors")

const now = new Date().toISOString()
const items: SessionInfo[] = [
  { id: "ses-home", title: "Refactor authentication", createdAt: now, updatedAt: now },
  { id: "ses-tagged", title: "Polish documentation", createdAt: now, updatedAt: now },
  { id: "ses-plain", title: "Check release notes", createdAt: now, updatedAt: now },
]
const [active, setActive] = createSignal("ses-home")
const [secondary, setSecondary] = createSignal(false)
const [tertiary, setTertiary] = createSignal(false)
const [sessions] = createSignal(items)
const selected: string[] = []
const renamed: string[] = []
const [amColors, setAmColors] = createSignal<Record<string, string>>({ "ses-home": "Purple", "ses-plain": "Blue" })
const amSets: { id: string; color: string | null }[] = []
const base = mockSessionValue({ id: "ses-home" })
const session = {
  ...base,
  currentSessionID: active,
  currentSession: () => sessions().find((item) => item.id === active()),
  sessions,
  selectSession: (id: string) => {
    selected.push(id)
    setActive(id)
  },
  renameSession: (id: string, title: string) => renamed.push(`${id}:${title}`),
  activityFor: () => "idle" as const,
  messages: () => [{ id: "home-message", sessionID: "ses-home", role: "user", createdAt: now }],
  visibleMessages: () => [],
}
const cloudID = "cloud:preview"
const draftID = `${PENDING_TAB_PREFIX}test`
const cloud = {
  ...session,
  currentSessionID: () => cloudID,
  currentSession: () => ({ id: cloudID, title: "Cloud preview", createdAt: now, updatedAt: now }),
  cloudPreviewId: () => cloudID,
}
const draft = {
  ...session,
  currentSessionID: () => draftID,
  currentSession: () => ({ id: draftID, title: "Unsaved draft", createdAt: now, updatedAt: now }),
  draftSessionID: () => draftID,
}

let tags: ReturnType<typeof useSessionTags> | undefined
let unloaded: ReturnType<typeof useSessionTags> | undefined
let favorites: ReturnType<typeof useSessionFavorites> | undefined
let unloadedFavorites: ReturnType<typeof useSessionFavorites> | undefined
let tertiaryFavorites: ReturnType<typeof useSessionFavorites> | undefined
const Probe = () => {
  tags = useSessionTags()
  return <output data-testid="tags-ready">{String(tags.ready())}</output>
}
const UnloadedProbe = () => {
  unloaded = useSessionTags()
  return <output data-testid="unloaded-ready">{String(unloaded.ready())}</output>
}
const FavoriteProbe = () => {
  favorites = useSessionFavorites()
  return <output data-testid="favorites-ready">{String(favorites.ready())}</output>
}
const UnloadedFavoriteProbe = () => {
  unloadedFavorites = useSessionFavorites()
  return <output data-testid="unloaded-favorites-ready">{String(unloadedFavorites.ready())}</output>
}
const TertiaryFavoriteProbe = () => {
  tertiaryFavorites = useSessionFavorites()
  return <output data-testid="tertiary-favorites-ready">{String(tertiaryFavorites.ready())}</output>
}

const root = document.createElement("div")
document.body.append(root)
const dispose = render(
  () => (
    <StoryProviders sessionID="ses-home" sessionTags={null} sessionFavorites={null} failTags={false} noPadding>
      <SessionContext.Provider value={session as never}>
        <Probe />
        <FavoriteProbe />
        <Show when={secondary()}>
          <SessionTagsProvider>
            <UnloadedProbe />
          </SessionTagsProvider>
          <SessionFavoritesProvider>
            <UnloadedFavoriteProbe />
          </SessionFavoritesProvider>
        </Show>
        <Show when={tertiary()}>
          <SessionFavoritesProvider>
            <TertiaryFavoriteProbe />
          </SessionFavoritesProvider>
        </Show>
        <LocalTabsProvider>
          <section data-testid="history">
            <SessionList onSelectSession={(id) => selected.push(id)} />
          </section>
          <section data-testid="welcome">
            <WelcomeEmptyState onSelectSession={(id) => selected.push(id)} />
          </section>
          <div data-testid="tabs">
            <SessionTabStrip />
          </div>
        </LocalTabsProvider>
        <section data-testid="am-history">
          <SessionList
            onSelectSession={(id) => selected.push(id)}
            sessionColor={(id) => amColors()[id]}
            setSessionColor={(id, color) => {
              amSets.push({ id, color })
              setAmColors((prev) => {
                if (color) return { ...prev, [id]: color }
                const next = { ...prev }
                delete next[id]
                return next
              })
            }}
          />
        </section>
        <div data-testid="header">
          <TaskHeader />
        </div>
        <div data-testid="readonly-header">
          <TaskHeader readonly />
        </div>
        <div data-testid="cloud-header">
          <SessionContext.Provider value={cloud as never}>
            <TaskHeader />
          </SessionContext.Provider>
        </div>
        <div data-testid="draft-header">
          <SessionContext.Provider value={draft as never}>
            <TaskHeader />
          </SessionContext.Provider>
        </div>
      </SessionContext.Provider>
    </StoryProviders>
  ),
  root,
)

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

function filter(value: string) {
  const input = root.querySelector<HTMLInputElement>('[data-testid="history"] [data-slot="list-search"] input')
  assert(input, "history search input is mounted")
  input.value = value
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }))
  input.dispatchEvent(new Event("change", { bubbles: true }))
  return input
}

function item(id: string) {
  return root.querySelector<HTMLButtonElement>(`[data-testid="history"] [data-slot="list-item"][data-key="${id}"]`)
}

function manage(id: string) {
  const row = item(id)
  assert(row, `history row ${id} is mounted`)
  const button = row.parentElement?.querySelector<HTMLButtonElement>(
    'button[data-slot="session-row-action"].session-tags-button',
  )
  assert(button, `history row ${id} has a tag-management action`)
  return button
}

function favoriteButton(id: string, scope = "history") {
  const row = root.querySelector<HTMLElement>(`[data-testid="${scope}"] [data-slot="list-item"][data-key="${id}"]`)
  assert(row, `${scope} row ${id} is mounted`)
  const button = row.parentElement?.querySelector<HTMLButtonElement>(
    'button[data-slot="session-row-action"].session-favorite-button',
  )
  assert(button, `${scope} row ${id} has a favorite action`)
  return button
}

function groupHeaders(scope: string) {
  return [...root.querySelectorAll<HTMLElement>(`[data-testid="${scope}"] [data-slot="list-header"]`)].map((item) =>
    item.textContent?.trim(),
  )
}

function groupItems(scope: string) {
  return [...root.querySelectorAll<HTMLElement>(`[data-testid="${scope}"] [data-slot="list-group"]`)].map((group) =>
    [...group.querySelectorAll<HTMLElement>('[data-slot="list-item"][data-key]')].map((item) => item.dataset.key),
  )
}

function filterTag(name: string) {
  const button = root.querySelector<HTMLButtonElement>(
    `[data-testid="history"] [data-slot="session-tag-filters"] button[aria-label="${name}"]`,
  )
  assert(button, `the history filter exposes ${name}`)
  return button
}

function dialog() {
  const value = document.querySelector<HTMLElement>('[role="dialog"]')
  assert(value, "tag editor is open")
  return value
}

function checkbox(editor: HTMLElement, name: string) {
  const label = [...editor.querySelectorAll<HTMLElement>('[data-slot="checkbox-checkbox-label"]')].find(
    (item) => item.textContent?.trim() === name,
  )
  assert(label, `the editor has a checkbox for ${name}`)
  const input = label
    .closest('[data-component="checkbox"]')
    ?.querySelector<HTMLInputElement>('[data-slot="checkbox-checkbox-input"]')
  assert(input, `the ${name} checkbox has its actual input`)
  return { label, input }
}

function field(editor: HTMLElement) {
  const label = [...editor.querySelectorAll<HTMLElement>('[data-slot="input-label"]')].find(
    (item) => item.textContent?.trim() === "Tag name",
  )
  assert(label, "the editor exposes the translated tag-name field")
  const input = label.closest('[data-component="input"]')?.querySelector<HTMLInputElement>('[data-slot="input-input"]')
  assert(input)
  return input
}

const response = (state: SessionTagsState) => dispatch({ type: "sessionTagsLoaded", state })

assert(tags, "the real provider is available to its consumers")
assert.equal(requests, 1, "the real provider requests one host snapshot")
assert.equal(tags.ready(), true, "the provider catches a snapshot delivered synchronously with its request")
assert.deepEqual(tags.state(), empty, "a loaded empty catalog differs from an unloaded catalog")
assert(favorites, "the real favorites provider is available to its consumers")
assert.equal(favoriteRequests, 1, "the real favorites provider requests one host snapshot")
await settle()
assert.equal(favoriteButton("ses-home").disabled, true, "the favorite action stays disabled until its snapshot arrives")
favoriteResponse?.()
await settle()
assert.equal(favorites.ready(), true, "the favorites provider accepts its delayed snapshot")
assert.equal(favoriteButton("ses-home").disabled, false, "the favorite action enables after the snapshot arrives")
setSecondary(true)
await settle()
assert(unloaded, "the nested real provider is available to its consumer")
assert.equal(requests, 2, "the second provider requests one host snapshot")
assert.equal(unloaded.ready(), false, "the second provider remains unloaded until its host response")
assert.deepEqual(unloaded.state(), empty, "an unloaded provider still exposes the empty initial value")
assert(unloadedFavorites, "the nested favorites provider is available to its consumer")
assert.equal(favoriteRequests, 2, "the second favorites provider requests one host snapshot")
assert.equal(unloadedFavorites.ready(), true, "an early synchronous favorites snapshot is not lost")
response(empty)
assert.equal(unloaded.ready(), true, "an empty host snapshot marks the provider ready")
assert.equal(
  root.querySelector('[data-testid="history"] [data-slot="session-tag-filters"]'),
  null,
  "an empty loaded catalog does not render tag filters",
)

favoriteReplies.push("drop")
setTertiary(true)
await settle()
assert(tertiaryFavorites, "the retry probe is available to its consumer")
assert.equal(favoriteRequests, 3, "the third favorites provider requests one host snapshot")
assert.equal(tertiaryFavorites.ready(), false, "a lost snapshot response leaves the provider unloaded")
dispatch({ type: "extensionDataReady" })
await settle()
assert.equal(favoriteRequests, 4, "extensionDataReady retries the lost snapshot request")
assert.equal(tertiaryFavorites.ready(), true, "the retried request loads the pending snapshot")
assert.equal(requests, 2, "ready tag providers ignore extensionDataReady")

const initial: SessionTagsState = {
  tags: [
    { id: "tag-urgent", name: "Urgent", color: "Red" },
    { id: "tag-review", name: "Review", color: "Blue" },
    { id: "tag-follow-up", name: "Follow-up", color: "Green" },
    { id: "tag-russian", name: "Очень длинное русское название очереди", color: "Purple" },
    { id: "tag-ops", name: "On call", color: "Yellow" },
  ],
  sessions: {
    "ses-home": ["tag-urgent", "tag-review", "tag-follow-up", "tag-russian"],
    "ses-tagged": ["tag-ops", "tag-urgent"],
  },
}
response(initial)
await settle()
const filterRoot = root.querySelector<HTMLElement>('[data-testid="history"] [data-slot="session-tag-filters"]')
assert(filterRoot, "a non-empty loaded catalog renders the history tag filters")
const ordered = [
  ...root.querySelectorAll<HTMLElement>(
    '[data-testid="history"] [data-slot="list-search-wrapper"], [data-testid="history"] [data-slot="session-tag-filters"], [data-testid="history"] [data-slot="list-scroll"]',
  ),
].map((el) => el.getAttribute("data-slot"))
assert.deepEqual(
  ordered,
  ["list-search-wrapper", "session-tag-filters", "list-scroll"],
  "the search field sits above the tag filters and the tag filters above the list",
)
assert.equal(filterRoot.getAttribute("aria-label"), "Tags", "the filter row reuses the tags label")
const filterButtons = [...filterRoot.querySelectorAll<HTMLButtonElement>("button.session-tag-filter")]
assert.equal(filterButtons.length, 5, "the filter row renders every tag assigned to a current session")
assert.equal(
  filterButtons.every((button) => button.tagName === "BUTTON"),
  true,
  "tag filters are actual buttons rather than passive chip elements",
)
assert.equal(filterButtons[0]?.getAttribute("aria-label"), "Urgent")
assert.equal(filterButtons[0]?.getAttribute("aria-pressed"), "false")
assert.equal(filterButtons[0]?.style.getPropertyValue("--session-tag-color"), "#e5534b")
assert.equal(
  root.querySelector('[data-testid="welcome"] [data-slot="session-tag-filters"]'),
  null,
  "tag filters do not enter the welcome screen",
)
assert.equal(
  root.querySelector('[data-testid="header"] [data-slot="session-tag-filters"]'),
  null,
  "tag filters do not enter the task header",
)
assert.equal(
  root.querySelector('[data-testid="tabs"] [data-slot="session-tag-filters"]'),
  null,
  "tag filters do not enter the tab strip",
)
const selectToggle = root.querySelector<HTMLButtonElement>('[data-testid="history"] .session-select-toggle')
assert(selectToggle, "history exposes the bulk-select toggle")
selectToggle.click()
await settle()
assert(
  root.querySelector('[data-testid="history"] [data-slot="session-tag-filters"]'),
  "tag filters remain visible in bulk-select mode",
)
const cancelSelect = root.querySelector<HTMLButtonElement>('[data-testid="history"] .session-select-bar button')
assert(cancelSelect, "bulk-select mode exposes its cancel action")
cancelSelect.click()
await settle()

filterTag("Urgent").click()
await settle()
assert.equal(filterTag("Urgent").getAttribute("aria-pressed"), "true")
assert.deepEqual(
  groupItems("history").flat(),
  ["ses-home", "ses-tagged"],
  "one selected tag keeps only sessions assigned to it",
)
filterTag("Review").click()
await settle()
assert.deepEqual(groupItems("history").flat(), ["ses-home", "ses-tagged"], "multiple selected tags use OR semantics")
filterTag("Urgent").click()
await settle()
assert.deepEqual(groupItems("history").flat(), ["ses-home"], "removing one tag keeps the other selected tag active")
filterTag("Review").click()
await settle()
assert.deepEqual(
  groupItems("history").flat(),
  ["ses-home", "ses-tagged", "ses-plain"],
  "removing every tag restores the complete session list",
)

const searchInput = filter("Check release notes")
await settle()
assert.deepEqual(groupItems("history").flat(), ["ses-plain"], "text search still finds the unfiltered session")
filterTag("Urgent").click()
await settle()
assert.deepEqual(groupItems("history").flat(), [], "tag filtering runs before the List text search")
assert.equal(
  root.querySelector('[data-testid="history"] [data-slot="list-message"]')?.textContent?.trim(),
  "No sessions match the selected tags.",
  "an active tag filter uses the dedicated empty result message",
)
filterTag("Urgent").click()
searchInput.value = ""
searchInput.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }))
searchInput.dispatchEvent(new Event("change", { bubbles: true }))
await settle()
assert.deepEqual(groupItems("history").flat(), ["ses-home", "ses-tagged", "ses-plain"])

filterTag("Urgent").click()
await settle()
response({ tags: initial.tags.filter((tag) => tag.id !== "tag-urgent"), sessions: initial.sessions })
await settle()
assert.equal(
  root.querySelector('[data-testid="history"] [data-slot="session-tag-filters"] button[aria-label="Urgent"]'),
  null,
  "deleting a catalog tag removes its filter chip",
)
assert.deepEqual(
  groupItems("history").flat(),
  ["ses-home", "ses-tagged", "ses-plain"],
  "deleting an active filter tag restores the list without breaking it",
)
response(initial)
await settle()
assert.equal(
  filterTag("Urgent").getAttribute("aria-pressed"),
  "false",
  "a recreated tag is not selected after deletion",
)

response({
  tags: [...initial.tags, { id: "tag-idle", name: "Idle", color: "Cyan" }],
  sessions: initial.sessions,
})
await settle()
const usedFilterRoot = root.querySelector<HTMLElement>('[data-testid="history"] [data-slot="session-tag-filters"]')
assert(usedFilterRoot, "tags assigned to current sessions keep the filter row visible")
assert.equal(
  usedFilterRoot.querySelectorAll("button.session-tag-filter").length,
  5,
  "an unused catalog tag does not increase the filter row",
)
assert.equal(
  usedFilterRoot.querySelector('button.session-tag-filter[aria-label="Idle"]'),
  null,
  "an unused catalog tag is absent from the filter row",
)

response({ tags: initial.tags, sessions: {} })
await settle()
assert.equal(
  root.querySelector('[data-testid="history"] [data-slot="session-tag-filters"]'),
  null,
  "a project without tags does not render the filter row",
)

response(initial)
await settle()
filterTag("Urgent").click()
await settle()
assert.deepEqual(
  groupItems("history").flat(),
  ["ses-home", "ses-tagged"],
  "the selected tag filters the current session list",
)
response({ tags: initial.tags, sessions: { "ses-home": ["tag-review"] } })
await settle()
assert.equal(
  root.querySelector('[data-testid="history"] [data-slot="session-tag-filters"] button[aria-label="Urgent"]'),
  null,
  "a tag with no remaining session assignment leaves the filter row",
)
assert.equal(filterTag("Review").getAttribute("aria-pressed"), "false", "the hidden tag selection is cleared")
assert.deepEqual(
  groupItems("history").flat(),
  ["ses-home", "ses-tagged", "ses-plain"],
  "removing the last assignment of a selected tag restores the session list",
)
response(initial)
await settle()

assert.deepEqual(
  tags.forSession("ses-home").map((tag) => tag.name),
  ["Urgent", "Review", "Follow-up", "Очень длинное русское название очереди"],
)
const initialFavorite = favoriteButton("ses-home")
assert.equal(initialFavorite.getAttribute("data-icon"), "star", "an unmarked session shows the empty star")
assert.equal(initialFavorite.getAttribute("aria-pressed"), "false", "an unmarked session is not pressed")
assert.equal(initialFavorite.getAttribute("data-slot"), "session-row-action", "the star uses the history action slot")

favoriteWritesFail = true
initialFavorite.click()
await settle()
const toastTitles = [...document.querySelectorAll<HTMLElement>('[data-component="toast"] [data-slot="toast-title"]')]
assert.equal(
  toastTitles.at(-1)?.textContent?.trim(),
  "Could not update favorites. Try again.",
  "a failed favorite write shows an error toast",
)
assert.deepEqual(favorites.state(), { sessions: [] }, "a failed favorite write keeps provider state unchanged")
assert.equal(favoriteButton("ses-home").getAttribute("data-icon"), "star", "a failed favorite write keeps the star")
favoriteWritesFail = false

const favoriteActions = () => sent.filter((message) => message.type === "sessionFavoriteAction").length
const actionsBefore = favoriteActions()
favoriteButton("ses-home").click()
favoriteButton("ses-home").click()
await settle()
assert.equal(
  favoriteActions() - actionsBefore,
  1,
  "a second click while the first favorite mutation is in flight is ignored",
)
assert.deepEqual(favorites.state(), { sessions: ["ses-home"] }, "the guarded click still applies the first toggle")
favoriteButton("ses-home").click()
await settle()
assert.deepEqual(favorites.state(), { sessions: [] }, "after the guard clears, the next click toggles the favorite off")

const welcome = root.querySelector<HTMLElement>('[data-testid="welcome"]')
assert(welcome)
const home = [...welcome.querySelectorAll<HTMLElement>(".recent-session-item")].find((row) =>
  row.textContent?.includes("Refactor authentication"),
)
assert(home, "welcome state renders the matching recent session")
const chips = home.querySelector<HTMLElement>('[data-slot="session-tags"]')
assert(chips, "home renders passive tag chips for a tagged session")
assert.equal(chips.querySelectorAll('[data-slot="session-tag"]').length, 2, "home renders no more than two tag chips")
assert.equal(chips.querySelector('[data-slot="session-tags-overflow"]')?.textContent, "+2")
assert.equal(
  chips.getAttribute("aria-label"),
  "Urgent, Review, Follow-up, Очень длинное русское название очереди",
  "the passive chip control exposes every full tag name",
)
assert.equal(home.querySelector("button"), null, "passive chips do not add a nested action to the session row")
chips.querySelector('[data-slot="session-tag"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
assert.equal(selected.at(-1), "ses-home", "clicking a passive chip retains the parent session action")
const plain = [...welcome.querySelectorAll<HTMLElement>(".recent-session-item")].find((row) =>
  row.textContent?.includes("Check release notes"),
)
assert(plain)
assert.equal(plain.querySelector('[data-slot="session-tags"]'), null, "an untagged session has no empty chip root")

const welcomeStripe = home.querySelector<HTMLElement>('[data-slot="session-color-stripe"]')
assert(welcomeStripe, "a colored session shows the color stripe on the welcome screen")
assert.equal(welcomeStripe.style.background, "#e5534b")
assert.equal(plain.querySelector('[data-slot="session-color-stripe"]'), null, "a session without a color has no stripe")

const historyStripe = item("ses-home")?.querySelector<HTMLElement>('[data-slot="session-color-stripe"]')
assert(historyStripe, "the local history row shows the session color stripe")
assert.equal(historyStripe.style.background, "#e5534b")
assert.equal(
  item("ses-plain")?.querySelector('[data-slot="session-color-stripe"]'),
  null,
  "a history row without a color has no stripe",
)

dispatch({ type: "sessionColorsLoaded", colors: { "ses-plain": "Blue" } })
await settle()
assert.equal(
  item("ses-home")?.querySelector('[data-slot="session-color-stripe"]'),
  null,
  "clearing a color removes its history stripe",
)
assert.equal(
  item("ses-plain")?.querySelector<HTMLElement>('[data-slot="session-color-stripe"]')?.style.background,
  "#4a9ef7",
  "the shared store updates history stripes reactively",
)

favoriteButton("ses-tagged").click()
await settle()
assert.deepEqual(favorites.state(), { sessions: ["ses-tagged"] })
assert.equal(favoriteButton("ses-tagged").getAttribute("data-icon"), "star-filled")
assert.equal(favoriteButton("ses-tagged").getAttribute("aria-pressed"), "true")
assert.equal(groupHeaders("history")[0], "Favorites", "the favorites group is rendered first")
assert.deepEqual(groupItems("history")[0], ["ses-tagged"], "favorites are not duplicated into a date group")
filterTag("Urgent").click()
await settle()
assert.equal(groupHeaders("history")[0], "Favorites", "favorites stay first after tag filtering")
assert.deepEqual(groupItems("history")[0], ["ses-tagged"], "the matching favorite remains in the favorites group")
assert.equal(item("ses-home") !== null, true, "the other session with the selected tag remains visible")
filterTag("Urgent").click()
filterTag("Review").click()
await settle()
assert.equal(item("ses-tagged"), null, "a favorite without the selected tag is filtered out before grouping")
assert.equal(groupHeaders("history").includes("Favorites"), false, "an empty favorites group is not rendered")
filterTag("Review").click()
await settle()
assert.equal(welcome.querySelector(".session-favorite-button"), null, "welcome sessions have no favorite action")
assert.equal(root.querySelector('[data-testid="header"] .session-favorite-button'), null)
assert.equal(root.querySelector('[data-testid="tabs"] .session-favorite-button'), null)

favoriteButton("ses-tagged").click()
await settle()
assert.deepEqual(favorites.state(), { sessions: [] })
assert.equal(favoriteButton("ses-tagged").getAttribute("data-icon"), "star")
assert.equal(favoriteButton("ses-tagged").getAttribute("aria-pressed"), "false")
assert.equal(groupHeaders("history")[0], "Today", "removing a favorite returns it to its date group")
assert.equal(groupItems("history")[0]?.includes("ses-tagged"), true)

function rowTrigger(id: string, scope: string) {
  const row = root.querySelector<HTMLElement>(`[data-testid="${scope}"] [data-slot="list-item"][data-key="${id}"]`)
  assert(row, `${scope} row ${id} is mounted`)
  const trigger = row.parentElement
  assert(trigger, `${scope} row ${id} exposes a context-menu trigger`)
  return trigger
}

function openRowMenu(id: string, scope: string) {
  const before = new Set(document.querySelectorAll<HTMLElement>(".session-list-menu"))
  rowTrigger(id, scope).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }))
  return () =>
    [...document.querySelectorAll<HTMLElement>(".session-list-menu")].find((menu) => !before.has(menu)) ??
    document.querySelector<HTMLElement>('.session-list-menu[data-expanded="true"]')
}

function purpleSwatch(menu: HTMLElement) {
  return [...menu.querySelectorAll<HTMLElement>(".am-color-grid-item")].find(
    (entry) => entry.querySelector<HTMLElement>(".am-color-swatch")?.style.background === "#b180d7",
  )
}

const findHistoryMenu = openRowMenu("ses-plain", "history")
await settle()
const historyMenu = findHistoryMenu()
assert(historyMenu, "the history row menu opens")
assert.equal(
  historyMenu.querySelectorAll(".am-color-grid-item").length,
  SECTION_COLORS.length + 1,
  "the menu exposes the full palette plus the clear entry",
)
const addFavorite = [...historyMenu.querySelectorAll<HTMLElement>('[data-slot="context-menu-item"]')].find(
  (item) => item.textContent?.trim() === "Add to favorites",
)
assert(addFavorite, "an unmarked session offers Add to favorites")
addFavorite.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }))
await settle()
assert.deepEqual(favorites.state(), { sessions: ["ses-plain"] })

const findRemoveMenu = openRowMenu("ses-plain", "history")
await settle()
const removeMenu = findRemoveMenu()
assert(removeMenu, "the history menu remains available for a marked session")
const removeFavorite = [...removeMenu.querySelectorAll<HTMLElement>('[data-slot="context-menu-item"]')].find(
  (item) => item.textContent?.trim() === "Remove from favorites",
)
assert(removeFavorite, "a marked session offers Remove from favorites")
removeFavorite.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }))
await settle()
assert.deepEqual(favorites.state(), { sessions: [] })
const findColorMenu = openRowMenu("ses-plain", "history")
await settle()
const colorMenu = findColorMenu()
assert(colorMenu, "the history menu remains available for colors")
assert(purpleSwatch(colorMenu), "the menu offers the shared color palette")
purpleSwatch(colorMenu)!.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }))
await settle()
const colorWrites = sent.filter((message) => message.type === "setSessionColor")
assert.deepEqual(colorWrites.at(-1), { type: "setSessionColor", sessionId: "ses-plain", color: "Purple" })
assert.equal(colorWrites.length, 1, "the menu assignment writes a single color message")
assert.equal(
  item("ses-plain")?.querySelector<HTMLElement>('[data-slot="session-color-stripe"]')?.style.background,
  "#b180d7",
  "the sidebar menu assignment updates the history stripe",
)

const amRow = (id: string) =>
  root.querySelector<HTMLElement>(`[data-testid="am-history"] [data-slot="list-item"][data-key="${id}"]`)
assert.equal(
  amRow("ses-home")?.querySelector<HTMLElement>('[data-slot="session-color-stripe"]')?.style.background,
  "#b180d7",
  "a host-provided color source shows stripes without local tabs",
)
assert.equal(
  amRow("ses-tagged")?.querySelector('[data-slot="session-color-stripe"]'),
  null,
  "a session outside the host color map has no stripe",
)
assert.equal(
  amRow("ses-plain")?.querySelector<HTMLElement>('[data-slot="session-color-stripe"]')?.style.background,
  "#4a9ef7",
  "the host color map drives its own rows",
)

const findAmMenu = openRowMenu("ses-tagged", "am-history")
await settle()
const amMenu = findAmMenu()
assert(amMenu, "the host-backed row menu opens")
assert(purpleSwatch(amMenu), "the host-backed row menu offers the palette")
purpleSwatch(amMenu)!.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, button: 0 }))
await settle()
assert.deepEqual(amSets.at(-1), { id: "ses-tagged", color: "Purple" })
assert.equal(
  amRow("ses-tagged")?.querySelector<HTMLElement>('[data-slot="session-color-stripe"]')?.style.background,
  "#b180d7",
  "the host-backed menu assignment updates the stripe",
)

const tabs = root.querySelector<HTMLElement>('[data-testid="tabs"] [data-component="session-tabs"]')
assert(tabs, "the real local session tab strip is mounted")
assert.equal(tabs.querySelector('[data-slot="session-tags"]'), null, "session tags never enter the tab strip")
assert.equal(tabs.textContent?.includes("Urgent"), false)
assert.equal(tabs.textContent?.includes("Очень длинное русское название очереди"), false)

const title = root.querySelector<HTMLElement>('[data-testid="header"] [data-slot="task-header-title-trigger"]')
assert(title, "the real task header title is mounted")
assert.equal(title.textContent, "Refactor authentication")
assert.equal(title.querySelector('[data-slot="session-tags"]'), null, "tag controls stay outside the rename trigger")
const header = root.querySelector<HTMLElement>('[data-testid="header"]')
assert(header?.querySelector('[data-slot="session-tags"]'))
const action = header?.querySelector<HTMLButtonElement>('button[aria-label="Manage tags"]')
assert(action)
assert.equal(title.contains(action), false, "the tag action stays outside the rename trigger")
const readonly = root.querySelector<HTMLElement>('[data-testid="readonly-header"]')
assert(readonly?.querySelector('[data-slot="session-tags"]'), "readonly local sessions retain passive chips")
assert.equal(readonly?.querySelector('button[aria-label="Manage tags"]'), null)
assert.equal(root.querySelector('[data-testid="cloud-header"] [data-slot="session-tags"]'), null)
assert.equal(root.querySelector('[data-testid="cloud-header"] button[aria-label="Manage tags"]'), null)
assert.equal(root.querySelector('[data-testid="draft-header"] [data-slot="session-tags"]'), null)
assert.equal(root.querySelector('[data-testid="draft-header"] button[aria-label="Manage tags"]'), null)

const history = root.querySelector<HTMLElement>('[data-testid="history"]')
assert(history)
const query = filter("On call")
await settle()
assert(item("ses-tagged"), "tag-only search finds a session whose title does not match")
assert.equal(item("ses-home"), null, "tag-only search does not match an unrelated title or assignment")
const match = item("ses-tagged")
assert(match)
assert.equal(match.querySelector('[data-slot="list-item-title"]')?.textContent, "Polish documentation")
match.click()
assert.equal(selected.at(-1), "ses-tagged", "search selects the original session ID")

const ops: SessionTagsState = {
  tags: initial.tags.map((tag) => (tag.id === "tag-ops" ? { ...tag, name: "Queue only" } : tag)),
  sessions: initial.sessions,
}
response(ops)
await settle()
assert.equal(query.value, "On call", "a catalog rename does not clear the query")
assert.equal(item("ses-tagged"), null, "renaming a tag removes the old name from search results")
filter("Queue only")
await settle()
assert(item("ses-tagged"), "the renamed tag becomes searchable without changing the session title")
response({
  tags: ops.tags.filter((tag) => tag.id !== "tag-ops"),
  sessions: { ...ops.sessions, "ses-tagged": ["tag-urgent"] },
})
await settle()
assert.equal(query.value, "Queue only")
assert.equal(item("ses-tagged"), null, "deleting a tag removes its session from tag-only results")

filter("")
await settle()
const count = selected.length
const before = item("ses-plain")?.querySelector('[data-slot="list-item-title"]')?.textContent
manage("ses-plain").click()
await settle()
assert.equal(selected.length, count, "opening tag management does not select the session")
assert.deepEqual(renamed, [], "opening tag management does not rename the session")
assert.equal(item("ses-plain")?.querySelector('[data-slot="list-item-title"]')?.textContent, before)
const editor = dialog()
assert.equal(editor.querySelector('[data-slot="dialog-title"]')?.textContent, "Tags")
assert(
  editor.textContent?.includes("Очень длинное русское название очереди"),
  "the editor shows the complete Cyrillic tag name",
)
const search = editor.querySelector<HTMLInputElement>('input[placeholder="Search tags..."]')
assert(search, "the editor exposes a tag search field")
const names = () =>
  [...editor.querySelectorAll<HTMLElement>('[data-slot="session-tags-editor-name"]')].map((item) =>
    item.textContent?.trim(),
  )
search.value = "rEV"
search.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "rEV" }))
search.dispatchEvent(new Event("change", { bubbles: true }))
await settle()
assert.deepEqual(names(), ["Review"], "tag search matches names without regard to case")
search.value = "no matching tag"
search.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "no matching tag" }))
search.dispatchEvent(new Event("change", { bubbles: true }))
await settle()
assert.deepEqual(names(), [], "a non-matching query hides every tag")
assert.equal(
  editor.querySelector('[data-slot="session-tags-no-results"]')?.textContent?.trim(),
  "No tags match your search.",
  "the editor explains when the query has no matches",
)
search.value = ""
search.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }))
search.dispatchEvent(new Event("change", { bubbles: true }))
await settle()
assert.deepEqual(names(), ["Urgent", "Review", "Follow-up", "Очень длинное русское название очереди"])
assert.equal(
  editor.querySelector('[data-slot="session-tags-editor-form"]'),
  null,
  "the editor opens with the create and edit form collapsed",
)
const openCreate = [...editor.querySelectorAll<HTMLButtonElement>("button")].find(
  (button) => button.textContent?.trim() === "New tag",
)
assert(openCreate, "the collapsed editor exposes a create action")

setActive("ses-tagged")
const urgent = checkbox(editor, "Urgent")
urgent.label.click()
const assign = sent.filter((message) => message.type === "sessionTagAction").at(-1)
assert(assign?.type === "sessionTagAction")
assert.deepEqual(assign.action, { type: "assign", sessionID: "ses-plain", id: "tag-urgent", assigned: true })
assert.equal(urgent.input.checked, false)
dispatch({ type: "sessionTagResult", requestID: assign.requestID, ok: false, error: "storage" })
await settle()
assert.deepEqual(tags.forSession("ses-plain"), [], "a failed assignment leaves committed tags unchanged")
assert.equal(checkbox(editor, "Urgent").input.checked, false)

const cancelled = sent.length
openCreate.click()
await settle()
assert(editor.querySelector('[data-slot="session-tags-editor-form"]'), "the create action reveals the inline form")
assert.equal(
  [...editor.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "New tag"),
  undefined,
  "the create action is replaced by the inline form",
)
const cancel = [...editor.querySelectorAll<HTMLButtonElement>("button")].find(
  (button) => button.textContent?.trim() === "Cancel",
)
assert(cancel, "the open form exposes a cancel action")
cancel.click()
await settle()
assert.equal(editor.querySelector('[data-slot="session-tags-editor-form"]'), null, "cancel collapses the form")
assert.equal(sent.length, cancelled, "cancelling the form sends no tag action")
const reopen = [...editor.querySelectorAll<HTMLButtonElement>("button")].find(
  (button) => button.textContent?.trim() === "New tag",
)
assert(reopen, "cancelling restores the create action")
reopen.click()
await settle()

const buttons = editor.querySelectorAll<HTMLButtonElement>(
  '[data-slot="session-tags-color-picker"] .session-tags-color',
)
assert(buttons.length === SECTION_COLORS.length, "the create form exposes every palette color")
for (const color of SECTION_COLORS) {
  const label = t(`session.tags.color.${color.label}`)
  assert(
    [...buttons].some((button) => button.getAttribute("aria-label") === label),
    `the create form exposes the translated ${color.label} color`,
  )
}
assert(
  [...buttons].every((button) => !button.getAttribute("aria-label")?.startsWith("session.tags.color.")),
  "the create form does not leak raw color translation keys",
)
const teal = [...buttons].find((button) => button.getAttribute("aria-label") === t("session.tags.color.Teal"))
assert(teal, "the create form exposes the Teal color")
teal.click()

const name = field(editor)
name.value = "Temporary label"
name.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "Temporary label" }))
name.dispatchEvent(new Event("change", { bubbles: true }))
const add = [...editor.querySelectorAll<HTMLButtonElement>("button")].find(
  (button) => button.textContent?.trim() === "Add",
)
assert(add, "the tag editor has an explicit create action")
add.click()
const failed = sent.filter((message) => message.type === "sessionTagAction").at(-1)
assert(failed?.type === "sessionTagAction")
assert.deepEqual(failed.action, {
  type: "create",
  sessionID: "ses-plain",
  name: "Temporary label",
  color: "Teal",
})
dispatch({ type: "sessionTagResult", requestID: failed.requestID, ok: false, error: "storage" })
await settle()
assert.equal(name.value, "Temporary label", "a failed write preserves the editor field")
assert.equal(
  tags.state().tags.some((tag) => tag.name === "Temporary label"),
  false,
)
assert.deepEqual(tags.forSession("ses-plain"), [], "a failed create does not optimistically commit an assignment")

const retry = [...editor.querySelectorAll<HTMLButtonElement>("button")].find(
  (button) => button.textContent?.trim() === "Add",
)
assert(retry)
retry.click()
const created = sent.filter((message) => message.type === "sessionTagAction").at(-1)
assert(created?.type === "sessionTagAction")
assert.equal(created.action.type, "create")
const committed: SessionTagsState = {
  tags: [
    ...ops.tags.filter((tag) => tag.id !== "tag-ops"),
    { id: "tag-created", name: "Temporary label", color: "Blue" },
  ],
  sessions: { ...ops.sessions, "ses-tagged": ["tag-urgent"], "ses-plain": ["tag-created"] },
}
response(committed)
await settle()
assert.deepEqual(
  tags.forSession("ses-plain").map((tag) => tag.name),
  ["Temporary label"],
)
dispatch({ type: "sessionTagResult", requestID: created.requestID, ok: true })
await settle()
assert.equal(
  editor.querySelector('[data-slot="session-tags-editor-form"]'),
  null,
  "a completed create collapses the form",
)
const current = dialog()
dispatch({ type: "sessionDeleted", sessionID: "ses-home" })
assert.equal(current.isConnected, true, "deleting a different session does not close the captured editor")
dispatch({ type: "sessionDeleted", sessionID: "ses-plain" })
await settle()
assert.equal(current.hasAttribute("data-closed"), true, "deleting the edited session starts closing its dialog")
manage("ses-home").click()
await settle()
const editorHome = dialog()
dispatch({ type: "sessionDeleted", sessionID: "ses-plain" })
assert.equal(editorHome.isConnected, true, "closing a dialog removes its session-deletion listener")
setActive("ses-home")
const prev = tags.state()
const edit = editorHome.querySelector<HTMLButtonElement>('button[aria-label="Edit: Urgent"]')
assert(edit, "the catalog exposes a per-tag edit action")
edit.click()
assert(
  editorHome.querySelector('[data-slot="session-tags-editor-form"]'),
  "editing a catalog tag opens the inline form",
)
const editName = field(editorHome)
editName.value = "Priority"
editName.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "Priority" }))
editName.dispatchEvent(new Event("change", { bubbles: true }))
const save = [...editorHome.querySelectorAll<HTMLButtonElement>("button")].find(
  (button) => button.textContent?.trim() === "Save",
)
assert(save, "editing an existing tag exposes a save action")
save.click()
const update = sent.filter((message) => message.type === "sessionTagAction").at(-1)
assert(update?.type === "sessionTagAction")
assert.deepEqual(update.action, { type: "update", id: "tag-urgent", patch: { name: "Priority" } })
assert.equal(
  tags.state().tags.find((tag) => tag.id === "tag-urgent")?.name,
  "Urgent",
  "the editor does not optimistically rename tags",
)
await settle()
const updated: SessionTagsState = {
  ...prev,
  tags: prev.tags.map((tag) => (tag.id === "tag-urgent" ? { ...tag, name: "Priority" } : tag)),
}
response(updated)
await settle()
assert.equal(
  tags.state().tags.find((tag) => tag.id === "tag-urgent")?.name,
  "Priority",
  "all consumers observe the host snapshot",
)
assert(
  tags.forSession("ses-tagged").some((tag) => tag.name === "Priority"),
  "a global rename reaches every assigned session",
)
assert.equal(save.disabled, true, "the editor remains busy until the matching result arrives")
assert(
  [...welcome.querySelectorAll<HTMLElement>(".recent-session-item")]
    .find((row) => row.textContent?.includes("Refactor authentication"))
    ?.querySelector('[data-slot="session-tags"]')
    ?.textContent?.includes("Priority"),
  "home chips update from the same confirmed snapshot",
)
assert(
  root.querySelector('[data-testid="header"] [data-slot="session-tags"]')?.textContent?.includes("Priority"),
  "the task header observes the same confirmed snapshot",
)
assert(
  item("ses-tagged")?.querySelector('[data-slot="session-tags"]')?.textContent?.includes("Priority"),
  "history rows observe the shared tag rename",
)
dispatch({ type: "sessionTagResult", requestID: update.requestID, ok: true })
await settle()

const editAgain = editorHome.querySelector<HTMLButtonElement>('button[aria-label="Edit: Priority"]')
assert(editAgain)
editAgain.click()
const noopSize = sent.filter((message) => message.type === "sessionTagAction").length
const noopSave = [...editorHome.querySelectorAll<HTMLButtonElement>("button")].find(
  (button) => button.textContent?.trim() === "Save",
)
assert(noopSave, "editing a tag exposes a save action")
noopSave.click()
await settle()
assert.equal(
  editorHome.querySelector('[data-slot="session-tags-editor-form"]'),
  null,
  "saving an unchanged tag collapses the form",
)
assert.equal(
  sent.filter((message) => message.type === "sessionTagAction").length,
  noopSize,
  "saving an unchanged tag sends no tag action",
)
editAgain.click()
const size = sent.filter((message) => message.type === "sessionTagAction").length
const del = [...editorHome.querySelectorAll<HTMLButtonElement>("button")].find(
  (button) => button.textContent?.trim() === "Delete from all sessions",
)
assert(del, "the editor exposes global deletion")
del.click()
assert.equal(sent.filter((message) => message.type === "sessionTagAction").length, size)
assert(editorHome.querySelector('[data-slot="session-tags-delete-confirm"]'), "global deletion asks for confirmation")
const confirm = [...editorHome.querySelectorAll<HTMLButtonElement>("button")].find(
  (button) => button.textContent?.trim() === "Delete tag",
)
assert(confirm)
confirm.click()
const remove = sent.filter((message) => message.type === "sessionTagAction").at(-1)
assert(remove?.type === "sessionTagAction")
assert.deepEqual(remove.action, { type: "delete", id: "tag-urgent" })
assert.equal(
  tags.state().tags.some((tag) => tag.id === "tag-urgent"),
  true,
  "deletion waits for the host snapshot",
)
const deleted: SessionTagsState = {
  tags: updated.tags.filter((tag) => tag.id !== "tag-urgent"),
  sessions: {
    ...updated.sessions,
    "ses-home": ["tag-review", "tag-follow-up", "tag-russian"],
    "ses-tagged": [],
  },
}
response(deleted)
await settle()
assert.equal(
  tags.state().tags.some((tag) => tag.id === "tag-urgent"),
  false,
)
assert.deepEqual(tags.forSession("ses-tagged"), [], "global deletion removes the tag from every session")
dispatch({ type: "sessionTagResult", requestID: remove.requestID, ok: true })
await settle()
dispatch({ type: "sessionDeleted", sessionID: "ses-home" })
await settle()
assert.equal(editorHome.hasAttribute("data-closed"), true, "deleting the edited session starts closing its dialog")

const snapshot = tags.state()
const pending = tags.mutate({ type: "assign", sessionID: "ses-home", id: "tag-review", assigned: false })
assert(sent.at(-1)?.type === "sessionTagAction")
let settled = false
let result: Awaited<typeof pending> | undefined
void pending.then((value) => {
  settled = true
  result = value
})
dispose()
await settle()
assert.equal(settled, true, "disposing the provider settles pending mutations")
assert.deepEqual(result, { ok: false }, "disposing the provider resolves pending mutations as rejected")
dispatch({ type: "sessionTagsLoaded", state: empty })
assert.deepEqual(tags.state(), snapshot, "disposed providers ignore later snapshots")
assert.equal(root.childNodes.length, 0, "disposing the tree removes the real UI")

const state = writes
  .map((value) => JSON.stringify(value) ?? "")
  .join("\n")
  .toLowerCase()
assert.equal(state.includes("tag-urgent"), false, "tag snapshots are not mirrored into VS Code browser state")
const storage = Array.from({ length: window.localStorage.length }, (_, index) => {
  const key = window.localStorage.key(index) ?? ""
  return `${key}:${window.localStorage.getItem(key) ?? ""}`
})
  .join("\n")
  .toLowerCase()
assert.equal(storage.includes("tag-urgent"), false, "tag snapshots are not mirrored into localStorage")
