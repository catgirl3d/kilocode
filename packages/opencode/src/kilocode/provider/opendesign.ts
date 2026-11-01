// fork_change - new file
import type { Hooks } from "@kilocode/plugin"
import type { Provider } from "@opencode-ai/core/models-dev"
import { Schema } from "effect"

export const OPENDESIGN_ID = "opendesign"
export const OPENDESIGN_URL = "https://amr-link.open-design.ai/v1"

type Info = { type: string; metadata?: Record<string, string> } | undefined

export const CatalogProvider = {
  id: OPENDESIGN_ID,
  name: "OpenDesign",
  env: ["OPENDESIGN_API_KEY"],
  api: OPENDESIGN_URL,
  npm: "@ai-sdk/openai-compatible",
  models: {},
} satisfies Provider

type Model = Provider["models"][string]
type Modality = "text" | "audio" | "image" | "video" | "pdf"

// The openai-compatible SDK throws on video and on most audio formats, so only advertise input it can send.
const known: readonly Modality[] = ["text", "image", "pdf"]

// Optional fields also accept null, so one sparse entry cannot fail the whole model list.
export const OpenDesignItem = Schema.Struct({
  id: Schema.String,
  owned_by: Schema.optional(Schema.NullOr(Schema.String)),
  architecture: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        input_modalities: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
        output_modalities: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
      }),
    ),
  ),
  metadata: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        context_limit: Schema.optional(Schema.NullOr(Schema.Finite)),
        context_budget: Schema.optional(Schema.NullOr(Schema.Finite)),
        output_budget: Schema.optional(Schema.NullOr(Schema.Finite)),
      }),
    ),
  ),
})
export type OpenDesignItem = Schema.Schema.Type<typeof OpenDesignItem>

export const OpenDesignResponse = Schema.Struct({ data: Schema.optional(Schema.Array(OpenDesignItem)) })

// The gateway reports document input as "file", which the catalog calls "pdf".
function modalities(list: readonly string[] | null | undefined): Modality[] {
  const mapped = (list ?? []).map((item) => (item === "file" ? "pdf" : item))
  const found = known.filter((item) => mapped.includes(item))
  return found.length > 0 ? found : ["text"]
}

// Limits come from the gateway's model metadata. context_budget is the smaller, safer figure, so it wins over the
// full context_limit. An output of 0 lets the default output cap apply when the gateway reports none.
export function openDesignModel(item: OpenDesignItem): Model {
  const meta = item.metadata
  const input = modalities(item.architecture?.input_modalities)
  return {
    id: item.id,
    name: item.id,
    family: item.owned_by ?? "",
    release_date: "",
    attachment: input.some((mode) => mode !== "text"),
    reasoning: false,
    temperature: true,
    tool_call: true,
    cost: { input: 0, output: 0 },
    limit: { context: meta?.context_budget ?? meta?.context_limit ?? 128000, output: meta?.output_budget ?? 0 },
    modalities: { input, output: modalities(item.architecture?.output_modalities) },
  }
}

// The core catalog does not know OpenDesign, and its models only load after the user supplies a key,
// so add it to the provider list up front to make it connectable.
export function overlay(providers: Record<string, Provider>): Record<string, Provider> {
  if (providers[OPENDESIGN_ID]) return providers
  return { ...providers, [OPENDESIGN_ID]: CatalogProvider }
}

// Provider list entries are normally dropped while a provider has no models and is not connected.
export function listed(id: string) {
  return id === OPENDESIGN_ID
}

// Explicit config and env values win; the URL typed into the Connect dialog is stored as auth metadata.
// Without any of them the public OpenDesign endpoint is used.
export function opendesignURL(cfg: string | undefined, info: Info) {
  const saved = info?.type === "api" ? info.metadata?.baseURL : undefined
  return cfg || process.env.OPENDESIGN_BASE_URL || saved || OPENDESIGN_URL
}

// The Connect dialog offers the base URL next to the API key; leaving it empty keeps the default endpoint.
export async function OpenDesignAuthPlugin(): Promise<Hooks> {
  const prompts = process.env.OPENDESIGN_BASE_URL
    ? []
    : [
        {
          type: "text" as const,
          key: "baseURL",
          message: "OpenDesign API base URL (optional)",
          placeholder: OPENDESIGN_URL,
        },
      ]
  return {
    auth: {
      provider: OPENDESIGN_ID,
      methods: [{ type: "api", label: "API key", prompts }],
    },
  }
}
