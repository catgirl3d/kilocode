/** @jsxImportSource solid-js */
/**
 * Stories for the SessionList component (history panel).
 */

import type { Meta, StoryObj } from "storybook-solidjs-vite"
import { createSignal, onCleanup, onMount, type ParentComponent } from "solid-js"
import { DialogProvider } from "@kilocode/kilo-ui/context/dialog"
import { DataProvider } from "@kilocode/kilo-ui/context/data"
import { DiffComponentProvider } from "@kilocode/kilo-ui/context/diff"
import { CodeComponentProvider } from "@kilocode/kilo-ui/context/code"
import { FileComponentProvider } from "@kilocode/kilo-ui/context/file"
import { MarkedProvider } from "@kilocode/kilo-ui/context/marked"
import { I18nProvider, pluralCategory, pluralKey } from "@kilocode/kilo-ui/context"
import type { UiI18nPluralKey } from "@kilocode/kilo-ui/context"
import { Diff } from "@kilocode/kilo-ui/diff"
import { Code } from "@kilocode/kilo-ui/code"
import { File } from "@kilocode/kilo-ui/file"
import { VSCodeProvider } from "../context/vscode"
import { ServerProvider } from "../context/server"
import { ConfigProvider } from "../context/config"
import { ProviderProvider } from "../context/provider"
import { SessionTagsProvider } from "../context/session-tags"
import { SessionContext } from "../context/session"
import { LanguageContext } from "../context/language"
import { StorySessionTags } from "./StoryProviders"
import type { SessionTagsState } from "../types/messages"
import { dict as uiEn } from "@kilocode/kilo-ui/i18n/en"
import { dict as appEn } from "../i18n/en"
import { dict as kiloEn } from "@kilocode/kilo-i18n/en"
import { resolveTemplate } from "../context/language-utils"
import SessionList from "../components/history/SessionList"
import HistoryView from "../components/history/HistoryView"

const dict: Record<string, string> = { ...appEn, ...uiEn, ...kiloEn }
function t(key: string, params?: Record<string, string | number | boolean | undefined>) {
  return resolveTemplate(dict[key] ?? key, params)
}
const plural = (key: UiI18nPluralKey, count: number, params?: Record<string, string | number | boolean>) =>
  t(pluralKey(key, pluralCategory("en", count)), { ...params, count })
function noop() {}

const now = new Date().toISOString()
const yesterday = new Date(Date.now() - 86400000).toISOString()
const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString()

const mockSessions = [
  { id: "s1", title: "Refactor authentication module", createdAt: now, updatedAt: now },
  { id: "s2", title: "Add screenshot test coverage", createdAt: yesterday, updatedAt: yesterday },
  { id: "s3", title: "Fix TypeScript errors in webview", createdAt: weekAgo, updatedAt: weekAgo },
  { id: "s4", title: undefined, createdAt: weekAgo, updatedAt: weekAgo },
]

const empty: SessionTagsState = { tags: [], sessions: {} }
const two: SessionTagsState = {
  tags: [
    { id: "tag-priority", name: "Priority", color: "Red" },
    { id: "tag-review", name: "Needs review", color: "Blue" },
  ],
  sessions: { s1: ["tag-priority", "tag-review"] },
}
const overflow: SessionTagsState = {
  tags: [
    { id: "tag-priority", name: "Priority", color: "Red" },
    { id: "tag-review", name: "Needs review", color: "Blue" },
    { id: "tag-release", name: "Release candidate", color: "Green" },
    { id: "tag-russian", name: "Очень длинное русское название очереди", color: "Purple" },
  ],
  sessions: { s1: ["tag-priority", "tag-review", "tag-release", "tag-russian"] },
}

const WithSessions: ParentComponent<{
  sessions?: typeof mockSessions
  sessionTags?: SessionTagsState
  failTags?: boolean
}> = (props) => {
  const [locale] = createSignal<"en">("en")
  const sessions = props.sessions ?? []
  const session = {
    currentSessionID: () => "s1",
    currentSession: () => sessions[0],
    setCurrentSessionID: noop,
    sessions: () => sessions as any,
    status: () => "idle" as const,
    statusInfo: () => ({ type: "idle" }),
    statusText: () => undefined,
    busyTiming: () => undefined,
    loading: () => false,
    messages: () => [],
    userMessages: () => [],
    allMessages: () => ({}),
    allParts: () => ({}),
    allStatusMap: () => ({}),
    getParts: () => [],
    todos: () => [],
    permissions: () => [],
    questions: () => [],
    questionErrors: () => new Set<string>(),
    scopedPermissions: () => [] as any[],
    scopedQuestions: () => [] as any[],
    selected: () => ({ providerID: "kilo", modelID: "anthropic/claude-sonnet-4-6" }),
    selectModel: noop,
    costBreakdown: () => [],
    contextUsage: () => undefined,
    agents: () => [{ name: "code", description: "Code mode", mode: "primary" as const }],
    selectedAgent: () => "code",
    selectAgent: noop,
    getSessionAgent: () => "code",
    setSessionModel: noop,
    setSessionAgent: noop,
    setSessionVariant: noop,
    variantList: () => [],
    currentVariant: () => undefined,
    selectVariant: noop,
    sendMessage: () => true,
    abort: noop,
    compact: noop,
    shake: noop,
    shaking: () => false,
    respondToPermission: noop,
    replyToQuestion: noop,
    rejectQuestion: noop,
    createSession: noop,
    clearCurrentSession: noop,
    loadSessions: noop,
    loadMoreSessions: noop,
    sessionsHasMore: () => false,
    sessionsLoadingMore: () => false,
    selectSession: noop,
    deleteSession: noop,
    renameSession: noop,
    syncSession: noop,
    cloudPreviewId: () => null,
    selectCloudSession: noop,
  }

  return (
    <VSCodeProvider>
      <ServerProvider>
        <ConfigProvider>
          <ProviderProvider>
            <DialogProvider>
              <LanguageContext.Provider value={{ locale, setLocale: noop, userOverride: () => "" as any, t }}>
                <SessionTagsProvider>
                  <StorySessionTags state={props.sessionTags ?? empty} fail={props.failTags ?? true} />
                  <I18nProvider value={{ locale: () => "en", t, plural }}>
                    <SessionContext.Provider value={session as any}>
                      <DataProvider
                        data={{
                          session: sessions as any,
                          session_status: {},
                          session_diff: {},
                          message: {},
                          part: {},
                          provider: {
                            all: new Map(),
                            connected: [] as string[],
                            default: {} as any,
                          },
                        }}
                        directory="/project/"
                      >
                        <DiffComponentProvider component={Diff}>
                          <CodeComponentProvider component={Code}>
                            <FileComponentProvider component={File}>
                              <MarkedProvider>
                                <div style={{ padding: "12px" }}>{props.children}</div>
                              </MarkedProvider>
                            </FileComponentProvider>
                          </CodeComponentProvider>
                        </DiffComponentProvider>
                      </DataProvider>
                    </SessionContext.Provider>
                  </I18nProvider>
                </SessionTagsProvider>
              </LanguageContext.Provider>
            </DialogProvider>
          </ProviderProvider>
        </ConfigProvider>
      </ServerProvider>
    </VSCodeProvider>
  )
}

