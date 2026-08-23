import { Component, For, Show, createMemo, createSignal } from "solid-js" // fork_change
import { Card } from "@kilocode/kilo-ui/card"
import { Select } from "@kilocode/kilo-ui/select"
import { Switch } from "@kilocode/kilo-ui/switch"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import { useProvider } from "../../context/provider"
import { useSession } from "../../context/session"
import { useSpeechToTextModels } from "../../context/speech-to-text-models"
import { parseModelString } from "../../../../src/shared/provider-model"
import { ModelSelectorBase } from "../shared/ModelSelector"
import { ThinkingSelectorBase } from "../shared/ThinkingSelector"
import SettingsRow from "./SettingsRow"
import {
  DEFAULT_SPEECH_TO_TEXT_MODEL,
  getSpeechToTextModel,
  type SpeechToTextMode,
} from "../../../../src/speech-to-text/models"
import {
  canConfigureSpeechToText,
  hasSpeechToTextAccess,
  canTranslateSpeechToText,
  selectedSpeechToTextModel,
  selectedSpeechToTextMode,
} from "../speech-to-text/availability"
import { speechToTextModelOptions } from "../speech-to-text/model-selector"
import { AUTOCOMPLETE_SELECTOR_MODELS, getAutocompleteSelection } from "./autocomplete-model-selector"
import { preserveVariant } from "../../context/session-variant-store"

