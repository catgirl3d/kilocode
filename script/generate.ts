#!/usr/bin/env bun

import { $ } from "bun"

await $`bun ./packages/sdk/js/script/build.ts`

// kilocode_change start
const openapi = await $`bun dev generate`.cwd("packages/opencode").text()
await Bun.write("packages/sdk/openapi.json", openapi)
// kilocode_change end

await $`bun ./script/generate-cli-docs.ts`
