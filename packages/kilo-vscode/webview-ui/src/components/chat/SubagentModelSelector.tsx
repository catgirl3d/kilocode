// fork_change - new file
import type { Component } from "solid-js"
import { showToast } from "@kilocode/kilo-ui/toast"
import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import { useProvider } from "../../context/provider"
import { useSession } from "../../context/session"
import { parseModelString } from "../../../../src/shared/provider-model"
import { ModelSelectorBase } from "../shared/ModelSelector"
import { subagentModelPatch } from "../shared/subagent-model"
import { pinned } from "../settings/workspace-models"

interface SubagentModelSelectorProps {
  blocked?: boolean
}

export const SubagentModelSelector: Component<SubagentModelSelectorProps> = (props) => {
  const cfg = useConfig()
  const language = useLanguage()
  const provider = useProvider()
  const session = useSession()
  const current = () => parseModelString(cfg.config().subagent_model ?? undefined)
  const hasOverrides = () =>
    session
      .allAgents()
      .some(
        (agent) =>
          (agent.mode === "subagent" || agent.mode === "all") && Boolean(cfg.config().agent?.[agent.name]?.model),
      )
  const experiment = () => cfg.config().experimental?.task_model_selection === true
  const title = () => language.t("settings.providers.subagentModel.title")
  const modelLabel = () => {
    const value = current()
    if (!value) return language.t("settings.providers.subagentModel.inherit")
    return provider.findModel(value)?.name ?? `${value.providerID}/${value.modelID}`
  }
  const hint = () =>
    [
      !current() ? language.t("settings.providers.subagentModel.inheritHint") : "",
      hasOverrides() ? language.t("settings.providers.subagentModel.overrides") : "",
      experiment() ? language.t("settings.providers.subagentModel.agentChoice") : "",
    ]
      .filter(Boolean)
      .join(" ")
  const tooltip = () => {
    const note = hint()
    return `${title()}: ${modelLabel()}${note ? ` ${note}` : ""}`
  }
  const fail = (message?: string) =>
    showToast({
      variant: "error",
      title: language.t("settings.providers.subagentModel.updateFailed"),
      description: message,
    })

  function select(providerID: string, modelID: string) {
    const variants = Object.keys(provider.findModel({ providerID, modelID })?.variants ?? {})
    const patch = subagentModelPatch(cfg.config(), providerID, modelID, variants)
    cfg.applyConfig(patch, pinned(cfg.projectConfig()) ? "project" : "global", fail)
  }

  const focus = () =>
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("focusPrompt", { detail: { restore: true } })))

  return (
    <ModelSelectorBase
      value={current()}
      onSelect={select}
      trigger="subagent-model"
      allowClear
      clearLabel={language.t("settings.providers.subagentModel.inherit")}
      label={title()}
      description={hint()}
      tooltip={tooltip()}
      icon="type-hierarchy-sub"
      triggerClass="subagent-model-selector-quick-open"
      compact
      blocked={props.blocked || cfg.applying() || cfg.saving() || cfg.blocked() || cfg.loading()}
      onPick={focus}
      onCancel={focus}
    />
  )
}
