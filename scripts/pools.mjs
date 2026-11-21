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

export function usePool(item, use) {
  return useConfig(item, use.id).separate ? use : sharedPool(item);
}

function activePools(item) {
  const separate = item.system.charges.charges.filter(use => useConfig(item, use.id).separate);
  const usesShared = item.system.charges.charges.some(use => {
    const config = useConfig(item, use.id);
    return !config.separate && config.cost > 0;
  });
  return [usesShared && sharedPool(item), ...separate.map(use => ({ ...use }))].filter(Boolean);
}

export function describeUse(item, use, amount) {
  const config = useConfig(item, use.id);
  const pool = usePool(item, use);
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
    const spent = pools.find(entry => entry.id === pool.id);
    if (!spent) pools.push(pool);
    (spent ?? pool).value -= cost;
    const depleted = pools.every(entry => entry.value === 0);
    let quantity = item.system.quantity;
    // An empty rechargeable item remains available to recharge unless configured to be destroyed.
    if (depleted && (quantity > 1 || item.system.destroyOnEmpty || pools.every(entry => entry.rechargeType === finite))) {
      quantity -= 1;
      if (quantity > 0) for (const entry of pools) entry.value = entry.max;
      itemUpdates["system.quantity"] = quantity;
    }
    Object.assign(itemUpdates, poolUpdates(item, pools));
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
  const separate = new Map(pools.filter(pool => pool.id !== SHARED).map(pool => [pool.id, pool]));
  if (separate.size) {
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
    const current = rechargeablePools(item, criteria).filter(pool => amounts.has(pool.id));
    for (const pool of current) pool.value = Math.min(pool.max, pool.value + amounts.get(pool.id));
    if (current.length) {
      const changes = poolUpdates(item, current);
      if (item.system.quantity === 0 && current.some(pool => pool.value > 0)) changes["system.quantity"] = 1;
      await updateUsable(item, changes);
    }
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
