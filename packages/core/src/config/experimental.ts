export * as ConfigExperimental from "./experimental"

import { Schema } from "effect"
import { Catalog } from "../catalog"
import { Policy as PolicyV2 } from "../policy"

// Each core domain exports the policy actions it supports. Adding an action to
// this union makes it valid in authored config while keeping Policy generic.
export const PolicyAction = Schema.Union([Catalog.PolicyActions])

export class Policy extends Schema.Class<Policy>("ConfigV2.Experimental.Policy")({
  ...PolicyV2.Info.fields,
  action: PolicyAction,
}) {}

export class Experimental extends Schema.Class<Experimental>("ConfigV2.Experimental")({
  policies: Policy.pipe(Schema.Array, Schema.optional),
  // kilocode_change start
  advisor_model: Schema.String.pipe(Schema.optional).annotate({
    description: "Model ID to use for on-demand advisor consultations",
  }),
  advisor_variant: Schema.String.pipe(Schema.optional).annotate({
    description: "Model variant to use for on-demand advisor consultations",
  }),
  advisors: Schema.Struct({
    name: Schema.String.annotate({
      description: "Advisor slot ID passed in consult_advisor `advisors`, such as security",
    }),
    description: Schema.String.pipe(Schema.optional).annotate({
      description: "Short description shown to the main agent (up to 200 characters)",
    }),
    prompt: Schema.String.pipe(Schema.optional).annotate({
      description: "Role prompt sent only to this advisor (up to 20000 characters)",
    }),
    model: Schema.String.annotate({ description: "Model ID (provider/model) for this advisor" }),
    variant: Schema.String.pipe(Schema.optional).annotate({ description: "Model variant for this advisor" }),
  })
    .pipe(Schema.Array, Schema.optional)
    .annotate({
      description:
        "Up to three named advisor slots for on-demand consultations. When at least one slot is valid, advisor_model and advisor_variant are ignored",
    }),
  // kilocode_change end
}) {}
