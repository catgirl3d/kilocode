import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { KiloSessionPromptQueue } from "../../../src/kilocode/session/prompt-queue"
import { Suggestion } from "../../../src/kilocode/suggestion"
import { provideTestInstance } from "../../fixture/fixture"
import { MessageID, SessionID } from "../../../src/session/schema"
import { tmpdir } from "../../fixture/fixture"

describe("Suggestion.show auto-dismiss on queued followup", () => {
  test("show rejects immediately when a followup is queued on the session", async () => {
    // A tool that calls Suggestion.show after a queued prompt has arrived would
    // otherwise block the turn on user input. Verify the pre-emptive
    // hasFollowup check rejects with DismissedError before any pending entry
    // is registered or a Shown event is published.
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const sessionID = SessionID.make("ses_auto_show")
        const started = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()

        // Slot 1 stays running so activeSince is pinned to its seq.
        const first = Effect.runPromise(
          KiloSessionPromptQueue.enqueue(
            sessionID,
            MessageID.make("msg_show_1"),
            Effect.gen(function* () {
              started.resolve()
              yield* Effect.promise(() => release.promise)
              return "first" as const
            }),
            Effect.succeed("first-cancelled" as const),
          ),
        )
        await started.promise

        // Slot 2 arrives while slot 1 is active — latest > activeSince.
        const second = Effect.runPromise(
          KiloSessionPromptQueue.enqueue(
            sessionID,
            MessageID.make("msg_show_2"),
            Effect.succeed("second" as const),
            Effect.succeed("second-cancelled" as const),
          ),
        )
        await Bun.sleep(10)
        expect(KiloSessionPromptQueue.hasFollowup(sessionID)).toBe(true)

        await expect(
          Suggestion.show({
            sessionID,
            text: "Continue with the task?",
            actions: [{ label: "Continue", prompt: "Continue with the task" }],
          }),
        ).rejects.toBeInstanceOf(Suggestion.DismissedError)
        expect(await Suggestion.list()).toEqual([])

        release.resolve()
        expect(await first).toBe("first")
        expect(await second).toBe("second")
      },
    })
  })

  test("show stays pending while only a background settlement is queued", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const sessionID = SessionID.make("ses_show_settlement")
        const started = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()

        const first = Effect.runPromise(
          KiloSessionPromptQueue.enqueue(
            sessionID,
            MessageID.make("msg_show_settle_1"),
            Effect.gen(function* () {
              started.resolve()
              yield* Effect.promise(() => release.promise)
              return "first" as const
            }),
            Effect.succeed("first-cancelled" as const),
          ),
        )
        await started.promise

        const settlement = Effect.runPromise(
          KiloSessionPromptQueue.enqueue(
            sessionID,
            MessageID.make("msg_show_settle_2"),
            Effect.succeed("settlement" as const),
            Effect.succeed("settlement-cancelled" as const),
            Effect.void,
            true,
          ),
        )
        await Bun.sleep(10)
        expect(KiloSessionPromptQueue.hasBlockingFollowup(sessionID)).toBe(false)

        // A settlement must not suppress the suggestion: it stays pending and
        // the settlement waits behind the user's choice.
        const shown = Suggestion.show({
          sessionID,
          text: "Continue with the task?",
          actions: [{ label: "Continue", prompt: "Continue with the task" }],
        })

        let pending = (await Suggestion.list()).at(0)
        for (let i = 0; pending === undefined && i < 100; i++) {
          await Bun.sleep(5)
          pending = (await Suggestion.list()).at(0)
        }
        expect(pending?.sessionID).toBe(sessionID)

        expect(await Suggestion.dismiss(pending!.id)).toBe(true)
        await expect(shown).rejects.toBeInstanceOf(Suggestion.DismissedError)

        release.resolve()
        expect(await first).toBe("first")
        expect(await settlement).toBe("settlement")
      },
    })
  })
})
