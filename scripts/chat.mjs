import {t as sbsI18n} from "./i18n.mjs";
import { EFFECTS_ID, MODULE_ID, effectsAPI, isCoating, loc, targetNumber, usableFlags } from "./data.mjs";

export function cleanNote(value) {
  const content = document.createElement("template");
  content.innerHTML = foundry.utils.cleanHTML(String(value ?? ""));
  content.content.querySelectorAll("section.secret:not(.revealed)").forEach(node => node.remove());
  return content.content.textContent.trim() || content.content.querySelector("img, hr") ? content.innerHTML : "";
}

export const chatMode = () => game.settings.get("core", "messageMode") ?? "public";

export function postMessage(actor, content, notes) {
  const Chat = CONFIG.ChatMessage.documentClass;
  return Chat.create({
    speaker: Chat.getSpeaker({ actor }),
    content,
    flags: { [MODULE_ID]: { notes } }
  }, { messageMode: chatMode() });
}

export async function postRoll(item, behaviour, notes, target) {
  const { actor } = item;
  const api = effectsAPI();
  const tags = api.normalizeFlags(behaviour.flags ?? []);
  const data = actor?.getRollData() ?? {};
  const formula = behaviour.formula?.trim();
  if (!formula) throw new Error(loc("SBC.InvalidFormula"));

  const roll = behaviour.damage ? new CONFIG.Dice.DamageRoll(formula, data) : Roll.create(formula, data);
  const activeTokens = actor?.getActiveTokens(false, true) ?? [];
  const self = actor?.token ?? activeTokens.find(token => token.object?.controlled)
    ?? (activeTokens.length === 1 ? activeTokens[0] : null);
  const recipient = isCoating(item) ? null : target ?? self;
  const targetUuids = recipient ? [recipient.uuid] : [];
  if (behaviour.damage) {
    roll.modifiers = [];
    api.tagRoll(roll, tags, { actor, item, targetUuids });
  } else {
    const context = api.makeRollContext(actor, item, tags);
    context.rollType = "roll";
    context.targetUuids = targetUuids;
    if (!tags.includes("damage") && !context.item.includes("damage")) {
      context.roll = context.roll.filter(flag => flag !== "damage");
    }
    roll.options[EFFECTS_ID] = context;
  }

  const flags = { [MODULE_ID]: { notes, ordinaryRoll: !behaviour.damage } };
  if (behaviour.damage) {
    flags.swade = { targets: recipient ? [{ name: recipient.name, uuid: recipient.uuid }] : [] };
  }
  return roll.toMessage({
    speaker: ChatMessage.getSpeaker({ actor }),
    flavor: foundry.utils.escapeHTML(item.name),
    flags
  }, { messageMode: chatMode() });
}

export async function postRequest(actor, configuration, notes) {
  if (!actor?.isOwner) throw new Error(loc("SBC.InvalidActingActor"));
  const request = effectsAPI().buildRollRequest({
    ...configuration,
    tn: targetNumber(configuration?.tn, actor),
    recipients: [game.user.id]
  });
  const content = await foundry.applications.handlebars.renderTemplate(
    `modules/${EFFECTS_ID}/templates/roll-request-card.hbs`,
    { request, flags: request.flags.join(", ") }
  );
  const Chat = CONFIG.ChatMessage.documentClass;
  return Chat.create({
    content,
    speaker: Chat.getSpeaker({ actor }),
    whisper: request.recipients,
    flags: { [MODULE_ID]: { request, actorUuid: actor.uuid, notes } }
  }, { messageMode: "self" });
}

function traitName(value) {
  return String(value).normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

async function rollRequest(message, request) {
  const uuid = usableFlags(message).actorUuid;
  const actor = uuid && await foundry.utils.fromUuid(uuid);
  if (!actor?.isOwner) throw new Error(loc("SBC.InvalidActingActor"));
  const title = sbsI18n("swade-better-usables.UI.TN_40a8723f1a", {p0: (request.name), p1: (request.targetNumber)});
  const options = {
    title,
    flavour: foundry.utils.escapeHTML(title),
    effectFlags: [...request.flags],
    sbeRequest: { ...request, messageUuid: message.uuid, whisper: [game.user.id] },
    additionalMods: request.penalty ? [{ label: loc("SBC.Penalty"), value: request.penalty }] : []
  };

  if (request.kind === "attribute") return actor.rollAttribute(request.trait, options);
  if (request.kind === "untrained") {
    options.effectFlags.push("untrained");
    return actor.makeUnskilledAttempt(options);
  }

  const skill = actor.items.find(item => item.type === "skill" && traitName(item.name) === traitName(request.trait));
  if (skill) return actor.rollSkill(skill.id, options);
  const temporary = new CONFIG.Item.documentClass({
    name: request.name,
    type: "skill",
    system: { swid: "unskilled-attempt", attribute: request.attribute, die: { sides: 4, modifier: 0 }, "wild-die": { sides: 6 } }
  });
  options.effectFlags.push("untrained");
  options.additionalMods.push({ label: loc("SWADE.Unskilled"), value: -2 });
  return actor.rollSkill(null, options, temporary);
}

async function renderNotes(message, container, notes) {
  const section = document.createElement("section");
  section.className = "sbe-roll-notes";
  section.setAttribute("aria-label", loc("SBC.Note"));
  section.tabIndex = 0;
  container.append(section);
  for (const note of notes) {
    const entry = document.createElement("div");
    entry.className = "sbe-roll-note sbe-roll-note-body";
    entry.innerHTML = await foundry.applications.ux.TextEditor.implementation.enrichHTML(cleanNote(note), {
      secrets: false,
      relativeTo: message.speakerActor,
      rollData: message.getRollData(),
      embeds: false
    });
    section.append(entry);
  }
}

export function installChat() {
  Hooks.on("renderChatMessageHTML", (message, html) => {
    if (!message.isContentVisible) return;
    const container = html.querySelector(".message-content") ?? html;
    const { notes, tags, ordinaryRoll, request } = usableFlags(message);
    if (notes?.length) renderNotes(message, container, notes).catch(error => console.error(MODULE_ID, error));
    if (message.isRoll && (ordinaryRoll || tags?.length)) {
      import("../../swade-better-effects/scripts/chat-flags.mjs").then(({ renderChatFlags }) => {
        if (html.querySelector(".sbe-chat-roll-flags")) return;
        const context = effectsAPI().getRollContext(message);
        renderChatFlags(message, html, { ...context, roll: effectsAPI().normalizeFlags([...context.roll, ...(tags ?? [])]) });
      }).catch(error => console.error(MODULE_ID, error));
    }

    if (!request) return;
    html.classList.add("sbc-request-message");
    const button = html.querySelector(".sbe-request-roll");
    if (!button) return;
    button.disabled = !message.isAuthor || !message.whisper.includes(game.user.id);
    button.addEventListener("click", async event => {
      event.preventDefault();
      if (button.disabled) return;
      button.disabled = true;
      try {
        await rollRequest(message, request);
      } catch (error) {
        ui.notifications.error(error.message, { console: true });
      } finally {
        button.disabled = false;
      }
    });
  });
}
