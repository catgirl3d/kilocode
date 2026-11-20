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

const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"]
const unsupported: Record<string, string> = {
  "glm-5.3-flashx": "medium",
  "kimi-k2.7-code": "max",
  "minimax-m3.1-flash": "none",
}

function efforts(id: string) {
  const skip = unsupported[id]
  return skip === undefined ? EFFORTS : EFFORTS.filter((effort) => effort !== skip)
}

// The gateway reports only a low/medium/high cost category, so price the models from the public catalog entries
// they map to. Values are USD per million tokens: input, output, cache read, cache write. Context tiers cover
// the models priced by input size: Claude Haiku 5.5 above 100K and GPT-6 Luna above 272K. DeepSeek V4 Flash
// uses the 0731 build price, matching the gateway's medium category, and Eco reuses the V4.1 Flash price
// because it has no separate entry.
const COSTS: Record<string, Model["cost"]> = {
  "claude-haiku-5.5": {
    input: 0.1,
    output: 0.5,
    cache_read: 0.01,
    cache_write: 0.125,
    tiers: [
      {
        input: 0.5,
        output: 2.5,
        cache_read: 0.05,
        cache_write: 0.625,
        tier: { type: "context", size: 100000 },
      },
    ],
  },
  "deepseek-v4-flash": { input: 0.44, output: 1.32, cache_read: 0.028 },
  "deepseek-v4-flash-vision-exp": { input: 0.44, output: 1.32, cache_read: 0.014 },
  "deepseek-v4-pro": { input: 1.6, output: 3.2, cache_read: 0.135 },
  "deepseek-v4.1-flash": { input: 0.3, output: 1.2, cache_read: 0.006 },
  "deepseek-v4.1-flash-eco": { input: 0.3, output: 1.2, cache_read: 0.006 },
  "glm-5.3-flash": { input: 0.15, output: 0.5, cache_read: 0.03 },
  "glm-5.3-flashx": { input: 0.37, output: 1.25, cache_read: 0.075 },
  "gpt-6-luna": {
    input: 0.1,
    output: 0.5,
    cache_read: 0.01,
    cache_write: 0.125,
    tiers: [
      {
        input: 0.2,
        output: 0.75,
        cache_read: 0.02,
        cache_write: 0.25,
        tier: { type: "context", size: 272000 },
      },
    ],
  },
  "hy4-preview": { input: 0.834, output: 2.501, cache_read: 0.042 },
  "kimi-k2.7-code": { input: 0.6, output: 3, cache_read: 0.12 },
  "mimo-v2.6-flash": { input: 0.1, output: 0.28, cache_read: 0.0028 },
  "mimo-v2.6-pro": { input: 0.435, output: 0.87, cache_read: 0.004 },
  "minimax-m3.1-flash": { input: 0.15, output: 0.6, cache_read: 0.015 },
}

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

// Limits come from the gateway's model metadata. context_limit is the model's full context window, while the
// gateway's context_budget is a narrower working budget, so the full window is advertised and the budget is only
// a fallback when context_limit is missing. An output of 0 lets the default output cap apply when the gateway
// reports none.
export function openDesignModel(item: OpenDesignItem): Model {
  const meta = item.metadata
  const input = modalities(item.architecture?.input_modalities)
  return {
    id: item.id,
    name: item.id,
    family: item.owned_by ?? "",
    release_date: "",
    attachment: input.some((mode) => mode !== "text"),
    reasoning: true,
    reasoning_options: [{ type: "effort", values: efforts(item.id) }],
    temperature: true,
    tool_call: true,
    cost: COSTS[item.id] ?? { input: 0, output: 0 },
    limit: { context: meta?.context_limit ?? meta?.context_budget ?? 128000, output: meta?.output_budget ?? 0 },
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
