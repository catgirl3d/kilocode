import { Effect } from "effect"
import { Question } from "@/question"
import type { KiloSnapshotGate } from "@/kilocode/snapshot/gate" // fork_change
import type { Context } from "@/tool/tool" // fork_change

/**
 * Helpers for the shared `@/tool/question` tool that surface a dismissed-question
 * outcome (from `Question.dismissAll` when a new prompt arrives mid-question) as
 * a normal tool result instead of letting `Effect.orDie` turn the
 * `QuestionRejectedError` into a defect that kills the in-flight stream.
 *
 * Extracted here so the shared tool file keeps just a one-liner pipe plus an
 * early return, minimising the surface area that conflicts with upstream.
 */
export namespace KiloQuestionTool {
  const DISMISSED = "dismissed" as const
  type Dismissed = typeof DISMISSED

  export const catchDismissed = <A, E, R>(eff: Effect.Effect<A, E | Question.RejectedError, R>) =>
    eff.pipe(Effect.catchTag("QuestionRejectedError", () => Effect.succeed<Dismissed>(DISMISSED)))

  export const isDismissed = (v: unknown): v is Dismissed => v === DISMISSED

  // fork_change start - [fork] keep the question checkpoint on dismissed questions too
  export const dismissedResult = (checkpoint?: string) => ({
    title: "Question dismissed",
    output: "User dismissed the question.",
    metadata: { answers: [] as ReadonlyArray<Question.Answer>, dismissed: true as const, checkpoint },
  })
  // fork_change end

  // fork_change start - [fork] remember the workspace at question time so "Revert to here" can restore it
  export const checkpoint = (ctx: Pick<Context, "messageID" | "extra">): Effect.Effect<string | undefined> => {
    const ops = ctx.extra?.promptOps as { snapshot?: KiloSnapshotGate.Owner } | undefined
    if (!ops?.snapshot) return Effect.succeed(undefined)
    return ops.snapshot.mark(ctx.messageID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
  }
  // fork_change end
}
