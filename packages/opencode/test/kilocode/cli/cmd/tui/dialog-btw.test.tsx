/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { EventSessionBtwUpdated, GlobalEvent } from "@kilocode/sdk/v2"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { onCleanup, onMount, type JSX, type ParentProps } from "solid-js"
import { take } from "@/kilocode/cli/cmd/tui/btw-command"
import { BtwPrompt } from "@/kilocode/cli/cmd/tui/component/btw-prompt"
import { DialogBtw } from "@/kilocode/cli/cmd/tui/component/dialog-btw"
import { resolve, TuiConfigProvider } from "@tui/config"
import { KVProvider } from "@tui/context/kv"
import { ProjectProvider, useProject } from "@tui/context/project"
import { SDKProvider, useSDK, type EventSource } from "@tui/context/sdk"
import { ThemeProvider } from "@tui/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "@tui/keymap"
import { DialogProvider, useDialog, type DialogContext } from "@tui/ui/dialog"
import { Toast, ToastProvider, useToast } from "@tui/ui/toast"
import { tmpdir } from "../../../../fixture/fixture"
import { TestTuiContexts } from "../../../../fixture/tui-environment"
import { createEventSource, directory, json, worktree } from "../../../../fixture/tui-sdk"

type Item = EventSessionBtwUpdated["properties"]["item"]
type App = Awaited<ReturnType<typeof testRender>>

function sideItem(input: {
  id: string
  question: string
  answer?: string
  threadID?: string
  sessionID?: string
  status?: Item["status"]
  error?: string
  created?: number
}): Item {
  return {
    id: input.id,
    sessionID: input.sessionID ?? "ses_btw_dialog",
    threadID: input.threadID ?? input.id,
    status: input.status ?? "done",
    question: input.question,
    answer: input.answer ?? "",
    ...(input.error ? { error: input.error } : {}),
    providerID: "test",
    modelID: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: input.created ?? 1, ...(input.status === "done" ? { completed: 2 } : {}) },
  }
}

function btwEvent(status: string, item: Item, seq: number): GlobalEvent {
  return {
    directory,
    project: "proj_test",
    payload: {
      id: `evt_btw_${status}_${seq}`,
      type: "session.btw.updated",
      properties: { sessionID: item.sessionID, item },
    },
  }
}

type Call = {
  method: string
  path: string
  body?: unknown
  directory?: string
  workspace?: string
}

const boot: Record<string, unknown> = {
  "/path": { home: "", state: "", config: "", worktree, directory },
  "/project/current": { id: "proj_test", worktree: "/tmp/project-root" },
  "/project/proj_test/directories": [],
}

function transportOf(handler: (call: Call) => Response | undefined) {
  const calls: Call[] = []
  const fetch = (async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(String(input))
    const url = new URL(request.url)
    const hit = boot[url.pathname]
    if (request.method === "GET" && hit !== undefined) return json(hit)
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request
            .clone()
            .json()
            .catch(() => undefined)
    const header = request.headers.get("x-kilo-directory")
    const call = {
      method: request.method,
      path: url.pathname,
      body,
      directory: url.searchParams.get("directory") ?? (header ? decodeURIComponent(header) : undefined),
      workspace: url.searchParams.get("workspace") ?? request.headers.get("x-kilo-workspace") ?? undefined,
    }
    calls.push(call)
    const response = handler(call)
    if (!response) throw new Error(`unexpected request: ${request.method} ${url.pathname}`)
    return response
  }) as typeof globalThis.fetch
  return { fetch, calls }
}

function tracked() {
  const base = createEventSource()
  const ready = Promise.withResolvers<void>()
  const source: EventSource = {
    subscribe: async (handler) => {
      const off = await base.source.subscribe(handler)
      ready.resolve()
      return off
    },
  }
  return { source, emit: base.emit, ready: ready.promise }
}

