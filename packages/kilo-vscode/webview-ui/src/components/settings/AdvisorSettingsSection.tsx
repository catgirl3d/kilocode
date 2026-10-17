// fork_change - new file
import { Component, For, Show, createEffect, createMemo, on } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@kilocode/kilo-ui/button"
import { Collapsible } from "@kilocode/kilo-ui/collapsible"
import { DropdownMenu } from "@kilocode/kilo-ui/dropdown-menu"
import { IconButton } from "@kilocode/kilo-ui/icon-button"
import { Switch } from "@kilocode/kilo-ui/switch"
import { Tag } from "@kilocode/kilo-ui/tag"
import { TextField } from "@kilocode/kilo-ui/text-field"
import { useConfig } from "../../context/config"
import { useLanguage } from "../../context/language"
import { useProvider } from "../../context/provider"
import type { AdvisorSlot, ExperimentalConfig } from "../../types/messages"
import { parseModelString } from "../../../../src/shared/provider-model"
import { ModelSelectorBase } from "../shared/ModelSelector"
import { ThinkingSelectorBase } from "../shared/ThinkingSelector"
import { preserveVariant } from "../../context/session-variant-store"
import SettingsRow from "./SettingsRow"
import { TEMPLATES } from "./advisor-templates"

const LIMIT = 3
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/

interface Row {
  name: string
  description: string
  prompt: string
  model: string
  variant: string
  customize: boolean
}

/** Slots the backend uses: `advisors` when set, otherwise the legacy single advisor. */
function slots(exp: ExperimentalConfig | undefined): AdvisorSlot[] {
  const list = exp?.advisors ?? []
  if (list.length > 0) return list
  if (!exp?.advisor_model) return []
  return [{ name: "advisor", model: exp.advisor_model, variant: exp.advisor_variant ?? undefined }]
}

/** Config entry with a fixed key order and no empty optional fields. */
function entry(slot: AdvisorSlot): AdvisorSlot {
  const description = slot.description?.trim().slice(0, 200)
  const prompt = slot.prompt?.trim().slice(0, 20000)
  return {
    name: slot.name,
    ...(description ? { description } : {}),
    ...(prompt ? { prompt } : {}),
    model: slot.model,
    ...(slot.variant ? { variant: slot.variant } : {}),
  }
}

/** Editable row state; empty strings stand for unset fields. */
function row(slot?: AdvisorSlot): Row {
  return {
    name: slot?.name ?? "",
    description: slot?.description ?? "",
    prompt: slot?.prompt ?? "",
    model: slot?.model ?? "",
    variant: slot?.variant ?? "",
    customize: !slot || !slot.name || !!slot.description?.trim() || !!slot.prompt?.trim(),
  }
}

function slug(value: string) {
  return value.toLowerCase().replace(/\s+/g, "-")
}

