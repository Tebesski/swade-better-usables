import { BEHAVIOURS, isCoating, loc, updateUsable, useBehaviours } from "./data.mjs";
import { MANAGED, chargeUpdates } from "./pools.mjs";
import { cleanNote, postMessage, postRequest, postRoll } from "./chat.mjs";
import { applyEffects, chooseActivation, usableEffects } from "./recipients.mjs";
import { playSound, soundForItem } from "./sound.mjs";
import { canCoat, coatingTargets } from "./coatings.mjs";
import { executeMacro } from "./macros.mjs";

const inUse = new WeakSet();

function reportError(item, label, error) {
  ui.notifications.error(game.i18n.format("SBC.BehaviourError", {
    item: item.name,
    behaviour: loc(label),
    error: error.message
  }), { console: true });
}

async function activate(item, use, amount, behaviours, { sound, target, effects, gm }) {
  if (sound) playSound(sound).catch(error => reportError(item, "SBC.SFX", error));

  const notes = behaviours.filter(entry => entry.type === "note").map(entry => cleanNote(entry.note)).filter(Boolean);
  const baseMessage = item.system.messageOnUse;
  let notesPosted = false;
  if (baseMessage) {
    const name = foundry.utils.escapeHTML(item.name);
    const useName = foundry.utils.escapeHTML(use.name);
    const text = MANAGED(item)
      ? game.i18n.format("SBC.UsesSpent", { name, charges: amount, use: useName })
      : game.i18n.format("SWADE.Consumable.ChargesUsed", { name, charges: amount });
    const recipient = target && game.i18n.format("SBC.AppliedTo", { target: foundry.utils.escapeHTML(target.name) });
    await postMessage(item.actor, recipient ? `${text}<p>${recipient}</p>` : text, notes);
    notesPosted = true;
  }
  if (effects.length) {
    try {
      await applyEffects(item, use.id, effects, target, gm);
    } catch (error) {
      reportError(item, "SBC.ApplyEffect", error);
    }
  }
  for (const behaviour of behaviours) {
    try {
      if (behaviour.type === "request" && behaviour.request) {
        await postRequest(item.actor, behaviour.request, baseMessage ? [] : notes);
        notesPosted = true;
      } else if (behaviour.type === "roll" && behaviour.formula) {
        await postRoll(item, behaviour, baseMessage ? [] : notes, target?.documentName === "Token" ? target : null);
        notesPosted = true;
      } else if (behaviour.type === "macro" && behaviour.macroUuid) {
        await executeMacro(behaviour.macroUuid, item, use, amount, target);
      }
    } catch (error) {
      reportError(item, BEHAVIOURS[behaviour.type], error);
    }
  }
  if (notes.length && !notesPosted) await postMessage(item.actor, "", notes);
}

export function installConsumption() {
  const prototype = CONFIG.Item.documentClass.prototype;
  const nativeConsume = prototype.consume;
  prototype.consume = async function (amount, ...args) {
    const item = this;
    if (item.type !== "consumable") return nativeConsume.call(item, amount ?? 1, ...args);
    const { charges } = item.system;
    if (!charges.default) return;
    const regular = MANAGED(item);
    const coating = isCoating(item);
    const targets = new Map();
    if (regular && !coating && item.actor && item.isOwner) {
      for (const token of game.user.targets) if (token.actor) targets.set(token.document.uuid, token.document);
    }
    const sound = soundForItem(item);
    if (!regular && !sound && !Object.keys(useBehaviours(item, charges.default.id)).length) {
      return nativeConsume.call(item, amount ?? 1, ...args);
    }
    if (amount != null) amount = Number(amount);
    if ((!item.isOwner || (amount != null && (!Number.isFinite(amount) || amount <= 0))) || inUse.has(item)) return;
    inUse.add(item);
    try {
      let coatingTarget, items;
      if (coating) {
        const uuid = args[0]?.coatingTarget;
        if (uuid) {
          coatingTarget = await foundry.utils.fromUuid(uuid);
          if (!canCoat(item, coatingTarget)) return ui.notifications.warn(loc("SBC.IneligibleCoatingTarget"));
        } else {
          items = coatingTargets(item);
          if (!items.size) return ui.notifications.warn(loc("SBC.NoCoatingTargets"));
        }
      }
      const activation = regular
        ? await chooseActivation(item, { amount, useId: amount == null ? undefined : charges.default.id, targets, items, coatingTarget })
        : { useId: charges.default.id, target: null };
      if (!activation) return;
      let { target } = activation;
      const use = item.system.charges.find(activation.useId);
      if (!use) return;
      const behaviours = Object.values(useBehaviours(item, use.id));
      const effects = usableEffects(behaviours);
      if (coating) {
        target = target && await foundry.utils.fromUuid(target.uuid);
        if (!canCoat(item, target)) return ui.notifications.warn(loc("SBC.IneligibleCoatingTarget"));
      } else if (target && (!target.actor || !target.parent.tokens.has(target.id))) {
        return ui.notifications.warn(loc("SBC.TargetUnavailable"));
      }
      const needsGM = !coating && effects.length && target && !target.actor.isOwner;
      const gm = needsGM ? game.users.activeGM : null;
      if (needsGM && !gm) return ui.notifications.warn(loc("SBC.NoTargetGM"));
      if (needsGM && !game.user.can("QUERY_USER")) return ui.notifications.warn(loc("SBC.CannotRequestEffects"));
      const usage = regular ? chargeUpdates(item, use, amount) : item.system.clone()._getUsageUpdates(amount ?? 1);
      if (!usage) {
        if (regular) ui.notifications.warn("SWADE.Consumable.NotEnoughCharges", { localize: true });
        return;
      }
      const spent = usage.cost ?? amount ?? 1;
      Hooks.call("swadePreConsumeItem", item, spent, usage);
      const { itemUpdates, actorUpdates, resourceUpdates } = usage;
      if (!foundry.utils.isEmpty(itemUpdates) && !await updateUsable(item, itemUpdates)) return;
      if (!foundry.utils.isEmpty(actorUpdates)) await item.actor?.update(actorUpdates);
      const updated = resourceUpdates.length ? await item.actor?.updateEmbeddedDocuments("Item", resourceUpdates) : [];
      Hooks.call("swadeConsumeItem", item, spent, usage);
      try {
        await activate(item, use, spent, behaviours, { sound, target, effects, gm });
      } finally {
        for (const resource of updated ?? []) if (resource.system._shouldDelete) await resource.delete();
        if (item.system._shouldDelete && item.actor?.items.has(item.id)) await item.delete();
      }
    } finally {
      inUse.delete(item);
    }
  };
}
