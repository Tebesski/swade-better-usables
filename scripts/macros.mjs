import { loc } from "./data.mjs";

export async function resolveMacro(uuid) {
  const macro = uuid && await foundry.utils.fromUuid(uuid).catch(() => null);
  if (macro?.documentName !== "Macro") throw new Error(loc("SBC.MissingMacro"));
  return macro;
}

export async function macroOptions(uuid) {
  const macros = game.macros.filter(macro => macro.canExecute);
  const options = Object.fromEntries(macros.sort((a, b) => a.name.localeCompare(b.name))
    .map(macro => [macro.uuid, macro.name]));
  if (uuid && !Object.hasOwn(options, uuid)) {
    options[uuid] = (await resolveMacro(uuid).catch(() => null))?.name ?? loc("SBC.MissingMacro");
  }
  return options;
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