function Providers(
  props: ParentProps<{
    root: string
    fetch: typeof globalThis.fetch
    events: EventSource
  }>,
) {
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const config = resolve({}, { terminalSuspend: false })
  onCleanup(registerOpencodeKeymap(keymap, renderer, config))
  return (
    <TestTuiContexts paths={{ state: props.root }}>
      <OpencodeKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={config}>
          <KVProvider>
            <SDKProvider url="http://test" directory={directory} fetch={props.fetch} events={props.events}>
              <ProjectProvider>
                <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}>
                  <ToastProvider>
                    <DialogProvider>
                      {props.children}
                      <Toast />
                    </DialogProvider>
                  </ToastProvider>
                </ThemeProvider>
              </ProjectProvider>
            </SDKProvider>
          </KVProvider>
        </TuiConfigProvider>
      </OpencodeKeymapProvider>
    </TestTuiContexts>
  )
}

function Probe(props: { capture: (project: ReturnType<typeof useProject>) => void }) {
  const project = useProject()
  props.capture(project)
  // The app loads the project from its sync bootstrap, which the test does not mount.
  onMount(() => void project.sync())
  return null
}

async function render(
  root: string,
  transport: ReturnType<typeof transportOf>,
  source: EventSource,
  scene: () => JSX.Element,
) {
  const Scene = scene
  const holder: { project?: ReturnType<typeof useProject> } = {}
  await Bun.write(`${root}/kv.json`, JSON.stringify({ animations_enabled: false }))
  const app = await testRender(
    () => (
      <Providers root={root} fetch={transport.fetch} events={source}>
        <Probe capture={(project) => (holder.project = project)} />
        <Scene />
      </Providers>
    ),
    { width: 100, height: 30, kittyKeyboard: true },
  )
  app.renderer.start()
  await app.waitFor(() => holder.project?.project() === "proj_test", { maxPasses: 500 })
  return app
}

function seen(app: App, text: string) {
  return app.waitForFrame((frame) => frame.includes(text), { maxPasses: 500 })
}

function gone(app: App, text: string) {
  return app.waitForFrame((frame) => !frame.includes(text), { maxPasses: 500 })
}

function Opener(props: {
  sessionID: string
  text?: string
  directory?: string
  workspace?: string
  onDone?: () => void
  capture?: (dialog: DialogContext) => void
}) {
  const dialog = useDialog()
  const toast = useToast()
  const sdk = useSDK()
  props.capture?.(dialog)
  onMount(() => {
    void BtwPrompt.run({
      text: props.text ?? "/btw What runs?",
      client: sdk.client,
      directory: props.directory ?? directory,
      workspace: props.workspace,
      sessionID: props.sessionID,
      toast,
      dialog,
      done() {},
    }).then(
      () => props.onDone?.(),
      () => props.onDone?.(),
    )
  })
  return null
}

// Opens the dialog the way the palette entry in app.tsx does: no item, the live prompt draft.
function PaletteOpener(props: {
  sessionID: string
  directory?: string
  workspace?: string
  draft?: () => string
  capture?: (dialog: DialogContext) => void
}) {
  const dialog = useDialog()
  props.capture?.(dialog)
  onMount(() => {
    dialog.replace(() => (
      <DialogBtw
        sessionID={props.sessionID}
        directory={props.directory ?? directory}
        workspace={props.workspace}
        draft={props.draft ?? (() => "")}
      />
    ))
  })
  return null
}

