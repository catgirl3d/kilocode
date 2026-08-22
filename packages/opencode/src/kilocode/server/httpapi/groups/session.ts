// fork_change - new file
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { SessionID } from "@/session/schema"
import { Result as ShakeResult } from "@/kilocode/session/shake"
import { Authorization } from "@/server/routes/instance/httpapi/middleware/authorization"
import { InstanceContextMiddleware } from "@/server/routes/instance/httpapi/middleware/instance-context"
import {
  WorkspaceRoutingMiddleware,
  WorkspaceRoutingQuery,
} from "@/server/routes/instance/httpapi/middleware/workspace-routing"
import { ApiNotFoundError } from "@/server/routes/instance/httpapi/errors"
import { described } from "@/server/routes/instance/httpapi/groups/metadata"

const path = "/session/:sessionID/shake"

export const KiloSessionPaths = {
  shake: path,
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
