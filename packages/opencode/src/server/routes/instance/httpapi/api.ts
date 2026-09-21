import { Schema } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { EventManifest } from "@/event-manifest"
import { Credential } from "@opencode-ai/core/credential"
import { Integration } from "@opencode-ai/core/integration"
import { SkillV2 } from "@opencode-ai/core/skill"
import { InstanceDisposed } from "@/server/event"
import { Question } from "@/question"
import { BusEvent } from "@/bus/bus-event" // kilocode_change - include legacy Kilo events until they migrate to EventV2
import { ConfigApi } from "./groups/config"
import { ControlApi } from "./groups/control"
import { ControlPlaneApi } from "./groups/control-plane"
import { EventApi } from "./groups/event"
import { ExperimentalApi } from "./groups/experimental"
import { FileApi } from "./groups/file"
import { InstanceApi } from "./groups/instance"
import { McpApi } from "./groups/mcp"
import { PermissionApi } from "./groups/permission"
import { ProjectApi } from "./groups/project"
import { ProjectCopyApi } from "./groups/project-copy"
import { ProviderApi } from "./groups/provider"
import { PtyApi, PtyConnectApi } from "./groups/pty"
import { QuestionApi } from "./groups/question"
import { SessionApi } from "./groups/session"
import { SyncApi } from "./groups/sync"
import { TuiApi } from "./groups/tui"
import { WorkspaceApi } from "./groups/workspace"
// kilocode_change start - Kilo HttpApi groups
import { AgentBuilderApi } from "@/kilocode/server/httpapi/groups/agent-builder"
import { BranchNameApi } from "@/kilocode/server/httpapi/groups/branch-name"
import { CommitMessageApi } from "@/kilocode/server/httpapi/groups/commit-message"
import { BackgroundProcessApi } from "@/kilocode/server/httpapi/groups/background-process"
import { ConfigConsoleApi } from "@/kilocode/server/httpapi/groups/config-console"
import { EnhancePromptApi } from "@/kilocode/server/httpapi/groups/enhance-prompt"
import { IndexingApi } from "@/kilocode/server/httpapi/groups/indexing"
import { InstanceReloadApi } from "@/kilocode/server/httpapi/groups/instance-reload"
import { KiloGatewayApi } from "@/kilocode/server/httpapi/groups/kilo-gateway"
import { KilocodeApi } from "@/kilocode/server/httpapi/groups/kilocode"
import { MigrateApi } from "@/kilocode/server/httpapi/groups/migrate"
import { NetworkApi } from "@/kilocode/server/httpapi/groups/network"
import { RemoteApi } from "@/kilocode/server/httpapi/groups/remote"
import { SandboxApi } from "@/kilocode/server/httpapi/groups/sandbox"
import { SessionImportApi } from "@/kilocode/server/httpapi/groups/session-import"
import { SuggestionApi } from "@/kilocode/server/httpapi/groups/suggestion"
import { TelemetryApi } from "@/kilocode/server/httpapi/groups/telemetry"
import { MemoryApi } from "@/kilocode/server/httpapi/groups/memory" // kilocode_change
// kilocode_change end
import { makeApi } from "@opencode-ai/protocol/api"
import { LocationMiddleware } from "@opencode-ai/server/location"
import { SessionLocationMiddleware } from "@opencode-ai/server/middleware/session-location"
import { GlobalApi } from "./groups/global"
import { Authorization } from "./middleware/authorization"
import { SchemaErrorMiddleware } from "./middleware/schema-error"

const EventSchema = Schema.Union([
  // kilocode_change start - [fork] single canonical payload per event type: BusEvent.effectPayloads()
  // already exposes the full manifest (with identifiers) plus legacy registry events. The separate
  // manifest map duplicated every event and produced Event*1 phantom schemas in generated SDK output.
  ...BusEvent.effectPayloads(),
  // kilocode_change end
  InstanceDisposed,
]).annotate({ identifier: "Event" }).pipe(Schema.toCodecJson) // kilocode_change - [fork] normalize Event union for spec-only AdditionalSchemas metadata so shared members dedupe instead of emitting *1 twins

export const ServerApi = makeApi({
  definitions: EventManifest.Latest.values().toArray(),
  locationMiddleware: LocationMiddleware,
  sessionLocationMiddleware: SessionLocationMiddleware,
})

export const RootHttpApi = HttpApi.make("opencode-root")
  .addHttpApi(ControlApi)
  .addHttpApi(ControlPlaneApi)
  .addHttpApi(GlobalApi)
  .middleware(SchemaErrorMiddleware)
  .middleware(Authorization)

export const InstanceHttpApi = HttpApi.make("opencode-instance")
  .addHttpApi(ConfigApi)
  .addHttpApi(ExperimentalApi)
  .addHttpApi(FileApi)
  .addHttpApi(InstanceApi)
  .addHttpApi(McpApi)
  .addHttpApi(ProjectApi)
  .addHttpApi(ProjectCopyApi)
  .addHttpApi(PtyApi)
  .addHttpApi(QuestionApi)
  .addHttpApi(PermissionApi)
  .addHttpApi(ProviderApi)
  .addHttpApi(SessionApi)
  .addHttpApi(SyncApi)
  .addHttpApi(TuiApi)
  .addHttpApi(WorkspaceApi)
  // kilocode_change start - Kilo HttpApi groups
  .addHttpApi(AgentBuilderApi)
  .addHttpApi(BackgroundProcessApi)
  .addHttpApi(BranchNameApi)
  .addHttpApi(CommitMessageApi)
  .addHttpApi(ConfigConsoleApi)
  .addHttpApi(EnhancePromptApi)
  .addHttpApi(IndexingApi)
  .addHttpApi(InstanceReloadApi)
  .addHttpApi(KiloGatewayApi)
  .addHttpApi(KilocodeApi)
  .addHttpApi(MigrateApi)
  .addHttpApi(NetworkApi)
  .addHttpApi(RemoteApi)
  .addHttpApi(SandboxApi)
  .addHttpApi(SessionImportApi)
  .addHttpApi(SuggestionApi)
  .addHttpApi(TelemetryApi)
  .addHttpApi(MemoryApi)
  // kilocode_change end
  .middleware(SchemaErrorMiddleware)

export const OpenCodeHttpApi = HttpApi.make("opencode")
  .addHttpApi(RootHttpApi)
  .addHttpApi(EventApi)
  .addHttpApi(InstanceHttpApi)
  .addHttpApi(ServerApi)
  .addHttpApi(PtyConnectApi)
  .annotate(HttpApi.AdditionalSchemas, [
    EventSchema,
    Question.Replied,
    Question.Rejected,
    Credential.Value,
    Integration.Inputs,
    Integration.Method,
    Integration.Ref,
    SkillV2.Source,
  ])

export type RootHttpApiType = typeof RootHttpApi
export type InstanceHttpApiType = typeof InstanceHttpApi
