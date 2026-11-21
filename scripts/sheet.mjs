import {t as sbsI18n} from "./i18n.mjs";
import {
  BEHAVIOURS, DIALOG_CLASSES, DURATION_UNITS, MODULE_ID, TEMPLATE, effectsAPI, flagPath, isCoating, loc, parseFlagGroups, resolveEffect,
  targetNumber, updateUsable, usableFlags, useBehaviours
} from "./data.mjs";
import { pickerPath, setSound } from "./sound.mjs";
import { macroOptions, resolveMacro } from "./macros.mjs";
import { MANAGED, SHARED, rechargeUsable, sharedPool, useConfig } from "./pools.mjs";

const openAccordions = new WeakMap();

function showError(error) {
  ui.notifications.error(error.message, { console: true });
}

async function noteEditor(item, note) {
  const content = document.createElement("div");
  const editor = foundry.applications.elements.HTMLProseMirrorElement.create({
    name: sbsI18n("swade-better-usables.UI.note_edb4656242"), value: note ?? "", height: 220, documentUUID: item.uuid
  });
  content.append(editor);
  return foundry.applications.api.DialogV2.prompt({
    classes: DIALOG_CLASSES,
    window: { title: loc("SBC.EditNote") },
    position: { width: 540 },
    content,
    rejectClose: false,
    ok: {
      label: loc("SBC.SaveNote"),
      callback: (_event, _button, dialog) => foundry.utils.cleanHTML(dialog.element.querySelector("prose-mirror").value)
    }
  });
}

async function addBehaviour(item, useId, open) {
  const content = document.createElement("div");
  const choices = document.createElement("select");
  choices.name = sbsI18n("swade-better-usables.UI.behaviour_aafe609f4f");
  choices.setAttribute("aria-label", loc("SBC.AddBehaviour"));
  for (const [type, label] of Object.entries(BEHAVIOURS)) choices.add(new Option(loc(label), type));
  content.append(choices);
  const type = await foundry.applications.api.DialogV2.prompt({
    classes: DIALOG_CLASSES,
    window: { title: loc("SBC.AddBehaviour") },
    content,
    rejectClose: false,
    ok: { label: loc("SBC.AddBehaviour"), callback: (_event, button) => button.form.elements.behaviour.value }
  });
  if (!type || !item.system.charges.find(useId)) return;
  const id = `b${foundry.utils.randomID()}`;
  open.add(`${useId}:${id}`);
  await updateUsable(item, { [`${flagPath}.uses.${useId}.${id}`]: { type } });
}

async function renderUse(app, charge, row, open) {
  const item = app.document;
  const entries = await Promise.all(Object.entries(useBehaviours(item, charge.id)).map(async ([id, stored]) => {
    const entry = {
      ...stored, id, open: open.has(`${charge.id}:${id}`), label: BEHAVIOURS[stored.type],
      isEffect: stored.type === "effect", isNote: stored.type === "note",
      isRequest: stored.type === "request", isRoll: stored.type === "roll", isMacro: stored.type === "macro"
    };
    if (entry.isMacro) entry.macros = await macroOptions(entry.macroUuid);
    if (stored.type === "effect") {
      const effect = stored.effectUuid
        ? await resolveEffect(stored.effectUuid).catch(() => null)
        : stored.effectSource?.[0];
      entry.effectName = effect?.name ?? stored.effectName;
      entry.effectImg = effect?.img ?? stored.effectImg;
      entry.missing = Boolean(stored.effectUuid && !effect);
    }
    if (stored.type === "note" && stored.note) {
      const content = document.createElement("template");
      content.innerHTML = stored.note;
      entry.preview = content.content.textContent.trim();
    }
    return entry;
  }));
  const html = await foundry.applications.handlebars.renderTemplate(`${TEMPLATE}/behaviours.hbs`, {
    entries,
    editable: app.isEditable,
    canBuild: Item.canUserCreate(game.user),
    canRequest: game.user.isGM,
    durationUnits: DURATION_UNITS
  });
  const fields = row.querySelector(".charge > .content");
  if (fields && MANAGED(item)) {
    const config = useConfig(item, charge.id);
    for (const field of [sbsI18n("swade-better-usables.UI.rechargeType_f2a84ce76c"), "value", sbsI18n("swade-better-usables.UI.rechargeAmount_dded3caebe")]) {
      if (!config.separate) fields.querySelector(`[name="charges.${charge.id}.${field}"]`)?.closest(".form-group")?.remove();
    }
    const recharge = fields.querySelector("[data-action=rechargeManual]");
    if (recharge) {
      delete recharge.dataset.action;
      recharge.dataset.sbcAction = "recharge-pool";
    }
    const settings = await foundry.applications.handlebars.renderTemplate(`${TEMPLATE}/use-fields.hbs`, {
      ...config, editable: app.isEditable
    });
    fields.querySelector(`[name="charges.${charge.id}.name"]`)?.closest(".form-group")?.insertAdjacentHTML("afterend", settings);
  }
  fields?.insertAdjacentHTML("beforeend", html);
  for (const accordion of row.querySelectorAll(".sbc-behaviour")) {
    accordion.addEventListener("toggle", () => {
      if (!accordion.isConnected) return;
      const key = `${charge.id}:${accordion.dataset.sbcBehaviour}`;
      if (accordion.open) open.add(key);
      else open.delete(key);
    });
  }
}

