import type { Config } from "../src/client.js"

const config: Config = {
  experimental: {
    advisor_model: "provider/model",
  },
}

const invalid: Config = {
  experimental: {
    // @ts-expect-error advisor_model must be a string.
    advisor_model: false,
  },
}

void config
void invalid
