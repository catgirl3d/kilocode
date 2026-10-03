// fork_change - new file
import { Component, Show, createMemo, createSignal } from "solid-js"
import { Switch } from "@kilocode/kilo-ui/switch"
import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import { useProvider } from "../../context/provider"
import { parseModelString } from "../../../../src/shared/provider-model"
import { ModelSelectorBase } from "../shared/ModelSelector"
import { ThinkingSelectorBase } from "../shared/ThinkingSelector"
import { preserveVariant } from "../../context/session-variant-store"
import SettingsRow from "./SettingsRow"

const AdvisorSettingsSection: Component = () => {
  const { config, updateConfig } = useConfig()
  const language = useLanguage()
  const provider = useProvider()

  const [advisorForcedOn, setAdvisorForcedOn] = createSignal(false)
  const advisorEnabled = () => advisorForcedOn() || Boolean(config().experimental?.advisor_model)
  const advisorModel = createMemo(() => parseModelString(config().experimental?.advisor_model ?? undefined))
  const advisorVariants = createMemo(() => Object.keys(provider.findModel(advisorModel())?.variants ?? {}))
  const advisorVariant = createMemo(() => config().experimental?.advisor_variant ?? undefined)

  return (
    <>
      <SettingsRow
        title={language.t("settings.providers.advisor.title")}
        description={language.t("settings.providers.advisor.description")}
      >
        <Switch
          checked={advisorEnabled()}
          onChange={(checked: boolean) => {
            if (checked) {
              setAdvisorForcedOn(true)
              return
            }
            setAdvisorForcedOn(false)
            updateConfig({ experimental: { advisor_model: null, advisor_variant: null } })
          }}
          hideLabel
        >
          {language.t("settings.providers.advisor.title")}
        </Switch>
      </SettingsRow>
      <Show when={advisorEnabled()}>
        <SettingsRow
          title={language.t("settings.providers.advisorModel.title")}
          description={language.t("settings.providers.advisorModel.description")}
          class="settings-advisor-model-row"
        >
          <ModelSelectorBase
            value={advisorModel()}
            onSelect={(providerID, modelID) => {
              if (!providerID || !modelID) {
                setAdvisorForcedOn(false)
                updateConfig({ experimental: { advisor_model: null, advisor_variant: null } })
                return
              }
              const value = `${providerID}/${modelID}`
              const variants = Object.keys(provider.findModel({ providerID, modelID })?.variants ?? {})
              updateConfig({
                experimental: {
                  advisor_model: value,
                  advisor_variant: preserveVariant(advisorVariant(), variants) ?? null,
                },
              })
            }}
            placement="bottom-start"
            allowClear
            clearLabel={language.t("settings.providers.notSet")}
            label={language.t("settings.providers.advisorModel.title")}
            description={language.t("settings.providers.advisorModel.description")}
          />
          <Show when={advisorVariants().length > 0}>
            <ThinkingSelectorBase
              variants={advisorVariants()}
              value={advisorVariant()}
              onSelect={(value) => updateConfig({ experimental: { advisor_variant: value } })}
              onClear={() => updateConfig({ experimental: { advisor_variant: null } })}
              allowClear
              clearLabel={language.t("settings.providers.notSet")}
              placement="bottom-start"
              globalTrigger={false}
              label={language.t("prompt.thinking.tooltip")}
              triggerVariant="secondary"
              triggerSize="normal"
            />
          </Show>
        </SettingsRow>
      </Show>
    </>
  )
}

export default AdvisorSettingsSection
