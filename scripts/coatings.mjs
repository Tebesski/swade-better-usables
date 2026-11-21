import { EFFECTS_ID, EFFECT_TYPE, MODULE_ID, effectsAPI, isCoating, parseFlagGroups, usableFlags } from "./data.mjs";

export function getCoatingEffects(item) {
  if (item?.documentName !== "Item" || item.type === EFFECT_TYPE) return [];
  return item.effects.filter(effect => {
    if (!effect.active || effect.transfer || effect.duration.expired) return false;
    // Older coatings have Better Effects provenance on the applied item effect.
    return effect.getFlag(MODULE_ID, "coating") ??
      Boolean(effect.origin && effect.getFlag(EFFECTS_ID, "templateUuid") === effect.origin);
  });
}

function coatingGroups(coating) {
  return parseFlagGroups(usableFlags(coating).coatingFilter ?? "", "SBC.InvalidCoatingFilter");
}

export function canCoat(coating, item, groups = coatingGroups(coating)) {
  if (item?.documentName !== "Item" || item.uuid === coating.uuid || !item.isOwner || item.compendium?.locked) return false;
  if (!groups.length) return true;
  const api = effectsAPI();
  const flags = new Set([...api.getFlags(item), api.normalizeFlag(item.type)]);
  return groups.some(group => group.every(flag => flags.has(flag)));
}

export function coatingTargets(coating) {
  const groups = coatingGroups(coating);
  const items = coating.actor?.items ?? game.items;
  return new Map(items.filter(item => canCoat(coating, item, groups))
    .sort((a, b) => a.name.localeCompare(b.name)).map(item => [item.uuid, item]));
}

function dropTarget(element) {
  const grid = element.closest(".sgi-layout");
  if (grid) {
    const tile = element.closest("[data-sgi-item]");
    if (!tile) return;
    const { sbcCoatingActor, sbcCoatingTarget } = grid.closest("[data-sbc-coating-actor], [data-sbc-coating-target]")?.dataset ?? {};
    const actor = sbcCoatingActor ? foundry.utils.fromUuidSync(sbcCoatingActor)
      : sbcCoatingTarget ? foundry.utils.fromUuidSync(sbcCoatingTarget)?.actor : undefined;
    return actor?.items?.get(tile.dataset.sgiItem);
  }
  const row = element.closest("[data-item-id]");
  if (row) {
    const actorUuid = row.closest("[data-sbc-coating-actor]")?.dataset.sbcCoatingActor;
    const actor = actorUuid ? foundry.utils.fromUuidSync(actorUuid)
      : row.closest("#swade-hud-sidebar") && game.modules.get("swade-hud")?.api?.actor;
    const item = actor?.items?.get(row.dataset.itemId);
    if (item) return item;
  }
  const sheet = element.closest("[data-sbc-coating-target]");
  if (sheet) return foundry.utils.fromUuidSync(sheet.dataset.sbcCoatingTarget);
  const entry = element.closest(".directory-item.document.item[data-entry-id]");
  if (entry) return game.items.get(entry.dataset.entryId);
}

export function installCoatingDrops() {
  Hooks.on("renderApplicationV2", (app, html) => {
    if (app.document?.documentName === "Item") html.dataset.sbcCoatingTarget = app.document.uuid;
    if (app.document?.documentName === "Actor") html.dataset.sbcCoatingActor = app.document.uuid;
  });
  document.addEventListener("dragover", event => {
    if (event.dataTransfer?.types.includes("text/plain") && dropTarget(event.target)) event.preventDefault();
  }, { capture: true });
  const onDrop = event => {
    const data = foundry.applications.ux.TextEditor.implementation.getDragEventData(event);
    if (data?.type !== "Item" || typeof data.uuid !== "string") return;
    let coating;
    try {
      coating = foundry.utils.fromUuidSync(data.uuid);
    } catch {
      return;
    }
    if (!isCoating(coating) || !coating.isOwner || coating.compendium?.locked) return;
    const target = dropTarget(event.target);
    if (!target) return;
    if (coating.uuid === target.uuid && event.target.closest(".sgi-layout")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (coating.uuid === target.uuid) return;
    coating.consume(undefined, { coatingTarget: target.uuid })
      .catch(error => ui.notifications.error(error.message, { console: true }));
  };
  document.addEventListener("drop", onDrop, { capture: true });
  // Grid Inventory dispatches its own drop event for items picked up with the pointer.
  document.addEventListener("sgi-inventory-drop", onDrop, { capture: true });
}