const SPEECH_MODE_OPTIONS: Array<{ value: SpeechToTextMode; label: string }> = [
  { value: "transcribe", label: "settings.models.speechToTextResult.transcribe" },
  { value: "translate", label: "settings.models.speechToTextResult.translate" },
]
const ModelsTab: Component = () => {
  const { config, settings, updateConfig, updateSetting } = useConfig()
  const language = useLanguage()
  const provider = useProvider()
  const session = useSession()
  const speechModels = useSpeechToTextModels()

  const autocompleteProvider = () => {
    const v = settings()["autocomplete.provider"]
    return typeof v === "string" ? v : undefined
  }
  const autocompleteModel = () => {
    const v = settings()["autocomplete.model"]
    return typeof v === "string" ? v : undefined
  }

  function handleModelSelect(configKey: "model" | "small_model") {
    return (providerID: string, modelID: string) => {
      if (!providerID || !modelID) {
        updateConfig({ [configKey]: null })
        return
      }
      updateConfig({ [configKey]: `${providerID}/${modelID}` })
    }
  }

  const subagentModel = createMemo(() => parseModelString(config().subagent_model ?? undefined))
  // fork_change start
  const [advisorForcedOn, setAdvisorForcedOn] = createSignal(false)
  const advisorEnabled = () => advisorForcedOn() || Boolean(config().experimental?.advisor_model)
  // fork_change end
  const speechModel = createMemo(() => selectedSpeechToTextModel(config(), speechModels.models()))
  const speechOptions = createMemo(() => speechToTextModelOptions(speechModels.models()))
  const speechOption = createMemo(() => speechOptions().find((item) => item.value === speechModel()))
  const speechMode = createMemo(() => selectedSpeechToTextMode(config()))
  const speechModeOption = createMemo(() => SPEECH_MODE_OPTIONS.find((item) => item.value === speechMode()))
  const speechReady = createMemo(() => hasSpeechToTextAccess(config(), provider.authStates()))
  const speechConfigurable = createMemo(() => canConfigureSpeechToText(config(), provider.authStates()))
  const speechTranslatable = createMemo(() => canTranslateSpeechToText(config()))
  const variantKey = createMemo(() => config().subagent_model ?? undefined)
  const subagentVariants = createMemo(() => Object.keys(provider.findModel(subagentModel())?.variants ?? {}))
  const subagentVariant = createMemo(() => {
    const key = variantKey()
    if (!key) return undefined
    const value = config().subagent_variant_overrides?.[key]
    if (value) return value
    return config().subagent_model === key ? (config().subagent_variant ?? undefined) : undefined
  })

  function handleSubagentModelSelect(providerID: string, modelID: string) {
    if (!providerID || !modelID) {
      updateConfig({ subagent_model: null, subagent_variant: null })
      return
    }
    const value = `${providerID}/${modelID}`
    const list = Object.keys(provider.findModel({ providerID, modelID })?.variants ?? {})
    const next = preserveVariant(subagentVariant(), list)
    updateConfig({
      subagent_model: value,
      ...(config().subagent_model === value ? {} : { subagent_variant: null }),
      ...(next ? { subagent_variant_overrides: { ...config().subagent_variant_overrides, [value]: next } } : {}),
    })
  }

  function updateSubagentVariant(value: string | null) {
    const key = variantKey()
    if (!key) return
    updateConfig({
      subagent_variant_overrides: { [key]: value },
      ...(config().subagent_model === key ? { subagent_variant: null } : {}),
    })
  }

  const allAgents = createMemo(() => session.agents())

  function handleModeModelSelect(agentName: string) {
    return (providerID: string, modelID: string) => {
      if (!providerID || !modelID) {
        updateConfig({ agent: { [agentName]: { model: null } } })
        return
      }
      const current = config().agent?.[agentName]?.variant ?? undefined
      const list = Object.keys(provider.findModel({ providerID, modelID })?.variants ?? {})
      const next = preserveVariant(current, list)
      updateConfig({
        agent: {
          [agentName]: {
            model: `${providerID}/${modelID}`,
            ...(current && !list.includes(current) ? { variant: next ?? null } : {}),
          },
        },
      })
    }
  }

  function handleAutocompleteModelSelect(providerID: string, modelID: string) {
    if (!providerID || !modelID) {
      // Clearing both keys reverts to the resolved server-side default. Users
      // who pick "Not set" follow future default changes automatically.
      updateSetting("autocomplete.provider", null)
      updateSetting("autocomplete.model", null)
      return
    }
    updateSetting("autocomplete.provider", providerID)
    updateSetting("autocomplete.model", modelID)
  }

  return (
    <div>
      <Card>
        <SettingsRow
          title={language.t("settings.providers.defaultModel.title")}
          description={language.t("settings.providers.defaultModel.description")}
        >
          <ModelSelectorBase
            value={parseModelString(config().model ?? undefined)}
            onSelect={handleModelSelect("model")}
            placement="bottom-start"
            allowClear
            clearLabel={language.t("settings.providers.notSet")}
            label={language.t("settings.providers.defaultModel.title")}
            description={language.t("settings.providers.defaultModel.description")}
          />
        </SettingsRow>
        <SettingsRow
          title={language.t("settings.providers.smallModel.title")}
          description={language.t("settings.providers.smallModel.description")}
        >
          <ModelSelectorBase
            value={parseModelString(config().small_model ?? undefined)}
            onSelect={handleModelSelect("small_model")}
            placement="bottom-start"
            allowClear
            clearLabel={language.t("settings.providers.notSet")}
            includeAutoSmall
            label={language.t("settings.providers.smallModel.title")}
            description={language.t("settings.providers.smallModel.description")}
          />
        </SettingsRow>
        <SettingsRow
          title={language.t("settings.providers.subagentModel.title")}
          description={language.t("settings.providers.subagentModel.description")}
        >
          <div style={{ display: "flex", "flex-direction": "column", "align-items": "flex-end", gap: "8px" }}>
            <ModelSelectorBase
              value={subagentModel()}
              onSelect={handleSubagentModelSelect}
              placement="bottom-start"
              allowClear
              clearLabel={language.t("settings.providers.notSet")}
              label={language.t("settings.providers.subagentModel.title")}
              description={language.t("settings.providers.subagentModel.description")}
            />
            <Show when={subagentVariants().length > 0}>
              <ThinkingSelectorBase
                variants={subagentVariants()}
                value={subagentVariant()}
                onSelect={(value) => updateSubagentVariant(value)}
                onClear={() => updateSubagentVariant(null)}
                allowClear
                clearLabel={language.t("settings.providers.notSet")}
                placement="bottom-start"
                globalTrigger={false}
              />
            </Show>
          </div>
        </SettingsRow>
        {/* fork_change start */}
        <SettingsRow
          title={language.t("settings.providers.advisorModel.title")}
          description={language.t("settings.providers.advisorModel.description")}
        >
          <Switch
            checked={advisorEnabled()}
            onChange={(checked: boolean) => {
              if (checked) {
                setAdvisorForcedOn(true)
                return
              }
              setAdvisorForcedOn(false)
              updateConfig({
                experimental: { ...config().experimental, advisor_model: null },
              })
            }}
            hideLabel
          >
            {language.t("settings.providers.advisorModel.title")}
          </Switch>
        </SettingsRow>
        <Show when={advisorEnabled()}>
          <SettingsRow
            title={language.t("settings.providers.advisorModel.title")}
            description={language.t("settings.providers.advisorModel.description")}
          >
            <ModelSelectorBase
              value={parseModelString(config().experimental?.advisor_model ?? undefined)}
              onSelect={(providerID, modelID) =>
                updateConfig({
                  experimental: {
                    ...config().experimental,
                    advisor_model: providerID && modelID ? `${providerID}/${modelID}` : null,
                  },
                })
              }
              placement="bottom-start"
              allowClear
              clearLabel={language.t("settings.providers.notSet")}
              label={language.t("settings.providers.advisorModel.title")}
              description={language.t("settings.providers.advisorModel.description")}
            />
          </SettingsRow>
        </Show>
        {/* fork_change end */}
        <SettingsRow
          title={language.t("settings.autocomplete.model.title")}
          description={language.t("settings.autocomplete.model.description")}
        >
          <ModelSelectorBase
            value={getAutocompleteSelection(autocompleteProvider(), autocompleteModel())}
            onSelect={handleAutocompleteModelSelect}
            placement="bottom-start"
            models={AUTOCOMPLETE_SELECTOR_MODELS}
            favorites={false}
            allowClear
            clearLabel={language.t("settings.providers.notSet")}
            label={language.t("settings.autocomplete.model.title")}
            description={language.t("settings.autocomplete.model.description")}
          />
        </SettingsRow>
        <SettingsRow
          title={language.t("settings.models.speechToTextModel.title")}
          description={
            speechReady()
              ? language.t("settings.models.speechToTextModel.description")
              : language.t("settings.models.speechToText.disabledDescription")
          }
        >
          <Tooltip
            value={language.t("settings.models.speechToText.disabledDescription")}
            placement="top"
            inactive={speechReady()}
          >
            <Select
              options={speechOptions()}
              current={speechOption()}
              value={(item) => item.value}
              label={(item) => `${item.label} (${item.provider})`}
              onSelect={(item) => {
                const model = item?.value ?? DEFAULT_SPEECH_TO_TEXT_MODEL.id
                updateConfig({
                  experimental: {
                    ...config().experimental,
                    speech_to_text_model: model,
                    ...(getSpeechToTextModel(model).modes?.includes("translate")
                      ? {}
                      : { speech_to_text_mode: "transcribe" }),
                  },
                })
              }}
              variant="secondary"
              size="small"
              triggerVariant="settings"
              triggerProps={{
                "aria-label": `${language.t("settings.models.speechToTextModel.title")}: ${speechOption()?.label}`,
              }}
              disabled={!speechConfigurable()}
              placeholder={DEFAULT_SPEECH_TO_TEXT_MODEL.label}
            />
          </Tooltip>
        </SettingsRow>
        <Show when={speechTranslatable()}>
          <SettingsRow
            title={language.t("settings.models.speechToTextResult.title")}
            description={language.t("settings.models.speechToTextResult.description")}
          >
            <Select
              options={SPEECH_MODE_OPTIONS}
              current={speechModeOption()}
              value={(item) => item.value}
              label={(item) => language.t(item.label)}
              onSelect={(item) =>
                updateConfig({
                  experimental: {
                    ...config().experimental,
                    speech_to_text_mode: item?.value ?? "transcribe",
                  },
                })
              }
              variant="secondary"
              size="small"
              triggerVariant="settings"
              triggerProps={{
                "aria-label": `${language.t("settings.models.speechToTextResult.title")}: ${language.t(speechModeOption()?.label ?? "")}`,
              }}
              disabled={!speechReady()}
            />
          </SettingsRow>
        </Show>
        <SettingsRow
          title={language.t("settings.models.hidePromptTraining.title")}
          description={language.t("settings.models.hidePromptTraining.description")}
          last
        >
          <Switch
            checked={config().hide_prompt_training_models === true}
            onChange={(checked: boolean) => updateConfig({ hide_prompt_training_models: checked })}
            hideLabel
          >
            {language.t("settings.models.hidePromptTraining.title")}
          </Switch>
        </SettingsRow>
      </Card>

      <h4 style={{ "margin-top": "24px", "margin-bottom": "8px" }}>{language.t("settings.providers.modeModels")}</h4>
      <Card>
        <For each={allAgents()}>
          {(agent, index) => (
            <SettingsRow
              title={agent.name.charAt(0).toUpperCase() + agent.name.slice(1)}
              last={index() === allAgents().length - 1}
            >
              <ModelSelectorBase
                value={parseModelString(config().agent?.[agent.name]?.model ?? undefined)}
                onSelect={handleModeModelSelect(agent.name)}
                placement="bottom-start"
                allowClear
                clearLabel={language.t("settings.providers.notSet")}
                label={`${language.t("settings.providers.modeModels")}: ${agent.name}`}
                description={language.t("settings.providers.modeModels.description")}
              />
            </SettingsRow>
          )}
        </For>
      </Card>
    </div>
  )
}

export default ModelsTab
