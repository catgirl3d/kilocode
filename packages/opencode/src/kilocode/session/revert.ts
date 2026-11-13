import { Cause, Effect } from "effect"
import type { MessageV2 } from "@/session/message-v2"
import type { Session } from "@/session/session"
import type { Snapshot } from "@/snapshot"
import type { MessageID, PartID } from "@/session/schema" // fork_change

export namespace KiloSessionRevert {
  const rollback = <E>(snap: Snapshot.Interface, hash: string, files: string[], cause: Cause.Cause<E>) =>
    restore(snap, hash, files).pipe(
      Effect.matchCauseEffect({
        onFailure: (next) => Effect.failCause(Cause.combine(cause, next)),
        onSuccess: () => Effect.failCause(cause),
      }),
    )

  export function files(messages: MessageV2.WithParts[], rev: NonNullable<Session.Info["revert"]>) {
    const result: string[] = []
    let active = false
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (active && part.type === "patch") result.push(...part.files)
        if (active || msg.info.id !== rev.messageID) continue
        if (rev.partID && part.id !== rev.partID) continue
        active = true
      }
    }
    return [...new Set(result)]
  }

  export const apply = Effect.fn("KiloSessionRevert.apply")(function* <A, E, R>(
    snap: Snapshot.Interface,
    baseline: string | undefined,
    files: string[],
    effect: Effect.Effect<A, E, R>,
  ) {
    return yield* effect.pipe(
      Effect.catchCause((cause) => {
        if (!baseline || files.length === 0) return Effect.failCause(cause)
        return rollback(snap, baseline, files, cause)
      }),
    )
  })

  export const restore = Effect.fn("KiloSessionRevert.restore")(function* (
    snap: Snapshot.Interface,
    hash: string,
    files: string[],
  ) {
    if (files.length === 0) return
    yield* snap.revert([{ hash, files }])
  })

  // fork_change start - [fork] "Revert to here" on an answered question keeps the question and its answer
  /**
   * Resolves the effective revert target. Reverting to a finished question cuts the
   * history right after it, so the question and its answer stay, and carries the
   * workspace snapshot the question tool took before asking. Returns undefined when
   * nothing follows the question in its message, so there is nothing to revert.
   */
  export function target<T extends { messageID: MessageID; partID?: PartID }>(
    messages: MessageV2.WithParts[],
    input: T,
  ): (T & { checkpoint?: string }) | undefined {
    if (!input.partID) return input
    for (const msg of messages) {
      const index = msg.parts.findIndex((part) => part.id === input.partID)
      if (index < 0) continue
      const part = msg.parts[index]
      if (part?.type !== "tool" || part.tool !== "question" || part.state.status !== "completed") return input
      const next = msg.parts.at(index + 1)
      if (!next) return undefined
      const checkpoint = part.state.metadata?.checkpoint
      return {
        ...input,
        messageID: msg.info.id,
        partID: next.id,
        checkpoint: typeof checkpoint === "string" ? checkpoint : undefined,
      }
    }
    return input
  }

  /** Restores the patched files from a question checkpoint when there is one. */
  export const rewind = (snap: Snapshot.Interface, patches: Snapshot.Patch[], checkpoint?: string) =>
    checkpoint ? restore(snap, checkpoint, [...new Set(patches.flatMap((patch) => patch.files))]) : snap.revert(patches)
  // fork_change end
}
