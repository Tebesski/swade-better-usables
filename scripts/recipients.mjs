import {t as sbsI18n} from "./i18n.mjs";
import { DIALOG_CLASSES, EFFECT_TYPE, MODULE_ID, effectsAPI, loc, resolveEffect, useBehaviours } from "./data.mjs";
import { describeUse, SHARED } from "./pools.mjs";

const EFFECT_QUERY = `${MODULE_ID}.applyTargetEffects`;

function selectField(name, title, options) {
  const label = document.createElement("label");
  label.className = "form-group";
  const text = document.createElement("span");
  text.textContent = loc(title);
  const select = document.createElement("select");
  select.name = name;
  for (const [value, name] of options) select.add(new Option(name, value));
  label.append(text, select);
  return label;
}

export function useSummary(use) {
  if (!use.pool) return loc("SBC.Unmetered");
  const { value, max, id } = use.pool;
  return game.i18n.format("SBC.UseCost", {
    pool: loc(id === SHARED ? "SBC.SharedPool" : "SBC.SeparateCharges"), value, max, cost: use.cost
  });
}

export async function chooseActivation(item, { amount, useId, targets, items, coatingTarget }) {
  const choices = item.system.charges.charges.filter(use => !useId || use.id === useId)
    .map(use => describeUse(item, use, amount));
  const initial = choices.find(use => use.available);
  if (!initial && choices.length <= 1) {
    ui.notifications.warn("SWADE.Consumable.NotEnoughCharges", { localize: true });
    return null;
  }
  if (choices.length === 1 && !targets.size && !items && !coatingTarget) return { useId: initial.id, target: null };

  const content = document.createElement("div");
  if (coatingTarget) {
    const description = document.createElement("p");
    description.textContent = game.i18n.format("SBC.ConfirmCoating", { coating: item.name, item: coatingTarget.name });
    content.append(description);
  }
  if (choices.length > 1) {
    const list = document.createElement("fieldset");
    list.className = "sbc-use-choices";
    const legend = document.createElement("legend");
    legend.textContent = loc("SBC.Use");
    list.append(legend);
    for (const use of choices) {
      const row = document.createElement("label");
      const radio = document.createElement("input");
      Object.assign(radio, { type: "radio", name: sbsI18n("swade-better-usables.UI.use_a3b142af6e"), value: use.id, disabled: !use.available });
      radio.toggleAttribute("checked", use === initial);
      const details = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = use.name;
      const summary = document.createElement("small");
      summary.textContent = useSummary(use);
      details.append(name, summary);
      if (use.description) {
        const description = document.createElement("span");
        description.textContent = use.description;
        details.append(description);
      }
      row.append(radio, details);
      list.append(row);
    }
    content.append(list);
  }
  if (items) {
    content.append(selectField("recipient", "SBC.ApplyTo", Array.from(items, ([uuid, item]) => [uuid, item.name])));
  } else if (targets.size) {
    const self = game.i18n.format("SBC.Self", { name: item.actor.name });
    content.append(selectField("recipient", "SBC.ApplyTo", [["", self], ...Array.from(targets, ([uuid, token]) => [uuid, token.name])]));
  }
  return foundry.applications.api.DialogV2.prompt({
    classes: DIALOG_CLASSES,
    window: { title: loc(items || coatingTarget ? "SBC.ApplyCoating" : targets.size ? "SBC.Activate" : "SBC.ChooseUse") },
    content,
    rejectClose: false,
    ok: {
      label: loc(items || coatingTarget ? "SBC.ApplyCoating" : "SBC.Use"),
      callback: (_event, button) => {
        const selected = button.form.elements.use?.value || (choices.length === 1 ? initial.id : null);
        if (!choices.some(use => use.id === selected && use.available)) return null;
        const recipient = button.form.elements.recipient?.value;
        return { useId: selected, target: coatingTarget ?? (items ?? targets).get(recipient) ?? null };
      }
    }
  });
}

export function usableEffects(behaviours) {
  return behaviours.filter(entry => entry.type === "effect" && (entry.effectUuid || entry.effectSource?.length));
}

async function effectTemplate(item, behaviour, coating = false) {
  const { effectUuid, effectSource, duration, units } = behaviour;
  const linked = effectUuid ? await resolveEffect(effectUuid).catch(() => null) : null;
  if (linked && duration == null && !coating) return linked;
  const effects = linked ? linked.effects.map(effect => effect.toObject()) : foundry.utils.deepClone(effectSource ?? []);
  for (const effect of effects) {
    if (duration != null) effect.duration = { value: duration, units: units ?? "rounds", expiry: null };
    if (coating) {
      effect.flags ??= {};
      effect.flags[MODULE_ID] = { ...effect.flags[MODULE_ID], coating: true };
    }
  }
  return { type: EFFECT_TYPE, uuid: effectUuid ?? item.uuid, effects };
}

export async function applyEffects(item, useId, behaviours, target, gm) {
  if (gm) {
    const approved = await gm.query(EFFECT_QUERY, { itemUuid: item.uuid, useId, targetUuid: target.uuid }, { timeout: 60000 });
    if (!approved) ui.notifications.warn(game.i18n.format("SBC.EffectsDeclined", { target: target.name }));
    return;
  }
  const recipient = target?.documentName === "Item" ? target : target?.actor ?? item.actor;
  if (!recipient) throw new Error(loc("SBC.InvalidActingActor"));
  const coating = recipient.documentName === "Item";
  for (const behaviour of behaviours) {
    await effectsAPI().applyEffectTemplate(await effectTemplate(item, behaviour, coating), recipient);
  }
}

export function installRecipientEffects() {
  CONFIG.queries[EFFECT_QUERY] = async ({ itemUuid, useId, targetUuid }, { user, timeout }) => {
    if (!game.user.isGM) return false;
    const [item, token] = await Promise.all([foundry.utils.fromUuid(itemUuid), foundry.utils.fromUuid(targetUuid)]);
    if (item?.type !== "consumable" || !item.actor || !item.testUserPermission(user, "OWNER")
      || !item.system.charges.find(useId) || token?.documentName !== "Token" || !token.actor?.isOwner || token.hidden) return false;
    const templates = await Promise.all(usableEffects(Object.values(useBehaviours(item, useId))).map(entry => effectTemplate(item, entry)));
    if (!templates.length) return false;
    const content = document.createElement("div");
    const description = document.createElement("p");
    description.textContent = game.i18n.format("SBC.ApproveDescription", { user: user.name, item: item.name, target: token.name });
    const list = document.createElement("ul");
    for (const template of templates) {
      for (const effect of template.effects.contents ?? template.effects) {
        const row = document.createElement("li");
        row.textContent = effect.name;
        list.append(row);
      }
    }
    content.append(description, list);
    const expires = Date.now() + (timeout ?? 60000);
    const approved = await foundry.applications.api.DialogV2.confirm({
      classes: DIALOG_CLASSES,
      window: { title: loc("SBC.ApproveEffects") },
      content,
      rejectClose: false
    });
    if (!approved || Date.now() >= expires || !token.parent.tokens.has(token.id)) return false;
    for (const template of templates) await effectsAPI().applyEffectTemplate(template, token.actor);
    return true;
  };
}
