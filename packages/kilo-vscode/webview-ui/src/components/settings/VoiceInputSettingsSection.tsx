// fork_change - new file
import { Component, Show, createMemo } from "solid-js"
import { Select } from "@kilocode/kilo-ui/select"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { Tooltip } from "@kilocode/kilo-ui/tooltip"
import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import { useProvider } from "../../context/provider"
import { useSpeechToTextModels } from "../../context/speech-to-text-models"
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
  hasCustomSpeechToTextSource,
} from "../speech-to-text/availability"
import { speechToTextModelOptions } from "../speech-to-text/model-selector"
import SettingsRow from "./SettingsRow"

const SPEECH_MODE_OPTIONS: Array<{ value: SpeechToTextMode; label: string }> = [
  { value: "transcribe", label: "settings.models.speechToTextResult.transcribe" },
  { value: "translate", label: "settings.models.speechToTextResult.translate" },
]

const VoiceInputSettingsSection: Component = () => {
  const { config, updateConfig, features } = useConfig()
  const language = useLanguage()
  const provider = useProvider()
  const speechModels = useSpeechToTextModels()

  const speechModel = createMemo(() => selectedSpeechToTextModel(config(), speechModels.models()))
  const speechOptions = createMemo(() => speechToTextModelOptions(speechModels.models()))
  const speechOption = createMemo(() => speechOptions().find((item) => item.value === speechModel()))
  const speechMode = createMemo(() => selectedSpeechToTextMode(config()))
  const speechModeOption = createMemo(() => SPEECH_MODE_OPTIONS.find((item) => item.value === speechMode()))
  const speechReady = createMemo(() => hasSpeechToTextAccess(config(), provider.authStates()))
  const customSpeech = createMemo(() => hasCustomSpeechToTextSource(config()))
  const speechConfigurable = createMemo(() => canConfigureSpeechToText(config(), provider.authStates()))
  function updateSpeech(patch: Record<string, string | null>) {
    updateConfig({ experimental: { ...config().experimental, ...patch } })
  }
  const speechTranslatable = createMemo(() => canTranslateSpeechToText(config()))

  return (
    <>
      <SettingsRow
        title={language.t("settings.models.speechToTextBaseUrl.title")}
        description={language.t("settings.models.speechToTextBaseUrl.description")}
      >
        <TextField
          value={config().experimental?.speech_to_text_base_url ?? ""}
          placeholder={language.t("settings.models.speechToTextBaseUrl.placeholder")}
          onChange={(value: string) => updateSpeech({ speech_to_text_base_url: value.trim() || null })}
        />
      </SettingsRow>
      <SettingsRow
        title={language.t("settings.models.speechToTextApiKey.title")}
        description={language.t("settings.models.speechToTextApiKey.description")}
      >
        <TextField
          type="password"
          value={config().experimental?.speech_to_text_api_key ?? ""}
          placeholder={language.t("settings.models.speechToTextApiKey.placeholder")}
          disabled={!customSpeech()}
          onChange={(value: string) => updateSpeech({ speech_to_text_api_key: value.trim() || null })}
        />
      </SettingsRow>
      <SettingsRow
        title={language.t("settings.models.speechToTextModel.title")}
        description={
          !features().speechToText
            ? language.t("settings.models.speechToText.remoteDescription")
            : customSpeech()
              ? language.t("settings.models.speechToTextModel.customDescription")
              : speechReady()
                ? language.t("settings.models.speechToTextModel.description")
                : language.t("settings.models.speechToText.disabledDescription")
        }
      >
        <Show
          when={!customSpeech()}
          fallback={
            <TextField
              value={config().experimental?.speech_to_text_model ?? ""}
              placeholder={language.t("settings.models.speechToTextModel.customPlaceholder")}
              onChange={(value: string) => updateSpeech({ speech_to_text_model: value.trim() || null })}
            />
          }
        >
          <Tooltip
            value={language.t("settings.models.speechToText.disabledDescription")}
            placement="top"
            inactive={speechConfigurable()}
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
        </Show>
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
    </>
  )
}

export default VoiceInputSettingsSection
