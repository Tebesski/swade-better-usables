import {t as sbsI18n} from "./i18n.mjs";
import { DIALOG_CLASSES, MODULE_ID, loc } from "./data.mjs";
import { MANAGED, describeUse, rechargeablePools, rechargeUsable } from "./pools.mjs";
import { useSummary } from "./recipients.mjs";
import { getCoatingEffects } from "./coatings.mjs";

async function pickRecharge(item) {
  const pools = rechargeablePools(item);
  if (!pools.length) return;
  if (pools.length === 1) return rechargeUsable(item, { id: pools[0].id });
  const content = document.createElement("div");
  const select = document.createElement("select");
  select.name = sbsI18n("swade-better-usables.UI.pool_27cac55038");
  select.setAttribute("aria-label", loc("SBC.RechargePool"));
  select.add(new Option(loc("SBC.RechargeAll"), ""));
  for (const pool of pools) select.add(new Option(`${pool.name} (${pool.value}/${pool.max})`, pool.id));
  content.append(select);
  const selected = await foundry.applications.api.DialogV2.prompt({
    classes: DIALOG_CLASSES,
    window: { title: loc("SBC.RechargePool") },
    content,
    rejectClose: false,
    ok: { label: loc("SWADE.Recharge"), callback: (_event, button) => ({ id: button.form.elements.pool.value }) }
  });
  if (selected) return rechargeUsable(item, selected);
}

function rechargeControl(item) {
  const label = loc("SWADE.Recharge");
  const disabled = !item.isOwner || !rechargeablePools(item).length;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sbc-hud-recharge";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.disabled = disabled;
  const glyph = document.createElement("i");
  glyph.className = "fa-solid fa-rotate";
  glyph.setAttribute("aria-hidden", "true");
  button.append(glyph);
  button.addEventListener("click", async event => {
    event.stopPropagation();
    button.disabled = true;
    try {
      await pickRecharge(item);
    } catch (error) {
      ui.notifications.error(error.message, { console: true });
    } finally {
      button.disabled = disabled;
    }
  });
  return button;
}

function getShortcutControls(item) {
  const uses = MANAGED(item) ? item.system.charges.charges.map(use => describeUse(item, use)) : [];
  const canUse = uses.length ? uses.some(use => use.available) : (item.system.charges.default?.value ?? 0) >= 1;
  return {
    actions: [
      { key: "use", label: loc("SBC.Use"), icon: "fa-play", disabled: !item.isOwner || !canUse, execute: () => item.consume() },
      { key: "recharge", label: loc("SWADE.Recharge"), icon: "fa-rotate",
        disabled: !item.isOwner || !rechargeablePools(item).length, execute: () => pickRecharge(item) }
    ],
    summary: uses.length === 1 ? useSummary(uses[0]) : ""
  };
}

export function installHud() {
  game.modules.get(MODULE_ID).api = Object.freeze({ getShortcutControls, getCoatingEffects });
  const hud = game.modules.get("swade-hud")?.api;
  if (!hud?.inventoryItem) return;
  const nativeInventory = hud.inventoryItem;
  hud.inventoryItem = function (list, item) {
    const result = nativeInventory.call(this, list, item);
    if (item.type !== "consumable") return result;
    const play = list.lastElementChild?.querySelector("[data-action=consume]");
    if (!play) return result;
    play.after(rechargeControl(item));
    return result;
  };
}