test("history lists thread heads and selecting one opens that thread", async () => {
  await using tmp = await tmpdir()
  const sessionID = "ses_btw_history_list"
  const items = [
    sideItem({ sessionID, id: "btw_alpha", question: "Alpha question", answer: "Alpha answer", created: 1 }),
    sideItem({ sessionID, id: "btw_beta", question: "Beta question", answer: "Beta answer", created: 2 }),
  ]
  const transport = transportOf((call) =>
    call.method === "GET" && call.path === `/session/${sessionID}/btw` ? json({ items }) : undefined,
  )
  const events = tracked()
  const app = await render(tmp.path, transport, events.source, () => (
    <DialogBtw sessionID={sessionID} directory={directory} />
  ))

  try {
    const history = await seen(app, "Alpha question")
    expect(history).toContain("Side questions")
    expect(history).toContain("Beta question")
    app.mockInput.pressEnter()
    const thread = await seen(app, "Beta answer")
    expect(thread).toContain("Side question")
    expect(thread).toContain("Beta question")
    expect(thread).not.toContain("Alpha answer")
    expect(thread).not.toContain("Side questions")
  } finally {
    app.renderer.destroy()
  }
})

test("a bare /btw opens the side-question history through the dialog", async () => {
  await using tmp = await tmpdir()
  const sessionID = "ses_btw_history_run"
  const head = sideItem({
    sessionID,
    id: "btw_history_head",
    question: "History question",
    answer: "History answer",
  })
  const transport = transportOf((call) =>
    call.method === "GET" && call.path === `/session/${sessionID}/btw` ? json({ items: [head] }) : undefined,
  )
  const events = tracked()
  const app = await render(tmp.path, transport, events.source, () => <Opener sessionID={sessionID} text="/btw" />)

  try {
    const history = await seen(app, "History question")
    expect(history).toContain("Side questions")
    expect(history).toContain("enter open · esc close")
  } finally {
    app.renderer.destroy()
  }
})

test("f follows up only after a finished answer and arms the thread", async () => {
  await using tmp = await tmpdir()
  const sessionID = "ses_btw_follow_ok"
  const head = sideItem({ sessionID, id: "btw_follow_head", question: "Base question", answer: "Base answer" })
  const transport = transportOf((call) => {
    if (call.method === "GET" && call.path === `/session/${sessionID}/btw`) return json({ items: [head] })
    if (call.method === "POST" && call.path === "/tui/append-prompt") return json(true)
  })
  const events = tracked()
  const hold: { dialog?: DialogContext } = {}
  const app = await render(tmp.path, transport, events.source, () => (
    <PaletteOpener sessionID={sessionID} capture={(dialog) => (hold.dialog = dialog)} />
  ))

  try {
    await seen(app, "Base question")
    app.mockInput.pressEnter()
    await seen(app, "Base answer")
    app.mockInput.pressKey("f")
    await app.waitFor(() => transport.calls.some((call) => call.path === "/tui/append-prompt"), { maxPasses: 500 })
    expect(take(sessionID)).toBe("btw_follow_head")
    expect(transport.calls.find((call) => call.path === "/tui/append-prompt")?.body).toEqual({ text: "/btw " })
    await gone(app, "Base answer")
    expect(hold.dialog?.stack.length).toBe(0)
    expect(app.captureCharFrame()).not.toContain("Wait for the running side question to finish")
  } finally {
    take(sessionID)
    app.renderer.destroy()
  }
})

