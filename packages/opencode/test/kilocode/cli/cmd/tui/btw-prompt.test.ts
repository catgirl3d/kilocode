import { describe, expect, test } from "bun:test"
import type { KiloClient } from "@kilocode/sdk/v2"
import type { DialogContext } from "@tui/ui/dialog"
import type { ToastContext } from "@tui/ui/toast"
import { arm, take } from "@/kilocode/cli/cmd/tui/btw-command"
import { BtwPrompt } from "@/kilocode/cli/cmd/tui/component/btw-prompt"

type Notice = { variant: string; message: string }

const client = {} as unknown as KiloClient
const toast = { show() {} } as unknown as ToastContext
const dialog = { replace() {} } as unknown as DialogContext

function submit(input: {
  text: string
  sessionID?: string
  workspace?: string
  directory?: string
  skip?: boolean
  client?: KiloClient
  toast?: ToastContext
  dialog?: DialogContext
  done?: () => void
}) {
  return BtwPrompt.run({
    client: input.client ?? client,
    toast: input.toast ?? toast,
    dialog: input.dialog ?? dialog,
    done: input.done ?? (() => {}),
    text: input.text,
    sessionID: input.sessionID,
    workspace: input.workspace,
    directory: input.directory,
    skip: input.skip,
  })
}

function fakeBtw(input: {
  session: {
    btw(input: {
      sessionID: string
      question: string
      threadID?: string
      workspace?: string
      directory?: string
    }): Promise<unknown>
    btwCancel?(input: { sessionID: string; btwID: string; workspace?: string; directory?: string }): Promise<unknown>
  }
}) {
  return input as unknown as KiloClient
}

function capture() {
  const notices: Notice[] = []
  const replaced: { element: unknown; close?: () => void }[] = []
  const completed: number[] = []
  return {
    notices,
    replaced,
    completed,
    toast: {
      show(notice: Notice) {
        notices.push(notice)
      },
    } as unknown as ToastContext,
    dialog: {
      replace(element: unknown, close?: () => void) {
        replaced.push({ element, close })
      },
    } as unknown as DialogContext,
  }
}

function item(input: { sessionID: string; id: string; question: string }) {
  return {
    id: input.id,
    sessionID: input.sessionID,
    threadID: input.id,
    status: "running",
    question: input.question,
    answer: "",
    providerID: "test",
    modelID: "test",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1 },
  }
}

describe("btw prompt arming", () => {
  test("a non-btw submit drops the armed follow-up", async () => {
    arm("ses_btw_plain", "btw_plain")
    expect(await submit({ text: "refactor the parser", sessionID: "ses_btw_plain" })).toBe(false)
    expect(take("ses_btw_plain")).toBeUndefined()
  })

  test("a skipped submit keeps the armed follow-up", async () => {
    arm("ses_btw_skip", "btw_skip")
    expect(await submit({ text: "refactor the parser", sessionID: "ses_btw_skip", skip: true })).toBe(false)
    expect(take("ses_btw_skip")).toBe("btw_skip")
  })

  test("a skipped /btw submit keeps the armed follow-up and calls nothing", async () => {
    const sessionID = "ses_btw_skip_command"
    const spy = capture()
    const calls: string[] = []
    const fake = fakeBtw({
      session: {
        async btw() {
          calls.push("btw")
          return { data: undefined }
        },
        async btwCancel() {
          calls.push("btwCancel")
          return { data: { cancelled: true } }
        },
      },
    })

    arm(sessionID, "btw_skip_command_thread")
    expect(
      await submit({
        text: "/btw why",
        sessionID,
        skip: true,
        client: fake,
        toast: spy.toast,
        dialog: spy.dialog,
        done: () => spy.completed.push(1),
      }),
    ).toBe(false)
    expect(take(sessionID)).toBe("btw_skip_command_thread")
    expect(calls).toEqual([])
    expect(spy.notices).toEqual([])
    expect(spy.replaced).toEqual([])
    expect(spy.completed).toEqual([])
  })

  test("opening history drops the armed follow-up", async () => {
    const sessionID = "ses_btw_history"
    const spy = capture()
    arm(sessionID, "btw_history")
    expect(
      await submit({
        text: "/btw",
        sessionID,
        toast: spy.toast,
        dialog: spy.dialog,
        done: () => spy.completed.push(1),
      }),
    ).toBe(true)
    expect(take(sessionID)).toBeUndefined()
    expect(spy.completed).toHaveLength(1)
    expect(spy.replaced).toHaveLength(1)
    expect(spy.notices).toEqual([])
  })
})

