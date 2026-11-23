import { MODULE_ID, TEMPLATE, loc } from "./data.mjs";
import { SOUND_RULES, cacheSoundMatches, parseSoundFlags, pickerPath, soundRules } from "./sound.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class SoundSettings extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    tag: "form",
    classes: ["swade", "swade-application", "standard-form", "sbs-standard-swade-sheet", "sbc-sound-settings"],
    window: { title: "SBC.GlobalSFX", icon: "fa-solid fa-volume-high", resizable: true },
    position: { width: 590 },
    form: {
      closeOnSubmit: false,
      handler: async function () { await this.save(); }
    },
    actions: {
      addRule: function () {
        this.capture();
        this.rules.push({ expression: "", path: "" });
        this.render();
      },
      removeRule: function (_event, target) {
        this.capture();
        this.rules.splice(Number(target.closest("[data-rule]").dataset.rule), 1);
        this.render();
      },
      pickSound: function (_event, target) {
        const input = target.closest("[data-rule]").querySelector("[data-rule-path]");
        new CONFIG.ux.FilePicker({
          type: "audio",
          current: pickerPath(input.value.trim()),
          callback: path => { input.value = path; }
        }).render({ force: true });
      }
    }
  };

  static PARTS = { rules: { template: `${TEMPLATE}/sound-settings.hbs`, scrollable: [".sbc-sound-rules"] } };

  rules = soundRules().map(({ expression, path }) => ({ expression, path }));

  async _prepareContext() {
    return { id: this.id, rules: this.rules };
  }

  capture() {
    this.rules = Array.from(this.element.querySelectorAll("[data-rule]"), row => ({
      expression: row.querySelector("[data-rule-flags]").value.trim(),
      path: row.querySelector("[data-rule-path]").value.trim()
    }));
  }

  async save() {
    if (!game.user.isGM || this.saving) return;
    this.capture();
    this.saving = true;
    try {
      const rules = this.rules.filter(({ expression, path }) => expression || path).map(({ expression, path }) => {
        if (!expression || !path) throw new Error(loc("SBC.IncompleteSFXRule"));
        return { expression, path, groups: parseSoundFlags(expression) };
      });
      const matchesByPath = new Map();
      for (const rule of rules) {
        if (!matchesByPath.has(rule.path)) matchesByPath.set(rule.path, await cacheSoundMatches(rule.path));
        rule.matches = matchesByPath.get(rule.path);
      }
      await game.settings.set(MODULE_ID, SOUND_RULES, rules);
      await this.close();
    } catch (error) {
      ui.notifications.error(error.message, { console: true });
    } finally {
      this.saving = false;
    }
  }
}

export function registerSoundSettings() {
  game.settings.register(MODULE_ID, SOUND_RULES, { scope: "world", config: false, type: Array, default: [] });
  game.settings.registerMenu(MODULE_ID, "configureSound", {
    name: "SBC.GlobalSFX",
    label: "SBC.ConfigureSFX",
    hint: "SBC.ConfigureSFXHint",
    icon: "fa-solid fa-volume-high",
    type: SoundSettings,
    restricted: true
  });
}
