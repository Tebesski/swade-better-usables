import { loc } from "./data.mjs";

export async function resolveMacro(uuid) {
  const macro = uuid && await foundry.utils.fromUuid(uuid).catch(() => null);
  if (macro?.documentName !== "Macro") throw new Error(loc("SBC.MissingMacro"));
  return macro;
}

export function macroOptionResolver() {
  let options;
  const linked = new Map();
  return async uuid => {
    options ??= Object.fromEntries(game.macros.filter(macro => macro.canExecute)
      .sort((a, b) => a.name.localeCompare(b.name)).map(macro => [macro.uuid, macro.name]));
    if (!uuid || Object.hasOwn(options, uuid)) return options;
    if (!linked.has(uuid)) linked.set(uuid, resolveMacro(uuid).catch(() => null));
    const macro = await linked.get(uuid);
    return { ...options, [uuid]: macro?.name ?? loc("SBC.MissingMacro") };
  };
}

export async function executeMacro(uuid, item, use, charges, target) {
  const macro = await resolveMacro(uuid);
  if (!macro.canExecute) throw new Error(loc("SBC.MacroPermission"));
  const actor = item.actor ?? null;
  const targetToken = target?.documentName === "Token" ? target : null;
  const targetItem = target?.documentName === "Item" ? target : null;
  return macro.execute({
    actor,
    speaker: ChatMessage.getSpeaker({ actor }),
    item,
    use,
    charges,
    target: target ?? actor,
    targetActor: targetItem ? null : targetToken?.actor ?? actor,
    targetToken,
    targetItem
  });
}
