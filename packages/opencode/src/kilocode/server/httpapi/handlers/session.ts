// fork_change - new file
import { Effect, Scope } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionID } from "@/session/schema"
import * as ManualShake from "@/kilocode/session/shake"
import * as ManualReasoningClear from "@/kilocode/session/reasoning-clear"
import * as ManualToolClear from "@/kilocode/session/tool-clear"
import { KiloSessionTurn } from "@/kilocode/session/turn"
import { KiloBtw } from "@/kilocode/btw"
import { Provider } from "@/provider/provider"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import * as SessionError from "@/server/routes/instance/httpapi/handlers/session-errors"
import { NotFoundError as StorageNotFoundError } from "@/storage/storage"
import { ConflictError, InvalidRequestError, SessionBusyError, notFound } from "@/server/routes/instance/httpapi/errors"

export const sessionShakeHandlers = HttpApiBuilder.group(InstanceHttpApi, "kilo-session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const status = yield* SessionStatus.Service
    const scope = yield* Scope.Scope

    const shake = Effect.fn("KiloSessionHttpApi.shake")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
      if ((yield* status.get(ctx.params.sessionID)).type !== "idle") return yield* new HttpApiError.BadRequest({})
      return yield* SessionError.mapStorageNotFound(
        ManualShake.run({ sessionID: ctx.params.sessionID, sessions: session }),
      )
    })

    const guard = Effect.fn("KiloSessionHttpApi.clearGuard")(function* (sessionID: SessionID, what: string) {
      const current = yield* SessionError.mapStorageNotFound(session.get(sessionID))
      if (current.revert || current.time.archived != null)
        return yield* new ConflictError({ message: `Restore the session before clearing ${what}.` })
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
      payload: { keepTurns: number; includeCarriers?: boolean }
    }) {
      yield* guard(ctx.params.sessionID, "reasoning")
      return yield* ManualReasoningClear.preview({
        sessionID: ctx.params.sessionID,
        keepTurns: ctx.payload.keepTurns,
        includeCarriers: ctx.payload.includeCarriers,
        sessions: session,
      }).pipe(Effect.catchIf(StorageNotFoundError.isInstance, (error) => Effect.fail(notFound(error.message))))
    })

    const apply = Effect.fn("KiloSessionHttpApi.reasoningClear")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: { keepTurns: number; includeCarriers?: boolean; token: string }
    }) {
      yield* guard(ctx.params.sessionID, "reasoning")
      return yield* ManualReasoningClear.apply({
        sessionID: ctx.params.sessionID,
        keepTurns: ctx.payload.keepTurns,
        includeCarriers: ctx.payload.includeCarriers,
        token: ctx.payload.token,
        sessions: session,
      }).pipe(Effect.catchIf(StorageNotFoundError.isInstance, (error) => Effect.fail(notFound(error.message))))
    })

    const toolPreview = Effect.fn("KiloSessionHttpApi.toolClearPreview")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: { keepTurns: number; includeHistory?: boolean }
    }) {
      yield* guard(ctx.params.sessionID, "tool output")
      return yield* ManualToolClear.preview({
        sessionID: ctx.params.sessionID,
        keepTurns: ctx.payload.keepTurns,
        includeHistory: ctx.payload.includeHistory, // fork_change
        sessions: session,
      }).pipe(Effect.catchIf(StorageNotFoundError.isInstance, (error) => Effect.fail(notFound(error.message))))
    })

    const toolApply = Effect.fn("KiloSessionHttpApi.toolClear")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: { keepTurns: number; includeHistory?: boolean; token: string }
    }) {
      yield* guard(ctx.params.sessionID, "tool output")
      return yield* ManualToolClear.apply({
        sessionID: ctx.params.sessionID,
        keepTurns: ctx.payload.keepTurns,
        includeHistory: ctx.payload.includeHistory, // fork_change
        token: ctx.payload.token,
        sessions: session,
      }).pipe(Effect.catchIf(StorageNotFoundError.isInstance, (error) => Effect.fail(notFound(error.message))))
    })

    const btw = Effect.fn("KiloSessionHttpApi.btw")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: { question: string; threadID?: string }
    }) {
      yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
      const question = ctx.payload.question.trim()
      if (!question) return yield* new InvalidRequestError({ message: "The side question is empty." })
      return yield* KiloBtw.start({
        sessionID: ctx.params.sessionID,
        question,
        threadID: ctx.payload.threadID,
        scope,
      }).pipe(
        Effect.catchTags({
          KiloBtwBusy: (error) => Effect.fail(new ConflictError({ message: error.message })),
          KiloBtwEmpty: (error) => Effect.fail(new ConflictError({ message: error.message })),
          KiloBtwUnsupported: (error) => Effect.fail(new InvalidRequestError({ message: error.message })),
        }),
        Effect.catchIf(StorageNotFoundError.isInstance, (error) => Effect.fail(notFound(error.message))),
        Effect.catchIf(Provider.ModelNotFoundError.isInstance, (error) =>
          Effect.fail(new InvalidRequestError({ message: error.message, kind: "model" })),
        ),
      )
    })

    const btwList = Effect.fn("KiloSessionHttpApi.btwList")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
      return { items: yield* KiloBtw.list(ctx.params.sessionID) }
    })

    const btwCancel = Effect.fn("KiloSessionHttpApi.btwCancel")(function* (ctx: {
      params: { sessionID: SessionID; btwID: string }
    }) {
      yield* SessionError.mapStorageNotFound(session.get(ctx.params.sessionID))
      return { cancelled: yield* KiloBtw.cancel(ctx.params.sessionID, ctx.params.btwID) }
    })

    return handlers
      .handle("shake", shake)
      .handle("reasoningClearPreview", preview)
      .handle("reasoningClear", apply)
      .handle("toolClearPreview", toolPreview)
      .handle("toolClear", toolApply)
      .handle("btw", btw)
      .handle("btwList", btwList)
      .handle("btwCancel", btwCancel)
  }),
)
