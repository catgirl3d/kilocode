// fork_change - new file
import type { KiloClient } from "@kilocode/sdk/v2/client"
import { getErrorMessage } from "../kilo-provider-utils"

type KiloProviderBtwInput = {
  client(): KiloClient | undefined
  dir(sessionID: string): string | undefined
  post(message: unknown): void
}

function text(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

export class KiloProviderBtw {
  constructor(private readonly input: KiloProviderBtwInput) {}

  async handle(message: Record<string, unknown>): Promise<void> {
    const sessionID = text(message.sessionID)
    if (!sessionID) return
    const requestID = text(message.requestID)
    const client = this.input.client()
    if (!client) {
      this.input.post({ type: "btwFailed", sessionID, requestID, error: "Not connected to CLI backend" })
      return
    }
    const directory = this.input.dir(sessionID)
    if (message.type === "btwAsk") {
      const question = text(message.question)?.trim()
      if (!question || !requestID) return
      const result = await client.session
        .btw({ sessionID, directory, question, threadID: text(message.threadID) }, { throwOnError: true })
        .catch((error: unknown) => {
          this.input.post({
            type: "btwFailed",
            sessionID,
            requestID,
            error: getErrorMessage(error) || "Side question failed",
          })
          return undefined
        })
      if (result) this.input.post({ type: "btwStarted", sessionID, requestID, item: result.data })
      return
    }
    if (message.type === "btwCancel") {
      const id = text(message.btwID)
      if (!id) return
      const result = await client.session
        .btwCancel({ sessionID, btwID: id, directory }, { throwOnError: true })
        .catch((error: unknown) => {
          console.error("[Kilo New] btw cancel failed:", error)
          return undefined
        })
      if (result?.data.cancelled) return
      // cancelled: false means the answer finished first, or the CLI no longer runs this row: refresh the list.
      if (result) return this.load(client, sessionID, directory)
      // Requestless, so the store only shows the error and leaves any pending request alone.
      this.input.post({ type: "btwFailed", sessionID, error: "Could not cancel the side question." })
      return
    }
    if (message.type === "btwHistory") return this.load(client, sessionID, directory)
  }

  private async load(client: KiloClient, sessionID: string, directory: string | undefined) {
    const result = await client.session
      .btwList({ sessionID, directory }, { throwOnError: true })
      .catch((error: unknown) => {
        this.input.post({
          type: "btwFailed",
          sessionID,
          error: getErrorMessage(error) || "Failed to load side questions",
        })
        return undefined
      })
    if (result) this.input.post({ type: "btwHistoryLoaded", sessionID, items: result.data.items })
  }
}
