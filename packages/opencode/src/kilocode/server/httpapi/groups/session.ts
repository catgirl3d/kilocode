// fork_change - new file
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { SessionID } from "@/session/schema"
import { Result as ShakeResult } from "@/kilocode/session/shake"
import {
  ApplyResult as ReasoningClearApplyResult,
  PreviewResult as ReasoningClearPreviewResult,
  StalePreviewError as ReasoningClearStalePreviewError,
} from "@/kilocode/session/reasoning-clear"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { ApiNotFoundError, ConflictError, SessionBusyError } from "@/server/routes/instance/httpapi/errors"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

const path = "/session/:sessionID/shake"
const reasoningClearPreviewPath = "/session/:sessionID/reasoning/clear/preview"
const reasoningClearPath = "/session/:sessionID/reasoning/clear"

export const ReasoningClearPreviewPayload = Schema.Struct({
  keepTurns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
})

export const ReasoningClearPayload = Schema.Struct({
  keepTurns: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  token: Schema.String,
})

export const KiloSessionPaths = {
  shake: path,
  reasoningClearPreview: reasoningClearPreviewPath,
  reasoningClear: reasoningClearPath,
} as const

export const KiloSessionApi = HttpApi.make("kilocode-session")
  .add(
    HttpApiGroup.make("kilo-session")
      .add(
        HttpApiEndpoint.post("shake", KiloSessionPaths.shake, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          success: described(ShakeResult, "Cleared historical tool output"),
          error: [HttpApiError.BadRequest, ApiNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.shake",
            summary: "Clear tool output",
            description: "Clear all eligible tool output in the current context without invoking an LLM.",
          }),
        ),
        HttpApiEndpoint.post("reasoningClearPreview", KiloSessionPaths.reasoningClearPreview, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: ReasoningClearPreviewPayload,
          success: described(ReasoningClearPreviewResult, "Preview manual reasoning clear"),
          error: [ApiNotFoundError, ConflictError, SessionBusyError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.reasoningClearPreview",
            summary: "Preview reasoning clear",
            description: "Preview clearing historical unsigned reasoning without changing the session.",
          }),
        ),
        HttpApiEndpoint.post("reasoningClear", KiloSessionPaths.reasoningClear, {
          params: { sessionID: SessionID },
          query: WorkspaceRoutingQuery,
          payload: ReasoningClearPayload,
          success: described(ReasoningClearApplyResult, "Clear historical reasoning"),
          error: [ApiNotFoundError, ConflictError, SessionBusyError, ReasoningClearStalePreviewError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "session.reasoningClear",
            summary: "Clear reasoning",
            description: "Mark historical unsigned reasoning as cleared without invoking an LLM.",
          }),
        ),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "kilo HttpApi",
      version: "0.0.1",
      description: "Kilo HttpApi surface.",
    }),
  )