function bindEditor(app, html, open) {
  const item = app.document;
  const getEntry = element => {
    const useId = element.closest("[data-charge-id]")?.dataset.chargeId;
    const id = element.closest("[data-sbc-behaviour]")?.dataset.sbcBehaviour;
    const data = useBehaviours(item, useId)[id];
    return { useId, id, data, path: `${flagPath}.uses.${useId}.${id}` };
  };
  const updateEntry = ({ useId, id, path }, changes) => {
    if (!item.system.charges.find(useId) || !useBehaviours(item, useId)[id]) return;
    return updateUsable(item, Object.fromEntries(Object.entries(changes).map(([key, value]) => [`${path}.${key}`, value])));
  };

  html.addEventListener("click", async event => {
    const target = event.target.closest("[data-sbc-action]");
    if (!target) return;
    const action = target.dataset.sbcAction;
    const entry = getEntry(target);
    const { data, useId, id } = entry;
    if (!app.isEditable && action !== "open-effect") return;
    try {
      switch (action) {
        case "add-use": {
          const charges = item.system.charges.charges;
          await updateUsable(item, { "system.charges.charges": [...charges, {
            id: foundry.utils.randomID(8), sort: charges.length, name: loc("SBC.Use"), rechargeType: "finite"
          }] });
          break;
        }
        case "add-behaviour":
          await addBehaviour(item, useId, open);
          break;
        case "remove-behaviour":
          await updateUsable(item, { [`${flagPath}.uses.${useId}.-=${id}`]: null });
          open.delete(`${useId}:${id}`);
          break;
        case "open-effect":
          if (data?.effectUuid) {
            const effect = await resolveEffect(data.effectUuid);
            await effect.sheet.render({ force: true });
          }
          break;
        case "build-effect": {
          const source = await effectsAPI().editEffectSource(data?.effectUuid ? null : data?.effectSource?.[0], item.name);
          if (source) await updateEntry(entry, { effectUuid: null, effectSource: [source], effectName: null, effectImg: null });
          break;
        }
        case "clear-effect":
          await updateEntry(entry, { effectUuid: null, effectSource: null, effectName: null, effectImg: null });
          break;
        case "edit-note": {
          const note = await noteEditor(item, data?.note);
          if (typeof note === "string") await updateEntry(entry, { note });
          break;
        }
        case "configure-request": {
          const builder = await effectsAPI().configureRollRequest(data?.request ?? {
            trait: "", tn: 4, penalty: 0, flags: "", recipients: []
          }, async ({ recipients, ...request }) => {
            targetNumber(request.tn, item.actor);
            await updateEntry(entry, { request });
          }, { previewTargetNumber: formula => {
            try { return Number.isFinite(Number(formula)) ? "" : `= ${targetNumber(formula, item.actor)}`; }
            catch { return ""; }
          } });
          builder.element.classList.add("sbc-request-builder");
          break;
        }
        case "browse":
          new CONFIG.ux.FilePicker({
            type: "audio",
            current: pickerPath(usableFlags(item).sound ?? ""),
            callback: path => setSound(item, path).catch(showError)
          }).render({ force: true });
          break;
        case "recharge-pool":
          await rechargeUsable(item, { id: useId ?? SHARED });
          break;
        case "recharge-type":
          await rechargeUsable(item, { type: target.dataset.rechargeType });
          break;
      }
    } catch (error) {
      showError(error);
    }
  });

  html.addEventListener("change", async event => {
    const input = event.target;
    if (!app.isEditable) return;
    if (input.hasAttribute("data-sbc-subtype") || input.hasAttribute("data-sbc-coating-filter")) {
      event.stopPropagation();
      try {
        if (input.hasAttribute("data-sbc-subtype")) {
          const coating = input.value === "coating";
          await updateUsable(item, { "system.subtype": coating ? "regular" : input.value, [`${flagPath}.coating`]: coating });
        } else {
          const filter = input.value.trim();
          parseFlagGroups(filter, "SBC.InvalidCoatingFilter");
          await updateUsable(item, { [`${flagPath}.coatingFilter`]: filter });
        }
      } catch (error) {
        showError(error);
      }
      return;
    }
    const poolField = input.dataset.sbcPool;
    const useField = input.dataset.sbcUseField;
    if (poolField || useField) {
      event.stopPropagation();
      if (!input.reportValidity()) return;
      try {
        const value = input.type === "checkbox" ? input.checked : input.type === "number" ? input.valueAsNumber : input.value;
        if (useField) {
          const useId = getEntry(input).useId;
          await updateUsable(item, { [`${flagPath}.useConfig.${useId}.${useField}`]: value });
        } else if (poolField === "shared") {
          await updateUsable(item, { [`${flagPath}.shared`]: value });
        } else {
          const pool = sharedPool(item);
          if (!pool) return;
          const { id, name, sort, ...update } = pool;
          update[poolField] = value;
          if (poolField === "rechargeAmount" && value && !Roll.validate(value)) throw new Error(loc("SBC.InvalidFormula"));
          update.value = Math.min(update.max, update.value);
          await updateUsable(item, { [`${flagPath}.sharedPool`]: update });
        }
      } catch (error) {
        showError(error);
      }
      return;
    }
    const field = input.dataset.sbcField;
    if (!field) return;
    event.stopPropagation();
    let value = input.value.trim();
    try {
      if (field === "sound") return await setSound(item, value);
      if (field === "damage") value = input.checked;
      if (field === "duration") {
        if (!input.reportValidity()) return;
        value = value ? Number(value) : null;
      }
      if (field === "formula" && value && !Roll.validate(value)) throw new Error(loc("SBC.InvalidFormula"));
      await updateEntry(getEntry(input), { [field]: value });
    } catch (error) {
      showError(error);
    }
  });

  for (const type of ["dragover", "drop"]) {
    html.addEventListener(type, async event => {
      const target = event.target.closest("[data-sbc-drop]");
      if (!target || !app.isEditable) return;
      event.preventDefault();
      event.stopPropagation();
      if (type !== "drop") return;
      try {
        const entry = getEntry(target);
        const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
        if (target.dataset.sbcDrop === "macro") {
          const macro = await resolveMacro(data?.type === "Macro" ? data.uuid : null);
          if (!macro.canExecute) throw new Error(loc("SBC.MacroPermission"));
          await updateEntry(entry, { macroUuid: macro.uuid });
          return;
        }
        const effect = await resolveEffect(data?.type === "Item" ? data.uuid : null);
        await updateEntry(entry, {
          effectUuid: effect.uuid, effectSource: effect.effects.map(entry => entry.toObject()),
          effectName: effect.name, effectImg: effect.img
        });
      } catch (error) {
        showError(error);
      }
    }, { capture: true });
  }
}