test("f after an asked side question finishes arms its thread and closing sends a no-op cancel", async () => {
  await using tmp = await tmpdir()
  const sessionID = "ses_btw_ask_follow"
  const running = sideItem({ sessionID, id: "btw_ask_follow", question: "What runs?", status: "running" })
  const cancel = `/session/${sessionID}/btw/btw_ask_follow/cancel`
  const transport = transportOf((call) => {
    if (call.method === "GET" && call.path === `/session/${sessionID}/btw`) return json({ items: [running] })
    if (call.method === "POST" && call.path === `/session/${sessionID}/btw`) return json(running)
    if (call.method === "POST" && call.path === cancel) return json({ cancelled: false })
    if (call.method === "POST" && call.path === "/tui/append-prompt") return json(true)
  })
  const events = tracked()
  const hold: { dialog?: DialogContext } = {}
  const started = Promise.withResolvers<void>()
  const app = await render(tmp.path, transport, events.source, () => (
    <Opener sessionID={sessionID} onDone={() => started.resolve()} capture={(dialog) => (hold.dialog = dialog)} />
  ))

  try {
    await started.promise
    await seen(app, "running…")
    app.mockInput.pressKey("f")
    await seen(app, "Wait for the running side question to finish")
    expect(transport.calls.some((call) => call.path === cancel)).toBe(false)

    await events.ready
    events.emit(
      btwEvent(
        "done",
        sideItem({ sessionID, id: "btw_ask_follow", question: "What runs?", answer: "Main answer", status: "done" }),
        1,
      ),
    )
    await seen(app, "Main answer")
    app.mockInput.pressKey("f")
    await app.waitFor(() => transport.calls.some((call) => call.path === "/tui/append-prompt"), { maxPasses: 500 })
    expect(take(sessionID)).toBe("btw_ask_follow")
    expect(transport.calls.find((call) => call.path === "/tui/append-prompt")?.body).toEqual({ text: "/btw " })
    await app.waitFor(() => transport.calls.some((call) => call.path === cancel), { maxPasses: 500 })
    expect(transport.calls.filter((call) => call.path === cancel)).toHaveLength(1)
    expect(hold.dialog?.stack.length).toBe(0)
  } finally {
    take(sessionID)
    app.renderer.destroy()
  }
})

test("f refuses to follow up while an answer is running", async () => {
  await using tmp = await tmpdir()
  const sessionID = "ses_btw_follow_busy"
  const running = sideItem({ sessionID, id: "btw_busy_head", question: "Busy question", status: "running" })
  const transport = transportOf((call) =>
    call.method === "GET" && call.path === `/session/${sessionID}/btw` ? json({ items: [] }) : undefined,
  )
  const events = tracked()
  const app = await render(tmp.path, transport, events.source, () => (
    <DialogBtw sessionID={sessionID} directory={directory} item={running} />
  ))

  try {
    await seen(app, "running…")
    app.mockInput.pressKey("f")
    await seen(app, "Wait for the running side question to finish")
    expect(take(sessionID)).toBeUndefined()
    expect(transport.calls.some((call) => call.path === "/tui/append-prompt")).toBe(false)
  } finally {
    take(sessionID)
    app.renderer.destroy()
  }
})

test("f refuses to follow up without a finished answer", async () => {
  await using tmp = await tmpdir()
  const sessionID = "ses_btw_follow_empty"
  const failed = sideItem({
    sessionID,
    id: "btw_empty_head",
    question: "Failed question",
    status: "error",
    error: "provider failed",
  })
  const transport = transportOf((call) =>
    call.method === "GET" && call.path === `/session/${sessionID}/btw` ? json({ items: [] }) : undefined,
  )
  const events = tracked()
  const app = await render(tmp.path, transport, events.source, () => (
    <DialogBtw sessionID={sessionID} directory={directory} item={failed} />
  ))

  try {
    await seen(app, "failed: provider failed")
    app.mockInput.pressKey("f")
    await seen(app, "This thread has no finished answer to follow up on")
    expect(take(sessionID)).toBeUndefined()
    expect(transport.calls.some((call) => call.path === "/tui/append-prompt")).toBe(false)
  } finally {
    take(sessionID)
    app.renderer.destroy()
  }
})

