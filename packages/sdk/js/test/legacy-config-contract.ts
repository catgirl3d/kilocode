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

const slots: Config = {
  experimental: {
    advisors: [
      {
        name: "security",
        description: "finds vulnerabilities",
        prompt: "Review for injection and secret leaks.",
        model: "provider/model",
        variant: "high",
      },
      { name: "fast", model: "provider/fast" },
    ],
  },
}

const invalidSlots: Config = {
  experimental: {
    advisors: [
      {
        name: "security",
        // @ts-expect-error advisor slot model must be a string.
        model: 3,
      },
      // @ts-expect-error advisor slot model is required.
      { name: "fast" },
      {
        // @ts-expect-error advisor slot name must be a string.
        name: false,
        model: "provider/model",
      },
      {
        name: "deep",
        model: "provider/model",
        // @ts-expect-error advisor slot prompt must be a string.
        prompt: 1,
      },
    ],
  },
}

// @ts-expect-error advisors must be an array of slots.
const notArray: Config = { experimental: { advisors: "security" } }

void config
void invalid
void slots
void invalidSlots
void notArray
