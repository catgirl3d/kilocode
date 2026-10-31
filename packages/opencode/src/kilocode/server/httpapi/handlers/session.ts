// fork_change - new file
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionID } from "@/session/schema"
import * as ManualShake from "@/kilocode/session/shake"
import * as ManualReasoningClear from "@/kilocode/session/reasoning-clear"
import { KiloSessionTurn } from "@/kilocode/session/turn"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import * as SessionError from "@/server/routes/instance/httpapi/handlers/session-errors"
import { NotFoundError as StorageNotFoundError } from "@/storage/storage"
import { ConflictError, SessionBusyError, notFound } from "@/server/routes/instance/httpapi/errors"

export const sessionShakeHandlers = HttpApiBuilder.group(InstanceHttpApi, "kilo-session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const status = yield* SessionStatus.Service

    const shake = Effect.fn("KiloSessionHttpApi.shake")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
      if ((yield* status.get(ctx.params.sessionID)).type !== "idle") return yield* new HttpApiError.BadRequest({})
      return yield* SessionError.mapStorageNotFound(
        ManualShake.run({ sessionID: ctx.params.sessionID, sessions: session }),
      )
    })

    const guard = Effect.fn("KiloSessionHttpApi.reasoningClearGuard")(function* (sessionID: SessionID) {
      const current = yield* SessionError.mapStorageNotFound(session.get(sessionID))
      if (current.revert || current.time.archived != null)
        return yield* new ConflictError({ message: "Restore the session before clearing reasoning." })
      if ((yield* status.get(sessionID)).type !== "idle")
        return yield* new SessionBusyError({ sessionID, message: `Session is busy: ${sessionID}` })
      if (yield* KiloSessionTurn.foreign(sessionID))
        return yield* new SessionBusyError({
          sessionID,
          message: `Session is running in another Kilo process: ${sessionID}`,
        })
    })

    const preview = Effect.fn("KiloSessionHttpApi.reasoningClearPreview")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: { keepTurns: number }
    }) {
      yield* guard(ctx.params.sessionID)
      return yield* ManualReasoningClear.preview({
        sessionID: ctx.params.sessionID,
        keepTurns: ctx.payload.keepTurns,
        sessions: session,
      }).pipe(Effect.catchIf(StorageNotFoundError.isInstance, (error) => Effect.fail(notFound(error.message))))
    })

    const apply = Effect.fn("KiloSessionHttpApi.reasoningClear")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: { keepTurns: number; token: string }
    }) {
      yield* guard(ctx.params.sessionID)
      return yield* ManualReasoningClear.apply({
        sessionID: ctx.params.sessionID,
        keepTurns: ctx.payload.keepTurns,
        token: ctx.payload.token,
        sessions: session,
      }).pipe(Effect.catchIf(StorageNotFoundError.isInstance, (error) => Effect.fail(notFound(error.message))))
    })

    return handlers.handle("shake", shake).handle("reasoningClearPreview", preview).handle("reasoningClear", apply)
  }),
)
