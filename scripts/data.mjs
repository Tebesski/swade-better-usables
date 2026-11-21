export const MODULE_ID = "swade-better-usables";
export const LEGACY_ID = "swade-better-consumables";
export const EFFECTS_ID = "swade-better-effects";
export const EFFECT_TYPE = `${EFFECTS_ID}.effect`;
export const TEMPLATE = `modules/${MODULE_ID}/templates`;
export const BEHAVIOURS = {
  effect: "SBC.ApplyEffect",
  note: "SBC.Note",
  request: "SBC.RequestRoll",
  roll: "SBC.Roll",
  macro: "SBC.ExecuteMacro"
};
export const DURATION_UNITS = { rounds: "SBC.Rounds", minutes: "SBC.Minutes", hours: "SBC.Hours" };
export const DIALOG_CLASSES = ["swade", "swade-application", "sbs-standard-swade-sheet", "sbc-dialog"];

export const effectsAPI = () => game.modules.get(EFFECTS_ID).api;
export const loc = key => game.i18n.localize(key);
export const flagPath = `flags.${MODULE_ID}`;
export const usableFlags = document => document.flags?.[MODULE_ID] ?? document.flags?.[LEGACY_ID] ?? {};
export const isCoating = item => item?.type === "consumable" && item.system?.subtype === "regular" && usableFlags(item).coating === true;

export function parseFlagGroups(expression, errorKey) {
  if (!expression.trim()) return [];
  const normalize = effectsAPI().normalizeFlag;
  const groups = expression.split(";").map(group => group.split(",").map(flag => normalize(flag)));
  if (groups.some(group => group.some(flag => !flag))) throw new Error(loc(errorKey));
  return groups;
}

export function useBehaviours(item, useId) {
  return usableFlags(item).uses?.[useId] ?? {};
}

export function updateUsable(item, changes) {
  const update = foundry.utils.expandObject(changes);
  if (!item.flags[MODULE_ID] && item.flags[LEGACY_ID]) {
    update.flags ??= {};
    update.flags[MODULE_ID] = foundry.utils.mergeObject(
      foundry.utils.deepClone(item.flags[LEGACY_ID]), update.flags[MODULE_ID] ?? {}, { applyOperators: true }
    );
  }
  return item.update(update);
}

export async function resolveEffect(uuid) {
  const effect = uuid && await foundry.utils.fromUuid(uuid);
  if (effect?.type !== EFFECT_TYPE || !effect.testUserPermission(game.user, "LIMITED")) {
    throw new Error(loc("SBC.MissingEffect"));
  }
  return effect;
}

export function targetNumber(formula, actor) {
  const text = String(formula ?? "").trim() || "4";
  const data = { ...actor?.getRollData() };
  for (const key of Object.keys(CONFIG.SWADE.attributes)) {
    const die = actor?.system.attributes?.[key]?.die;
    data[key] = die ? Number(die.sides) + Number(die.modifier ?? 0) : 4;
  }
  try {
    const roll = Roll.create(text, data);
    if (roll.isDeterministic) {
      const result = roll.evaluateSync({ strict: true }).total;
      if (Number.isFinite(result)) return result;
    }
  } catch {
    // A malformed expression is reported below.
  }
  throw new Error(loc("SBC.InvalidTN"));
}
