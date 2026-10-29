// The curated mod list has no total count or pagination token. At the limit,
// equality of before/after slices cannot prove preservation of the inventory.
export const ORDINARY_MOD_LIMIT = 500;

export function assertOrdinaryModSnapshot(mods) {
  if (!Array.isArray(mods) || mods.some(mod => !mod || typeof mod !== 'object'
      || Array.isArray(mod) || typeof mod.id !== 'string' || !mod.id)
      || new Set(mods.map(mod => mod.id)).size !== mods.length)
    throw Error('ORDINARY_MOD_INVENTORY_INVALID');
  if (mods.length >= ORDINARY_MOD_LIMIT)
    throw Error('ORDINARY_MOD_INVENTORY_INCOMPLETE');
}
