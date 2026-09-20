import type { Config } from "../src/client.js"

const config: Config = {
  experimental: {
    advisor_model: "provider/model",
    advisor_variant: "high",
  },
}

const invalid: Config = {
  experimental: {
    // @ts-expect-error advisor_model must be a string.
    advisor_model: false,
    // @ts-expect-error advisor_variant must be a string.
    advisor_variant: 3,
  },
}

void config
void invalid
