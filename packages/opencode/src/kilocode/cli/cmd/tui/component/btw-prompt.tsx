// fork_change - new file
import type { KiloClient } from "@kilocode/sdk/v2"
import type { DialogContext } from "@tui/ui/dialog"
import type { ToastContext } from "@tui/ui/toast"
import { parseBtwCommand, take, arm } from "@/kilocode/cli/cmd/tui/btw-command"
import { DialogBtw } from "@/kilocode/cli/cmd/tui/component/dialog-btw"
import { route } from "@/kilocode/cli/cmd/tui/memory-command"
import { errorMessage } from "@/util/error"

type Result<T> = {
  data?: T
  error?: unknown
}

function read<T>(result: Result<T>) {
  if (result.error) throw new Error(errorMessage(result.error))
  if (result.data === undefined) throw new Error("Side question returned no data")
  return result.data
}

export namespace BtwPrompt {
  export async function run(input: {
    text: string
    client: KiloClient
    workspace?: string
    directory?: string
    sessionID?: string
    toast: ToastContext
    dialog: DialogContext
    /** Leave the text alone, e.g. in a subagent view where slash commands are off. */
    skip?: boolean
    done(): void
  }) {
    if (input.skip) return false
    const cmd = parseBtwCommand(input.text)
    if (!cmd) {
      // A follow-up armed with `f` only covers the next /btw, so any other submit drops it.
      if (input.sessionID) take(input.sessionID)
      return false
    }
    if (!input.sessionID) {
      input.toast.show({ variant: "warning", message: "Start a conversation first, then ask a side question." })
      return true
    }
    const sessionID = input.sessionID
    const scope = route({ workspace: input.workspace, directory: input.directory })
    if (cmd.kind === "history") {
      take(sessionID)
      input.done()
      input.dialog.replace(() => (
        <DialogBtw sessionID={sessionID} workspace={input.workspace} directory={input.directory} />
      ))
      return true
    }

    const thread = take(sessionID)
    const item = await input.client.session
      .btw({ ...scope, sessionID, question: cmd.question, threadID: thread })
      .then((result) => read(result))
      .catch((error: unknown) => {
        if (thread) arm(sessionID, thread)
        input.toast.show({ variant: "error", message: `Side question failed: ${errorMessage(error)}` })
        return undefined
      })
    if (!item) return true

    input.done()
    input.dialog.replace(
      () => <DialogBtw sessionID={sessionID} workspace={input.workspace} directory={input.directory} item={item} />,
      () => {
        input.client.session
          .btwCancel({ ...scope, sessionID, btwID: item.id })
          .catch((error: unknown) => console.error("Cancel side question failed", error))
      },
    )
    return true
  }
}
