import { MODULE_ID, flagPath, loc, updateUsable, usableFlags } from "./data.mjs";

export const MANAGED = item => item.type === "consumable" && item.system.subtype === "regular";
export const SHARED = "shared";
const finite = "finite";
const recharging = new WeakSet();

export function sharedPool(item) {
  const { shared, sharedPool: saved } = usableFlags(item);
  if (shared === false) return null;
  return { ...item.system.charges.default, ...saved, id: SHARED, name: loc("SBC.SharedPool") };
}

export function useConfig(item, id) {
  return { cost: 1, separate: false, description: "", ...usableFlags(item).useConfig?.[id] };
}

export function usePool(item, use, config = useConfig(item, use.id)) {
  return config.separate ? use : sharedPool(item);
}

function activePools(item) {
  const separate = [];
  let usesShared = false;
  for (const use of item.system.charges.charges) {
    const config = useConfig(item, use.id);
    if (config.separate) separate.push({ ...use });
    else if (config.cost > 0) usesShared = true;
  }
  const shared = usesShared && sharedPool(item);
  return shared ? [shared, ...separate] : separate;
}

export function describeUse(item, use, amount) {
  const config = useConfig(item, use.id);
  const pool = usePool(item, use, config);
  const cost = pool ? (amount ?? config.cost) : 0;
  return { ...config, id: use.id, name: use.name, pool, cost,
    available: item.system.quantity > 0 && (!pool || pool.value >= cost) };
}

export function chargeUpdates(item, use, amount) {
  const { pool, cost, available } = describeUse(item, use, amount);
  if (!available) return;
  const itemUpdates = {};
  if (pool && cost) {
    const pools = activePools(item);
    let spent = pools.find(entry => entry.id === pool.id);
    if (!spent) {
      spent = pool;
      pools.push(spent);
    }
    spent.value -= cost;
    let changed = [spent];
    const depleted = pools.every(entry => entry.value === 0);
    let quantity = item.system.quantity;
    // An empty rechargeable item remains available to recharge unless configured to be destroyed.
    if (depleted && (quantity > 1 || item.system.destroyOnEmpty || pools.every(entry => entry.rechargeType === finite))) {
      quantity -= 1;
      if (quantity > 0) {
        for (const entry of pools) entry.value = entry.max;
        changed = pools;
      }
      itemUpdates["system.quantity"] = quantity;
    }
    Object.assign(itemUpdates, poolUpdates(item, changed));
  }
  return { cost, itemUpdates, actorUpdates: {}, resourceUpdates: [] };
}

function poolUpdates(item, pools) {
  const changes = {};
  const shared = pools.find(pool => pool.id === SHARED);
  if (shared) {
    const { value, max, rechargeAmount, rechargeType } = shared;
    changes[`${flagPath}.sharedPool`] = { value, max, rechargeAmount: rechargeAmount ?? "", rechargeType };
  }
  if (pools.some(pool => pool.id !== SHARED)) {
    const separate = new Map(pools.filter(pool => pool.id !== SHARED).map(pool => [pool.id, pool]));
    changes["system.charges.charges"] = item.system.charges.charges.map(use => separate.get(use.id) ?? use);
  }
  return changes;
}

export function preserveSharedPool(item, changes) {
  if (!MANAGED(item) || !changes.system?.charges?.charges || usableFlags(item).sharedPool) return;
  const pool = item._source.system.charges.charges[0];
  if (!pool) return;
  const { value, max, rechargeAmount, rechargeType } = pool;
  changes.flags ??= {};
  changes.flags[MODULE_ID] ??= foundry.utils.deepClone(usableFlags(item));
  changes.flags[MODULE_ID].sharedPool ??= { value, max, rechargeAmount: rechargeAmount ?? "", rechargeType };
}

export function rechargeablePools(item, { type, id } = {}) {
  if (!MANAGED(item)) {
    return item.system.charges.charges.filter(pool => pool.rechargeType !== finite && pool.value < pool.max
      && (!type || pool.rechargeType === type) && (!id || pool.id === id));
  }
  return activePools(item).filter(pool => pool.rechargeType !== finite && pool.value < pool.max
    && (!type || pool.rechargeType === type) && (!id || pool.id === id));
}

export async function rechargeUsable(item, criteria) {
  if (!item.isOwner || recharging.has(item)) return;
  const pools = rechargeablePools(item, criteria);
  if (!pools.length) return;
  recharging.add(item);
  try {
    if (!MANAGED(item)) {
      for (const pool of pools) await item.rechargeCharge(item.system.charges.find(pool.id));
      return;
    }
    const amounts = new Map();
    for (const pool of pools) {
      let amount = pool.max;
      if (pool.rechargeAmount) {
        const flavor = game.i18n.format("SWADE.RechargeRollFlavor", { name: foundry.utils.escapeHTML(pool.name) });
        const roll = await Roll.create(pool.rechargeAmount, {}, { flavor }).evaluate();
        amount = Math.max(0, roll.total);
        if (roll.dice.length) {
          const message = await roll.toMessage();
          await game.dice3d?.waitFor3DAnimationByMessageID(message.id);
        }
      }
      amounts.set(pool.id, amount);
    }
    const changed = [];
    let restoresQuantity = false;
    for (const pool of rechargeablePools(item, criteria)) {
      if (!amounts.has(pool.id)) continue;
      const value = Math.min(pool.max, pool.value + amounts.get(pool.id));
      if (value > 0) restoresQuantity = true;
      if (value === pool.value) continue;
      pool.value = value;
      changed.push(pool);
    }
    const changes = poolUpdates(item, changed);
    if (item.system.quantity === 0 && restoresQuantity) changes["system.quantity"] = 1;
    if (Object.keys(changes).length) await updateUsable(item, changes);
  } finally {
    recharging.delete(item);
  }
}

export function installPoolRecharge() {
  Hooks.on("preUpdateItem", preserveSharedPool);
  const prototype = CONFIG.Item.documentClass.prototype;
  const rechargeAll = prototype.rechargeAllChargesOfType;
  prototype.rechargeAllChargesOfType = function (type) {
    if (!MANAGED(this)) return rechargeAll.call(this, type);
    return rechargeUsable(this, { type });
  };
}
