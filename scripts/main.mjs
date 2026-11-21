import { installConsumption } from "./consumption.mjs";
import { installChat } from "./chat.mjs";
import { installConsumableSheet } from "./sheet.mjs";
import { installRecipientEffects } from "./recipients.mjs";
import { registerSoundSettings } from "./sound-settings.mjs";
import { installPoolRecharge } from "./pools.mjs";
import { installHud } from "./hud.mjs";
import { installCoatingDrops } from "./coatings.mjs";

Hooks.once("init", registerSoundSettings);
Hooks.once("setup", installConsumption);
Hooks.once("setup", installChat);
Hooks.once("setup", installRecipientEffects);
Hooks.once("setup", installConsumableSheet);
Hooks.once("setup", installPoolRecharge);
Hooks.once("setup", installHud);
Hooks.once("setup", installCoatingDrops);
