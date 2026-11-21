import { LEGACY_ID, MODULE_ID, effectsAPI, flagPath, parseFlagGroups, updateUsable, usableFlags } from "./data.mjs";

export const SOUND_RULES = "soundRules";
const savingSounds = new WeakMap();

export function soundRules() {
  const settings = game.settings.storage.get("world");
  return settings.getSetting(`${MODULE_ID}.${SOUND_RULES}`)?.value
    ?? settings.getSetting(`${LEGACY_ID}.${SOUND_RULES}`)?.value ?? [];
}

export function pickerPath(path) {
  const wildcard = path.indexOf("*");
  return wildcard < 0 ? path : path.slice(0, path.lastIndexOf("/", wildcard) + 1);
}

async function matchingFiles(path) {
  const Picker = CONFIG.ux.FilePicker;
  const picker = new Picker({ type: "audio", current: path });
  const { activeSource, extensions } = picker;
  const { bucket } = picker.sources[activeSource];
  const target = Picker.matchS3URL(path)?.groups.key ?? path;
  const { files } = await Picker.browse(activeSource, target, { bucket, extensions, wildcard: true });
  return files ?? [];
}

export function parseSoundFlags(expression) {
  return parseFlagGroups(expression, "SBC.InvalidSFXFlags");
}

export function soundForItem(item) {
  const flagsOnItem = usableFlags(item);
  const path = flagsOnItem.sound?.trim();
  if (path) return { path, matches: flagsOnItem.soundMatches ?? [] };
  const rules = soundRules();
  if (!rules.length) return null;
  const flags = new Set(effectsAPI().getFlags(item));
  return rules.find(rule => rule.groups.some(group => group.every(flag => flags.has(flag)))) ?? null;
}

export async function cacheSoundMatches(path) {
  if (!path.includes("*") || !game.user.can("FILES_BROWSE")) return [];
  try {
    return await matchingFiles(path);
  } catch (error) {
    ui.notifications.warn(error.message);
    return [];
  }
}

export async function setSound(item, path) {
  const save = {};
  savingSounds.set(item, save);
  try {
    const files = !game.user.can("FILES_BROWSE") && path === usableFlags(item).sound
      ? usableFlags(item).soundMatches ?? []
      : await cacheSoundMatches(path);
    if (savingSounds.get(item) === save) {
      return await updateUsable(item, { [`${flagPath}.sound`]: path, [`${flagPath}.soundMatches`]: files });
    }
  } finally {
    if (savingSounds.get(item) === save) savingSounds.delete(item);
  }
}

export async function playSound({ path, matches }) {
  let src = path;
  if (path.includes("*")) {
    // Regular players can play known paths even when they cannot browse server files.
    const files = game.user.can("FILES_BROWSE") ? await matchingFiles(path) : matches;
    if (!files.length) throw new Error(game.i18n.format("SBC.NoMatchingAudio", { path }));
    src = files[Math.floor(Math.random() * files.length)];
  }
  return foundry.audio.AudioHelper.play({ src, autoplay: true, channel: "interface" }, true);
}
