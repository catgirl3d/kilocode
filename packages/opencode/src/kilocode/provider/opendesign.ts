// fork_change - new file
import type { Hooks } from "@kilocode/plugin"
import type { Provider } from "@opencode-ai/core/models-dev"

export const OPENDESIGN_ID = "opendesign"

type Info = { type: string; metadata?: Record<string, string> } | undefined

export const CatalogProvider = {
  id: OPENDESIGN_ID,
  name: "OpenDesign",
  env: ["OPENDESIGN_API_KEY"],
  npm: "@ai-sdk/openai-compatible",
  models: {},
} satisfies Provider

// The core catalog does not know OpenDesign, and its models only load after the user supplies a key and base URL,
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
export function opendesignURL(cfg: string | undefined, info: Info) {
  return cfg ?? process.env.OPENDESIGN_BASE_URL ?? (info?.type === "api" ? info.metadata?.baseURL : undefined)
}

// OpenDesign has no default endpoint, so the Connect dialog collects the base URL together with the API key.
export async function OpenDesignAuthPlugin(): Promise<Hooks> {
  const prompts = process.env.OPENDESIGN_BASE_URL
    ? []
    : [
        {
          type: "text" as const,
          key: "baseURL",
          message: "Enter OpenDesign API base URL",
          placeholder: "e.g. https://api.example.com/v1",
        },
      ]
  return {
    auth: {
      provider: OPENDESIGN_ID,
      methods: [{ type: "api", label: "API key", prompts }],
    },
  }
}