async function renderConsumable(app, html, context) {
  const useButton = html.querySelector("button.use-consumable");
  if (useButton) {
    useButton.type = "button";
    useButton.dataset.action = "useConsumable";
  }

  const tab = html.querySelector('.sheet-body > section[data-tab="charges"]');
  if (!tab || tab.classList.contains("sbc-consumable")) return;
  tab.classList.add("sbc-consumable");
  const label = html.querySelector('.sheet-tabs [data-tab="charges"] span');
  if (label) label.textContent = loc("SBC.Usable");

  const add = tab.querySelector("button.add-charge");
  if (add) {
    delete add.dataset.action;
    add.dataset.sbcAction = "add-use";
    add.replaceChildren(add.querySelector("i"), ` ${loc("SBC.AddUse")}`);
    add.disabled = !app.isEditable;
  }

  const settings = document.createElement("div");
  settings.className = "sbc-settings";
  for (const name of [sbsI18n("swade-better-usables.UI.messageOnUse_a76951f266"), sbsI18n("swade-better-usables.UI.destroyOnEmpty_1a18ed44a8"), "subtype"]) {
    const group = html.querySelector(`[data-tab="properties"] [name="system.${name}"]`)?.closest(".form-group");
    if (!group) continue;
    group.querySelector(".notes")?.remove();
    settings.append(group);
  }
  tab.prepend(settings);
  const subtype = settings.querySelector('[name="system.subtype"]');
  if (subtype) {
    subtype.removeAttribute("name");
    subtype.setAttribute("data-sbc-subtype", "");
    subtype.add(new Option(loc("SBC.Coating"), sbsI18n("swade-better-usables.UI.coating_51446de343")));
    if (isCoating(app.document)) {
      subtype.value = "coating";
      subtype.closest(".form-group").insertAdjacentHTML("afterend",
        await foundry.applications.handlebars.renderTemplate(`${TEMPLATE}/coating-filter.hbs`, {
          value: usableFlags(app.document).coatingFilter, editable: app.isEditable
        }));
    }
  }
  if (MANAGED(app.document)) {
    const pool = sharedPool(app.document);
    const sidebarCharges = html.querySelector(".sheet-sidebar .charge-field")?.closest(".form-group");
    if (!pool) sidebarCharges?.remove();
    else if (sidebarCharges) {
      for (const input of sidebarCharges.querySelectorAll(".charge-field")) {
        input.classList.remove("charge-field");
        input.dataset.sbcPool = input.dataset.name;
        input.value = pool[input.dataset.name];
        input.min = input.dataset.name === "max" ? 1 : 0;
        input.required = true;
      }
    }
    const timed = new Set(app.document.system.charges.charges
      .filter(use => useConfig(app.document, use.id).separate).map(use => use.rechargeType));
    if (pool) timed.add(pool.rechargeType);
    tab.querySelectorAll(".charge-recharge-day, .charge-recharge-encounter").forEach(button => button.remove());
    settings.insertAdjacentHTML("beforeend", await foundry.applications.handlebars.renderTemplate(`${TEMPLATE}/shared-pool.hbs`, {
      pool, editable: app.isEditable, chargeRechargeTypes: context.chargeRechargeTypes,
      canRecharge: pool && pool.rechargeType !== "finite",
      encounter: timed.has("encounter"), day: timed.has("day")
    }));
  }

  if (!openAccordions.has(app)) openAccordions.set(app, new Set());
  const open = openAccordions.get(app);
  bindEditor(app, html, open);
  try {
    await Promise.all([
      ...app.document.system.charges.charges.map(charge => {
        const row = [...tab.querySelectorAll(".charges-list > li")].find(row => row.dataset.chargeId === charge.id);
        return row && renderUse(app, charge, row, open);
      }),
      foundry.applications.handlebars.renderTemplate(`${TEMPLATE}/sound.hbs`, {
        editable: app.isEditable,
        canBrowse: game.user.can("FILES_BROWSE"),
        path: usableFlags(app.document).sound,
        id: `${app.id}-sbc-sfx`
      }).then(sound => tab.insertAdjacentHTML("beforeend", sound))
    ]);
  } catch (error) {
    showError(error);
  }
}

export function installConsumableSheet() {
  const sheet = game.swade.sheets.SwadeItemSheetV2.prototype;
  const renderHTML = sheet._renderHTML;
  const firstRender = sheet._onFirstRender;
  sheet._renderHTML = async function (...args) {
    const parts = await renderHTML.apply(this, args);
    // Foundry restores the tab's scroll as soon as it replaces the sheet part.
    if (this.document.type === "consumable" && parts.consumable) {
      await renderConsumable(this, parts.consumable, args[0]);
    }
    return parts;
  };
  sheet._onFirstRender = async function (...args) {
    await firstRender.apply(this, args);
    const open = openAccordions.get(this);
    if (!open) return;
    for (const accordion of this.element.querySelectorAll(".sbc-behaviour")) {
      const useId = accordion.closest("[data-charge-id]").dataset.chargeId;
      accordion.open = open.has(`${useId}:${accordion.dataset.sbcBehaviour}`);
    }
  };
}