describe("btw prompt ask", () => {
  test("a successful ask uses the trimmed question, opens the dialog, and cancels it on close", async () => {
    const sessionID = "ses_btw_ask"
    const spy = capture()
    const asks: { sessionID: string; question: string; threadID?: string }[] = []
    const cancels: { sessionID: string; btwID: string }[] = []
    const fake = fakeBtw({
      session: {
        async btw(input) {
          asks.push(input)
          return { data: item({ sessionID, id: "btw_ask_item", question: input.question }) }
        },
        async btwCancel(input) {
          cancels.push(input)
          return { data: { cancelled: true } }
        },
      },
    })

    arm(sessionID, "btw_ask_thread")
    expect(
      await submit({
        text: "  /btw  explain the parser  ",
        sessionID,
        client: fake,
        toast: spy.toast,
        dialog: spy.dialog,
        done: () => spy.completed.push(1),
      }),
    ).toBe(true)

    expect(spy.completed).toHaveLength(1)
    expect(asks).toEqual([{ sessionID, question: "explain the parser", threadID: "btw_ask_thread" }])
    expect(spy.replaced).toHaveLength(1)
    expect(take(sessionID)).toBeUndefined()
    expect(cancels).toEqual([])

    spy.replaced[0]?.close?.()
    await Bun.sleep(0)
    expect(cancels).toEqual([{ sessionID, btwID: "btw_ask_item" }])
    expect(spy.notices).toEqual([])
  })

  test("a failed ask reports an error and re-arms the thread", async () => {
    const sessionID = "ses_btw_fail"
    const spy = capture()
    const fake = fakeBtw({
      session: {
        async btw() {
          return { error: { name: "NotFoundError", data: { message: "provider exploded" } } }
        },
      },
    })

    arm(sessionID, "btw_fail_thread")
    expect(
      await submit({
        text: "/btw why",
        sessionID,
        client: fake,
        toast: spy.toast,
        dialog: spy.dialog,
        done: () => spy.completed.push(1),
      }),
    ).toBe(true)

    expect(spy.notices).toEqual([{ variant: "error", message: "Side question failed: provider exploded" }])
    expect(take(sessionID)).toBe("btw_fail_thread")
    expect(spy.replaced).toEqual([])
    expect(spy.completed).toEqual([])
  })

  test("an ask without data reports an error and re-arms the thread", async () => {
    const sessionID = "ses_btw_no_data"
    const spy = capture()
    const fake = fakeBtw({
      session: {
        async btw() {
          return { data: undefined }
        },
      },
    })

    arm(sessionID, "btw_no_data_thread")
    expect(
      await submit({
        text: "/btw why",
        sessionID,
        client: fake,
        toast: spy.toast,
        dialog: spy.dialog,
        done: () => spy.completed.push(1),
      }),
    ).toBe(true)

    expect(spy.notices).toEqual([{ variant: "error", message: "Side question failed: Side question returned no data" }])
    expect(take(sessionID)).toBe("btw_no_data_thread")
    expect(spy.replaced).toEqual([])
    expect(spy.completed).toEqual([])
  })

  test("asking without a session warns without calling the client", async () => {
    const spy = capture()
    const fake = fakeBtw({
      session: {
        async btw() {
          throw new Error("btw must not be called without a session")
        },
      },
    })

    expect(
      await submit({
        text: "/btw what is this",
        sessionID: undefined,
        client: fake,
        toast: spy.toast,
        dialog: spy.dialog,
      }),
    ).toBe(true)

    expect(spy.notices).toEqual([
      { variant: "warning", message: "Start a conversation first, then ask a side question." },
    ])
    expect(spy.replaced).toEqual([])
    expect(spy.completed).toEqual([])
  })

  test("an ask and its cancel go to the session directory", async () => {
    const sessionID = "ses_btw_worktree"
    const spy = capture()
    const asks: { sessionID: string; question: string; threadID?: string; workspace?: string; directory?: string }[] =
      []
    const cancels: { sessionID: string; btwID: string; workspace?: string; directory?: string }[] = []
    const fake = fakeBtw({
      session: {
        async btw(input) {
          asks.push(input)
          return { data: item({ sessionID, id: "btw_worktree_item", question: input.question }) }
        },
        async btwCancel(input) {
          cancels.push(input)
          return { data: { cancelled: true } }
        },
      },
    })

    expect(
      await submit({
        text: "/btw where?",
        sessionID,
        directory: "/tmp/btw-worktree",
        client: fake,
        toast: spy.toast,
        dialog: spy.dialog,
        done: () => spy.completed.push(1),
      }),
    ).toBe(true)

    expect(asks).toEqual([{ directory: "/tmp/btw-worktree", sessionID, question: "where?", threadID: undefined }])
    expect(spy.replaced).toHaveLength(1)
    expect(cancels).toEqual([])

    spy.replaced[0]?.close?.()
    await Bun.sleep(0)
    expect(cancels).toEqual([{ directory: "/tmp/btw-worktree", sessionID, btwID: "btw_worktree_item" }])
    expect(spy.notices).toEqual([])
  })

  test("a workspace takes precedence over the directory for an ask and its cancel", async () => {
    const sessionID = "ses_btw_workspace"
    const spy = capture()
    const asks: { sessionID: string; question: string; threadID?: string; workspace?: string; directory?: string }[] =
      []
    const cancels: { sessionID: string; btwID: string; workspace?: string; directory?: string }[] = []
    const fake = fakeBtw({
      session: {
        async btw(input) {
          asks.push(input)
          return { data: item({ sessionID, id: "btw_workspace_item", question: input.question }) }
        },
        async btwCancel(input) {
          cancels.push(input)
          return { data: { cancelled: true } }
        },
      },
    })

    expect(
      await submit({
        text: "/btw where?",
        sessionID,
        workspace: "wrk_btw",
        directory: "/tmp/btw-worktree",
        client: fake,
        toast: spy.toast,
        dialog: spy.dialog,
        done: () => spy.completed.push(1),
      }),
    ).toBe(true)

    expect(asks).toEqual([{ workspace: "wrk_btw", sessionID, question: "where?", threadID: undefined }])
    expect(asks.at(0)).not.toHaveProperty("directory")
    expect(spy.replaced).toHaveLength(1)
    expect(cancels).toEqual([])

    spy.replaced[0]?.close?.()
    await Bun.sleep(0)
    expect(cancels).toEqual([{ workspace: "wrk_btw", sessionID, btwID: "btw_workspace_item" }])
    expect(cancels.at(0)).not.toHaveProperty("directory")
    expect(spy.notices).toEqual([])
  })
})