const AdvisorSettingsSection: Component = () => {
  const { config, discarded, updateConfig } = useConfig()
  const language = useLanguage()
  const provider = useProvider()

  const seed = () => slots(config().experimental).map(row)

  const [rows, setRows] = createStore<Row[]>(seed())
  const source = createMemo(() => JSON.stringify(slots(config().experimental).map(entry)))

  const problem = (index: number) => {
    const item = rows[index]
    if (!item?.name) return "settings.providers.advisors.error.empty"
    if (!NAME.test(item.name)) return "settings.providers.advisors.error.format"
    // Only rows with a model can claim a name, so a draft never evicts a saved slot.
    const taken = rows.some(
      (other, position) =>
        position !== index && other.name === item.name && !!other.model && (!item.model || position < index),
    )
    if (taken) return "settings.providers.advisors.error.duplicate"
  }
  // Only the first slot may rely on the built-in role; later slots need their own description and role prompt.
  const need = (index: number, key: "description" | "prompt") => index > 0 && !rows[index]?.[key].trim()
  const gap = (index: number) => need(index, "description") || need(index, "prompt")
  const blocked = (index: number) => !!problem(index) || gap(index)
  // Moving an incomplete first slot down would make it unsaveable and silently drop it from the config.
  const locked = () => !rows[0]?.description.trim() || !rows[0]?.prompt.trim()
  const valid = () => rows.filter((item, index) => item.model && !blocked(index)).map(entry)

  // Reload from config only when it no longer matches what this section wrote,
  // so discards and server pushes apply without dropping unsaved draft rows.
  let revision = discarded()
  createEffect(
    on([source, discarded], ([value, current]) => {
      const reset = current !== revision
      revision = current
      if (!reset && value === JSON.stringify(valid())) return
      setRows(seed())
    }),
  )

  function disable() {
    updateConfig({ experimental: { advisors: null, advisor_model: null, advisor_variant: null } })
  }

  function commit() {
    const list = valid()
    if (JSON.stringify(list) === source()) return
    if (list.length === 0) {
      disable()
      return
    }
    updateConfig({ experimental: { advisors: list, advisor_model: null, advisor_variant: null } })
  }

  function toggle(checked: boolean) {
    if (checked) {
      setRows([{ ...row(), name: "advisor", customize: false }])
      return
    }
    setRows([])
    if (source() !== "[]") disable()
  }

  function remove(index: number) {
    setRows((list) => list.filter((_, position) => position !== index))
    commit()
  }

  function up(index: number) {
    if (index === 1 && locked()) return
    setRows((list) => [...list.slice(0, index - 1), list[index], list[index - 1], ...list.slice(index + 1)])
    commit()
  }

  function apply(index: number, template: (typeof TEMPLATES)[number]) {
    const current = rows[index]?.name ?? ""
    const taken = rows.some((item, position) => position !== index && item.name === template.name)
    const name = current || taken ? current : template.name
    setRows(index, { name, description: template.description, prompt: template.prompt, customize: true })
    commit()
  }

  function select(index: number, providerID: string, modelID: string) {
    if (!providerID || !modelID) return
    const variants = Object.keys(provider.findModel({ providerID, modelID })?.variants ?? {})
    const variant = preserveVariant(rows[index]?.variant || undefined, variants) ?? ""
    setRows(index, { model: `${providerID}/${modelID}`, variant })
    commit()
  }

  return (
    <>
      <SettingsRow
        title={language.t("settings.providers.advisor.title")}
        description={language.t("settings.providers.advisor.description")}
      >
        <Switch checked={rows.length > 0} onChange={toggle} hideLabel>
          {language.t("settings.providers.advisor.title")}
        </Switch>
      </SettingsRow>
      <Show when={rows.length > 0}>
        <div class="settings-advisor-slots">
          <For each={rows}>
            {(item, index) => {
              const variants = createMemo(() =>
                Object.keys(provider.findModel(parseModelString(item.model))?.variants ?? {}),
              )
              const error = () => {
                const key = problem(index())
                return key ? language.t(key) : undefined
              }
              return (
                <div class="settings-advisor-slot">
                  <div class="settings-advisor-slot-header">
                    <div class="settings-advisor-slot-heading">
                      <div class="settings-advisor-slot-name">
                        <span class="settings-advisor-slot-title">
                          {item.name || language.t("settings.providers.advisors.new")}
                        </span>
                        <Show when={index() === 0}>
                          <Tag>{language.t("settings.providers.advisors.default")}</Tag>
                        </Show>
                      </div>
                      <div class="settings-advisor-slot-role">
                        {language.t(
                          item.prompt.trim()
                            ? "settings.providers.advisors.role.custom"
                            : need(index(), "prompt")
                              ? "settings.providers.advisors.role.missing"
                              : "settings.providers.advisors.role.standard",
                        )}
                      </div>
                    </div>
                    <div class="settings-advisor-slot-actions">
                      <DropdownMenu gutter={4} placement="bottom-end">
                        <DropdownMenu.Trigger as={Button} variant="ghost" size="small" icon="prompt">
                          {language.t("settings.providers.advisors.template")}
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                          <DropdownMenu.Content class="settings-advisor-template-menu">
                            <For each={TEMPLATES}>
                              {(template) => (
                                <DropdownMenu.Item onSelect={() => apply(index(), template)}>
                                  <span class="settings-advisor-template-text">
                                    <DropdownMenu.ItemLabel>{template.label}</DropdownMenu.ItemLabel>
                                    <DropdownMenu.ItemDescription>{template.description}</DropdownMenu.ItemDescription>
                                  </span>
                                </DropdownMenu.Item>
                              )}
                            </For>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu>
                      <Show when={index() > 0}>
                        <IconButton
                          icon="arrow-up"
                          variant="ghost"
                          size="small"
                          disabled={index() === 1 && locked()}
                          aria-label={language.t("settings.providers.advisors.moveUp")}
                          title={language.t(
                            index() === 1 && locked()
                              ? "settings.providers.advisors.moveUp.locked"
                              : "settings.providers.advisors.moveUp",
                          )}
                          onClick={() => up(index())}
                        />
                      </Show>
                      <IconButton
                        icon="trash"
                        variant="ghost"
                        size="small"
                        aria-label={language.t("settings.providers.advisors.remove")}
                        title={language.t("settings.providers.advisors.remove")}
                        onClick={() => remove(index())}
                      />
                    </div>
                  </div>
                  <div class="settings-advisor-slot-body">
                    <div class="settings-advisor-slot-model">
                      <div class="settings-advisor-slot-field" data-field="model">
                        <span class="settings-advisor-slot-label" aria-hidden="true">
                          {language.t("settings.providers.advisors.model")}
                        </span>
                        <ModelSelectorBase
                          value={parseModelString(item.model)}
                          onSelect={(providerID, modelID) => select(index(), providerID, modelID)}
                          placement="bottom-start"
                          label={language.t("settings.providers.advisorModel.title")}
                          description={language.t("settings.providers.advisorModel.description")}
                        />
                      </div>
                      <Show when={variants().length > 0}>
                        <div class="settings-advisor-slot-field" data-field="thinking">
                          <span class="settings-advisor-slot-label" aria-hidden="true">
                            {language.t("prompt.thinking.tooltip")}
                          </span>
                          <ThinkingSelectorBase
                            variants={variants()}
                            value={item.variant || undefined}
                            onSelect={(value) => {
                              setRows(index(), "variant", value)
                              commit()
                            }}
                            onClear={() => {
                              setRows(index(), "variant", "")
                              commit()
                            }}
                            allowClear
                            clearLabel={language.t("common.default")}
                            placement="bottom-start"
                            globalTrigger={false}
                            label={language.t("prompt.thinking.tooltip")}
                            triggerVariant="secondary"
                            triggerSize="normal"
                          />
                        </div>
                      </Show>
                    </div>
                    <Show when={!item.model}>
                      <div class="settings-advisor-slot-hint">
                        {language.t("settings.providers.advisors.error.model")}
                      </div>
                    </Show>
                  </div>
                  <Collapsible
                    class="settings-advisor-slot-disclosure"
                    variant="ghost"
                    open={item.customize || blocked(index())}
                    onOpenChange={(value) => {
                      if (!value && blocked(index())) return
                      setRows(index(), "customize", value)
                    }}
                  >
                    <Collapsible.Trigger class="settings-advisor-slot-customize">
                      {language.t("settings.providers.advisors.customize")}
                      <Collapsible.Arrow />
                    </Collapsible.Trigger>
                    <Collapsible.Content class="settings-advisor-slot-customization">
                      <div class="settings-advisor-slot-fields">
                        <TextField
                          label={language.t("settings.providers.advisors.name")}
                          placeholder={language.t("settings.providers.advisors.name.placeholder")}
                          value={item.name}
                          maxLength={32}
                          spellcheck={false}
                          validationState={error() ? "invalid" : "valid"}
                          error={error()}
                          onChange={(value) => {
                            setRows(index(), {
                              name: slug(value),
                              customize: item.customize || !!problem(index()),
                            })
                            commit()
                          }}
                        />
                        <TextField
                          label={language.t(
                            index() > 0
                              ? "settings.providers.advisors.summary.required"
                              : "settings.providers.advisors.summary",
                          )}
                          placeholder={language.t("settings.providers.advisors.summary.placeholder")}
                          value={item.description}
                          maxLength={200}
                          required={index() > 0}
                          validationState={need(index(), "description") ? "invalid" : "valid"}
                          error={
                            need(index(), "description")
                              ? language.t("settings.providers.advisors.error.summary")
                              : undefined
                          }
                          onChange={(value) => {
                            // Typing proves the disclosure is open; keep it open once the last required field is filled.
                            setRows(index(), { description: value, customize: true })
                            commit()
                          }}
                        />
                      </div>
                      <TextField
                        label={language.t(
                          index() > 0
                            ? "settings.providers.advisors.prompt.required"
                            : "settings.providers.advisors.prompt",
                        )}
                        placeholder={language.t(
                          index() > 0
                            ? "settings.providers.advisors.prompt.placeholder.required"
                            : "settings.providers.advisors.prompt.placeholder",
                        )}
                        description={
                          item.prompt.trim() || index() > 0
                            ? undefined
                            : language.t("settings.providers.advisors.prompt.description")
                        }
                        value={item.prompt}
                        maxLength={20000}
                        multiline
                        required={index() > 0}
                        validationState={need(index(), "prompt") ? "invalid" : "valid"}
                        error={
                          need(index(), "prompt") ? language.t("settings.providers.advisors.error.prompt") : undefined
                        }
                        onChange={(value) => setRows(index(), { prompt: value, customize: true })}
                        onBlur={() => commit()}
                      />
                    </Collapsible.Content>
                  </Collapsible>
                </div>
              )
            }}
          </For>
          <Show when={rows.length < LIMIT}>
            <Button
              class="settings-advisor-add"
              variant="secondary"
              size="small"
              icon="plus"
              onClick={() => setRows(rows.length, row())}
            >
              {language.t("settings.providers.advisors.add")}
            </Button>
          </Show>
        </div>
      </Show>
    </>
  )
}

export default AdvisorSettingsSection
