/** IPv4 and IPv6 addresses and ranges (CIDRs), for checking a bot against its vendor's published ranges. */

export interface Ip {
  v6: boolean;
  value: bigint;
}

export interface Cidr {
  v6: boolean;
  value: bigint;
  mask: bigint;
}

function parseV4(text: string): bigint | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = (value << 8n) | BigInt(n);
  }
  return value;
}

function parseV6(text: string): bigint | null {
  let address = text;
  // An embedded IPv4 tail (`::ffff:192.0.2.1`) becomes two hextets.
  const lastColon = address.lastIndexOf(":");
  if (address.includes(".", lastColon)) {
    const v4 = parseV4(address.slice(lastColon + 1));
    if (v4 === null) return null;
    address = `${address.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

/** An IPv4 or IPv6 address (brackets and a zone id are ignored), or null. An IPv4-mapped IPv6 address is IPv4. */
export function parseIp(text: string): Ip | null {
  const raw = text.trim().replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "");
  if (!raw.includes(":")) {
    const v4 = parseV4(raw);
    return v4 === null ? null : { v6: false, value: v4 };
  }
  const v6 = parseV6(raw);
  if (v6 === null) return null;
  if (v6 >> 32n === 0xffffn) return { v6: false, value: v6 & 0xffffffffn };
  return { v6: true, value: v6 };
}

export function parseCidr(text: string): Cidr | null {
  const [address, length, extra] = text.trim().split("/");
  if (extra !== undefined || !address) return null;
  const ip = parseIp(address);
  if (!ip) return null;
  const bits = ip.v6 ? 128 : 32;
  const prefix = length === undefined ? bits : /^\d{1,3}$/.test(length) ? Number(length) : -1;
  if (prefix < 0 || prefix > bits) return null;
  const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
  return { v6: ip.v6, value: ip.value & mask, mask };
}

export function inRanges(ip: Ip, cidrs: Cidr[]): boolean {
  return cidrs.some((c) => c.v6 === ip.v6 && (ip.value & c.mask) === c.value);
}
