// fork_change - new file
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { SessionID } from "@/session/schema"
import * as ManualShake from "@/kilocode/session/shake"
import { InstanceHttpApi } from "@/server/routes/instance/httpapi/api"
import * as SessionError from "@/server/routes/instance/httpapi/handlers/session-errors"

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

    return handlers.handle("shake", shake)
  }),
)