const meta: Meta = {
  title: "History/SessionList",
  parameters: { layout: "fullscreen" },
}
export default meta
type Story = StoryObj

const SessionListDemo = (props: { state: SessionTagsState; fail?: boolean }) => {
  const [selected, setSelected] = createSignal("")

  return (
    <WithSessions sessions={mockSessions as any} sessionTags={props.state} failTags={props.fail}>
      <div style={{ height: "500px" }}>
        <SessionList onSelectSession={setSelected} />
        <output class="sr-only" data-slot="selected-session">
          {selected()}
        </output>
      </div>
    </WithSessions>
  )
}

export const WithItems: Story = {
  name: "With sessions",
  render: () => <SessionListDemo state={empty} fail />,
}

// Enters select mode and chooses two sessions so the visual baseline captures the
// checkbox toolbar state. The observer applies the state in the same task that
// inserts the rows, so the screenshot cannot catch a half-applied story; failures
// throw instead of silently screenshotting the default list.
const SelectionModeDemo = () => {
  let host: HTMLDivElement | undefined
  const [selected, setSelected] = createSignal("")

  onMount(() => {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let observer: MutationObserver | undefined

    const apply = () => {
      if (done || !host) return
      if (!host.querySelector(".session-select-bar")) {
        const toggle = host.querySelector<HTMLButtonElement>(".session-select-toggle")
        if (!toggle) return
        toggle.click()
      }
      const boxes = [...host.querySelectorAll<HTMLElement>(".session-select-check")]
      if (boxes.length < 2) return
      for (const box of boxes.slice(0, 2)) {
        box.querySelector<HTMLElement>('[data-slot="checkbox-checkbox-label"]')?.click()
      }
      const action = host.querySelector<HTMLButtonElement>(".session-select-bar button:last-child")
      if (!action || action.disabled) {
        throw new Error("[Kilo New] selection story: the chosen sessions were not applied")
      }
      done = true
      observer?.disconnect()
      clearTimeout(timer)
    }

    observer = new MutationObserver(apply)
    observer.observe(host!, { childList: true, subtree: true })
    timer = setTimeout(() => {
      if (!done) throw new Error("[Kilo New] selection story: the selection state never applied")
    }, 5_000)
    apply()
    onCleanup(() => {
      observer?.disconnect()
      clearTimeout(timer)
    })
  })

  return (
    <WithSessions sessions={mockSessions as any} sessionTags={empty}>
      <div style={{ height: "500px" }} ref={(el) => (host = el)}>
        <SessionList onSelectSession={setSelected} />
        <output class="sr-only" data-slot="selected-session">
          {selected()}
        </output>
      </div>
    </WithSessions>
  )
}

export const SelectionMode: Story = {
  name: "Selection mode — two sessions chosen",
  render: () => <SelectionModeDemo />,
}

export const SessionTagsTwo: Story = {
  name: "Session tags — two tags",
  render: () => <SessionListDemo state={two} fail />,
}

export const SessionTagsOverflowCyrillic: Story = {
  name: "Session tags — overflow and long Cyrillic name",
  render: () => <SessionListDemo state={overflow} fail />,
}

export const SessionTagsEmptyWriteFailure: Story = {
  name: "Session tags — empty catalog and failed save",
  render: () => <SessionListDemo state={empty} fail />,
}

export const Sources: Story = {
  name: "Local and cloud sources",
  render: () => (
    <WithSessions sessions={mockSessions as any}>
      <div style={{ height: "500px" }}>
        <HistoryView onSelectSession={noop} onBack={noop} />
      </div>
    </WithSessions>
  ),
}

const WorktreeSourcesDemo = () => {
  const [selected, setSelected] = createSignal("")
  const ids = new Set(["s1", "s3"])

  return (
    <WithSessions sessions={mockSessions as any}>
      <div style={{ height: "500px" }}>
        <HistoryView onSelectSession={setSelected} onBack={noop} worktreeSessionIds={() => ids} />
        <output class="sr-only" data-slot="selected-session">
          {selected()}
        </output>
      </div>
    </WithSessions>
  )
}

export const WorktreeSources: Story = {
  name: "Current worktree source",
  render: () => <WorktreeSourcesDemo />,
}