test("i inserts the last finished answer as a quote", async () => {
  await using tmp = await tmpdir()
  const sessionID = "ses_btw_insert_ok"
  const head = sideItem({
    sessionID,
    id: "btw_insert_head",
    question: "Head question",
    answer: "Head answer",
    created: 1,
  })
  const follow = sideItem({
    sessionID,
    id: "btw_insert_follow",
    threadID: "btw_insert_head",
    question: "Follow question",
    answer: "Follow answer",
    created: 2,
  })
  const transport = transportOf((call) => {
    if (call.method === "GET" && call.path === `/session/${sessionID}/btw`) return json({ items: [head, follow] })
    if (call.method === "POST" && call.path === "/tui/append-prompt") return json(true)
  })
  const events = tracked()
  const hold: { dialog?: DialogContext } = {}
  const app = await render(tmp.path, transport, events.source, () => (
    <PaletteOpener sessionID={sessionID} capture={(dialog) => (hold.dialog = dialog)} />
  ))

  try {
    await seen(app, "Head question")
    app.mockInput.pressEnter()
    await seen(app, "Follow answer")
    app.mockInput.pressKey("i")
    await app.waitFor(() => transport.calls.some((call) => call.path === "/tui/append-prompt"), { maxPasses: 500 })
    expect(transport.calls.find((call) => call.path === "/tui/append-prompt")?.body).toEqual({
      text: "> **Side question:** Follow question\n>\n> Follow answer\n\n",
    })
    await gone(app, "Side question")
    expect(hold.dialog?.stack.length).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("i refuses to insert while an answer is running", async () => {
  await using tmp = await tmpdir()
  const sessionID = "ses_btw_insert_busy"
  const running = sideItem({ sessionID, id: "btw_insert_busy_head", question: "Busy question", status: "running" })
  const transport = transportOf((call) =>
    call.method === "GET" && call.path === `/session/${sessionID}/btw` ? json({ items: [] }) : undefined,
  )
  const events = tracked()
  const app = await render(tmp.path, transport, events.source, () => (
    <DialogBtw sessionID={sessionID} directory={directory} item={running} />
  ))

  try {
    await seen(app, "running…")
    app.mockInput.pressKey("i")
    await seen(app, "Wait for the running side question to finish")
    expect(transport.calls.some((call) => call.path === "/tui/append-prompt")).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("i refuses to insert without a finished answer", async () => {
  await using tmp = await tmpdir()
  const sessionID = "ses_btw_insert_empty"
  const failed = sideItem({
    sessionID,
    id: "btw_insert_empty_head",
    question: "Failed question",
    status: "error",
    error: "provider failed",
  })
  const transport = transportOf((call) =>
    call.method === "GET" && call.path === `/session/${sessionID}/btw` ? json({ items: [] }) : undefined,
  )
  const events = tracked()
  const app = await render(tmp.path, transport, events.source, () => (
    <DialogBtw sessionID={sessionID} directory={directory} item={failed} />
  ))

  try {
    await seen(app, "failed: provider failed")
    app.mockInput.pressKey("i")
    await seen(app, "No finished answer to insert yet")
    expect(transport.calls.some((call) => call.path === "/tui/append-prompt")).toBe(false)
  } finally {
    app.renderer.destroy()
  }
})

test("a same-id update replaces the running item with its answer", async () => {
  await using tmp = await tmpdir()
  const sessionID = "ses_btw_live"
  const running = sideItem({ sessionID, id: "btw_live_item", question: "Live question", status: "running" })
  const transport = transportOf((call) =>
    call.method === "GET" && call.path === `/session/${sessionID}/btw` ? json({ items: [] }) : undefined,
  )
  const events = tracked()
  const app = await render(tmp.path, transport, events.source, () => (
    <DialogBtw sessionID={sessionID} directory={directory} item={running} />
  ))

  try {
    await seen(app, "running…")
    await events.ready
    events.emit(
      btwEvent(
        "done",
        sideItem({ sessionID, id: "btw_live_item", question: "Live question", answer: "Live answer", status: "done" }),
        1,
      ),
    )
    const live = await seen(app, "Live answer")
    expect(live).not.toContain("running…")
  } finally {
    app.renderer.destroy()
  }
})

test("h toggles history and updates for another session are ignored", async () => {
  await using tmp = await tmpdir()
  const sessionID = "ses_btw_toggle"
  const head = sideItem({ sessionID, id: "btw_toggle_head", question: "Toggle question", answer: "Toggle answer" })
  const transport = transportOf((call) =>
    call.method === "GET" && call.path === `/session/${sessionID}/btw` ? json({ items: [head] }) : undefined,
  )
  const events = tracked()
  const app = await render(tmp.path, transport, events.source, () => (
    <DialogBtw sessionID={sessionID} directory={directory} item={head} />
  ))

  try {
    await seen(app, "Toggle answer")
    app.mockInput.pressKey("h")
    await seen(app, "Side questions")
    expect(app.captureCharFrame()).toContain("Toggle question")
    app.mockInput.pressKey("h")
    const thread = await seen(app, "Toggle answer")
    expect(thread).toContain("Side question")
    expect(thread).not.toContain("Side questions")

    await events.ready
    events.emit(
      btwEvent(
        "other",
        sideItem({
          sessionID: "ses_btw_other",
          id: "btw_other_item",
          threadID: "btw_toggle_head",
          question: "Other session question",
          answer: "Other session answer",
          created: 2,
        }),
        1,
      ),
    )
    events.emit(
      btwEvent(
        "live",
        sideItem({
          sessionID,
          id: "btw_toggle_event",
          threadID: "btw_toggle_head",
          question: "Live event question",
          answer: "Live event answer",
          created: 3,
        }),
        2,
      ),
    )
    const live = await seen(app, "Live event answer")
    expect(live).toContain("Live event question")
    expect(live).not.toContain("Other session question")
    expect(live).not.toContain("Other session answer")
  } finally {
    app.renderer.destroy()
  }
})

test("h in a dialog opened by /btw <question> reaches the history and back without re-creating the dialog", async () => {
  await using tmp = await tmpdir()
  const sessionID = "ses_btw_ask_toggle"
  const item = sideItem({ sessionID, id: "btw_ask_toggle", question: "What runs?", answer: "Toggle answer" })
  const list = `/session/${sessionID}/btw`
  const transport = transportOf((call) => {
    if (call.method === "GET" && call.path === list) return json({ items: [item] })
    if (call.method === "POST" && call.path === list) return json(item)
  })
  const events = tracked()
  const started = Promise.withResolvers<void>()
  const app = await render(tmp.path, transport, events.source, () => (
    <Opener sessionID={sessionID} onDone={() => started.resolve()} />
  ))

  try {
    await started.promise
    await seen(app, "Toggle answer")
    app.mockInput.pressKey("h")
    const history = await seen(app, "Side questions")
    expect(history).toContain("What runs?")
    app.mockInput.pressKey("h")
    await seen(app, "Toggle answer")
    expect(transport.calls.filter((call) => call.method === "GET" && call.path === list)).toHaveLength(1)
  } finally {
    app.renderer.destroy()
  }
})

test("f warns and does not arm when the draft has typed text", async () => {
  await using tmp = await tmpdir()
  const sessionID = "ses_btw_draft_follow_text"
  const head = sideItem({ sessionID, id: "btw_draft_follow_head", question: "Base question", answer: "Base answer" })
  const transport = transportOf((call) =>
    call.method === "GET" && call.path === `/session/${sessionID}/btw` ? json({ items: [head] }) : undefined,
  )
  const events = tracked()
  const hold: { dialog?: DialogContext } = {}
  const app = await render(tmp.path, transport, events.source, () => (
    <PaletteOpener sessionID={sessionID} draft={() => "typed"} capture={(dialog) => (hold.dialog = dialog)} />
  ))

  try {
    await seen(app, "Base question")
    app.mockInput.pressEnter()
    await seen(app, "Base answer")
    app.mockInput.pressKey("f")
    await seen(app, "Clear the prompt first, then follow up")
    expect(take(sessionID)).toBeUndefined()
    expect(transport.calls.some((call) => call.path === "/tui/append-prompt")).toBe(false)
    expect(hold.dialog?.stack.length).toBe(1)
  } finally {
    take(sessionID)
    app.renderer.destroy()
  }
})

test("f arms and does not append when the draft already starts with /btw", async () => {
  await using tmp = await tmpdir()
  const sessionID = "ses_btw_draft_follow_cmd"
  const head = sideItem({ sessionID, id: "btw_draft_cmd_head", question: "Base question", answer: "Base answer" })
  const transport = transportOf((call) =>
    call.method === "GET" && call.path === `/session/${sessionID}/btw` ? json({ items: [head] }) : undefined,
  )
  const events = tracked()
  const hold: { dialog?: DialogContext } = {}
  const app = await render(tmp.path, transport, events.source, () => (
    <PaletteOpener sessionID={sessionID} draft={() => "/btw "} capture={(dialog) => (hold.dialog = dialog)} />
  ))

  try {
    await seen(app, "Base question")
    app.mockInput.pressEnter()
    await seen(app, "Base answer")
    app.mockInput.pressKey("f")
    await app.waitFor(() => hold.dialog?.stack.length === 0, { maxPasses: 500 })
    expect(take(sessionID)).toBe("btw_draft_cmd_head")
    expect(transport.calls.some((call) => call.path === "/tui/append-prompt")).toBe(false)
    await gone(app, "Base answer")
  } finally {
    take(sessionID)
    app.renderer.destroy()
  }
})

test("i keeps typed text above the quoted answer", async () => {
  await using tmp = await tmpdir()
  const sessionID = "ses_btw_draft_insert"
  const head = sideItem({ sessionID, id: "btw_draft_insert_head", question: "Base question", answer: "Base answer" })
  const transport = transportOf((call) => {
    if (call.method === "GET" && call.path === `/session/${sessionID}/btw`) return json({ items: [head] })
    if (call.method === "POST" && call.path === "/tui/append-prompt") return json(true)
  })
  const events = tracked()
  const hold: { dialog?: DialogContext } = {}
  const app = await render(tmp.path, transport, events.source, () => (
    <PaletteOpener sessionID={sessionID} draft={() => "typed"} capture={(dialog) => (hold.dialog = dialog)} />
  ))

  try {
    await seen(app, "Base question")
    app.mockInput.pressEnter()
    await seen(app, "Base answer")
    app.mockInput.pressKey("i")
    await app.waitFor(() => transport.calls.some((call) => call.path === "/tui/append-prompt"), { maxPasses: 500 })
    expect(transport.calls.find((call) => call.path === "/tui/append-prompt")?.body).toEqual({
      text: "\n\n> **Side question:** Base question\n>\n> Base answer\n\n",
    })
    await gone(app, "Side question")
    expect(hold.dialog?.stack.length).toBe(0)
  } finally {
    app.renderer.destroy()
  }
})

test("a running side question is shown as running and closing the dialog cancels it", async () => {
  await using tmp = await tmpdir()
  const sessionID = "ses_btw_close"
  const running = sideItem({ sessionID, id: "btw_run", question: "What runs?", status: "running" })
  const transport = transportOf((call) => {
    if (call.method === "GET" && call.path === `/session/${sessionID}/btw`) return json({ items: [running] })
    if (call.method === "POST" && call.path === `/session/${sessionID}/btw`) return json(running)
    if (call.method === "POST" && call.path === `/session/${sessionID}/btw/btw_run/cancel`) {
      return json({ cancelled: true })
    }
  })
  const events = tracked()
  const hold: { dialog?: DialogContext } = {}
  const started = Promise.withResolvers<void>()
  const app = await render(tmp.path, transport, events.source, () => (
    <Opener sessionID={sessionID} onDone={() => started.resolve()} capture={(dialog) => (hold.dialog = dialog)} />
  ))

  try {
    await started.promise
    const open = await seen(app, "What runs?")
    expect(open).toContain("running…")
    app.mockInput.pressEscape()
    const cancelPath = `/session/${sessionID}/btw/btw_run/cancel`
    await app.waitFor(() => transport.calls.filter((call) => call.path === cancelPath).length === 1, {
      maxPasses: 500,
    })
    await app.waitFor(() => hold.dialog?.stack.length === 0, { maxPasses: 500 })
    const cancels = transport.calls.filter((call) => call.path === cancelPath)
    expect(cancels).toHaveLength(1)
    expect(cancels[0]?.method).toBe("POST")
    await gone(app, "running…")
    expect(app.captureCharFrame()).not.toContain("What runs?")
  } finally {
    app.renderer.destroy()
  }
})

test("an asked side question, its history load and its cancel go to the session directory", async () => {
  await using tmp = await tmpdir()
  const sessionID = "ses_btw_scope_ask"
  const running = sideItem({ sessionID, id: "btw_scope_run", question: "What runs?", status: "running" })
  const list = `/session/${sessionID}/btw`
  const cancel = `${list}/btw_scope_run/cancel`
  const transport = transportOf((call) => {
    if (call.method === "GET" && call.path === list) return json({ items: [running] })
    if (call.method === "POST" && call.path === list) return json(running)
    if (call.method === "POST" && call.path === cancel) return json({ cancelled: true })
  })
  const events = tracked()
  const started = Promise.withResolvers<void>()
  const app = await render(tmp.path, transport, events.source, () => (
    <Opener sessionID={sessionID} directory="/tmp/btw-worktree" onDone={() => started.resolve()} />
  ))

  try {
    await started.promise
    await seen(app, "running…")
    await app.waitFor(() => transport.calls.some((call) => call.method === "GET" && call.path === list), {
      maxPasses: 500,
    })
    app.mockInput.pressEscape()
    await app.waitFor(() => transport.calls.some((call) => call.path === cancel), { maxPasses: 500 })
    const scoped = [
      transport.calls.find((call) => call.method === "POST" && call.path === list),
      transport.calls.find((call) => call.method === "GET" && call.path === list),
      transport.calls.find((call) => call.method === "POST" && call.path === cancel),
    ]
    for (const call of scoped) {
      expect(call?.directory).toBe("/tmp/btw-worktree")
      expect(call?.workspace).toBeUndefined()
    }
  } finally {
    app.renderer.destroy()
  }
})

test("a workspace takes precedence over the directory when the dialog loads history and inserts an answer", async () => {
  await using tmp = await tmpdir()
  const sessionID = "ses_btw_scope_palette"
  const head = sideItem({ sessionID, id: "btw_scope_head", question: "Scoped question", answer: "Scoped answer" })
  const list = `/session/${sessionID}/btw`
  const transport = transportOf((call) => {
    if (call.method === "GET" && call.path === list) return json({ items: [head] })
    if (call.method === "POST" && call.path === "/tui/append-prompt") return json(true)
  })
  const events = tracked()
  const app = await render(tmp.path, transport, events.source, () => (
    <PaletteOpener sessionID={sessionID} workspace="wrk_btw" directory="/tmp/btw-worktree" />
  ))

  try {
    await seen(app, "Scoped question")
    app.mockInput.pressEnter()
    await seen(app, "Scoped answer")
    app.mockInput.pressKey("i")
    await app.waitFor(() => transport.calls.some((call) => call.path === "/tui/append-prompt"), { maxPasses: 500 })
    const history = transport.calls.find((call) => call.method === "GET" && call.path === list)
    const append = transport.calls.find((call) => call.path === "/tui/append-prompt")
    expect(history?.workspace).toBe("wrk_btw")
    expect(history?.directory).not.toBe("/tmp/btw-worktree")
    expect(append?.workspace).toBe("wrk_btw")
    expect(append?.directory).not.toBe("/tmp/btw-worktree")
  } finally {
    app.renderer.destroy()
  }
})
