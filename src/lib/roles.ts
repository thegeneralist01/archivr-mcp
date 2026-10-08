/**
 * Role bit helpers. Archivr encodes a user's roles as a bitmask (`role_bits`):
 * GUEST=1, USER=2, ADMIN=4, OWNER=8. Custom roles take higher bits and carry no
 * built-in privileges, so they are ignored for tool visibility.
 *
 * Tool visibility is a convenience only: the server enforces every permission and
 * its 403s are always mapped through to the model.
 */
export const ROLE_GUEST = 1;
export const ROLE_USER = 2;
export const ROLE_ADMIN = 4;
export const ROLE_OWNER = 8;

export type MinRole = "guest" | "user" | "admin" | "owner";

const MIN_ROLE_BITS: Record<MinRole, number> = {
  guest: ROLE_GUEST,
  user: ROLE_USER,
  admin: ROLE_ADMIN,
  owner: ROLE_OWNER,
};

export function roleBit(role: MinRole): number {
  return MIN_ROLE_BITS[role];
}

/** True when `roleBits` contains the bit of `role` (the same test the server applies). */
export function hasRole(roleBits: number, role: MinRole): boolean {
  return (roleBits & MIN_ROLE_BITS[role]) !== 0;
}

/** Names of the built-in roles present in `roleBits`, lowest privilege first. */
export function decodeRoleBits(roleBits: number): MinRole[] {
  const order: MinRole[] = ["guest", "user", "admin", "owner"];
  return order.filter((role) => hasRole(roleBits, role));
}
