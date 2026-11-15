/**
 * Web Bot Auth: HTTP Message Signatures (RFC 9421) with Ed25519. Proves which signing agent sent a request, using the
 * keys in the policy. Every failure is simply "not signed".
 */

import type { Signer } from "../policy/compile";

/** How far a signature's `created`/`expires` may be from our clock. */
export const SIGNATURE_SKEW_S = 60;

/** Splits a structured-field list or dictionary on its top-level commas (not inside quotes or parentheses). */
export function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out.filter((m) => m.length > 0);
}

/** A structured-field dictionary as `label -> raw member value` (the text after `label=`, exactly as sent). */
export function dictionary(value: string): Map<string, string> {
  const members = new Map<string, string>();
  for (const member of splitTopLevel(value)) {
    const eq = member.indexOf("=");
    if (eq <= 0) continue;
    members.set(member.slice(0, eq).trim(), member.slice(eq + 1).trim());
  }
  return members;
}

function unquote(text: string): string | null {
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(text.trim());
  return m ? m[1].replace(/\\(.)/g, "$1") : null;
}

interface Component {
  name: string;
  /** The `;key="..."` parameter: a member of a dictionary header. */
  key?: string;
}

interface SignatureParams {
  components: Component[];
  created?: number;
  expires?: number;
  keyid?: string;
  alg?: string;
  tag?: string;
}

/** `("@authority" "signature-agent";key="sig1");created=1;keyid="k";alg="ed25519"`, or null when malformed. */
export function parseSignatureInput(member: string): SignatureParams | null {
  const m = /^\(([^)]*)\)(.*)$/.exec(member.trim());
  if (!m) return null;
  const components: Component[] = [];
  for (const item of m[1].trim().split(/\s+(?=")/).filter(Boolean)) {
    const cm = /^"([^"]+)"((?:;[a-z0-9*_.-]+(?:=(?:"[^"]*"|[^;]*))?)*)$/i.exec(item.trim());
    if (!cm) return null;
    const key = /;key="([^"]*)"/.exec(cm[2])?.[1];
    if (/;(?!key=)[a-z]/i.test(cm[2])) return null; // `;sf`, `;bs`, `;req`, `;tr`: not supported
    components.push({ name: cm[1].toLowerCase(), key });
  }
  const params: SignatureParams = { components };
  for (const param of m[2].split(";").slice(1)) {
    const [name, raw = ""] = param.split("=");
    const value = raw.trim();
    if (name === "created" || name === "expires") params[name] = /^\d+$/.test(value) ? Number(value) : undefined;
    else if (name === "keyid" || name === "alg" || name === "tag") params[name] = unquote(value) ?? undefined;
  }
  return params;
}

/** The value of one covered component, as RFC 9421 section 2 defines it, or null when it can't be built. */
function componentValue(component: Component, request: Request, url: URL): string | null {
  switch (component.name) {
    case "@method":
      return request.method.toUpperCase();
    case "@authority":
      return url.host.toLowerCase();
    case "@scheme":
      return url.protocol.replace(":", "").toLowerCase();
    case "@target-uri":
      return url.href;
    case "@path":
      return url.pathname || "/";
    case "@query":
      return url.search || "?";
    case "@request-target":
      return `${url.pathname}${url.search}`;
  }
  if (component.name.startsWith("@")) return null;
  const header = request.headers.get(component.name);
  if (header === null) return null;
  if (component.key === undefined) return header.trim().replace(/\s*,\s*/g, ", ");
  return dictionary(header).get(component.key) ?? null;
}

export function signatureBase(params: SignatureParams, rawParams: string, request: Request, url: URL): string | null {
  const lines: string[] = [];
  for (const component of params.components) {
    const value = componentValue(component, request, url);
    if (value === null) return null;
    const id = component.key === undefined ? `"${component.name}"` : `"${component.name}";key="${component.key}"`;
    lines.push(`${id}: ${value}`);
  }
  lines.push(`"@signature-params": ${rawParams}`);
  return lines.join("\n");
}

/** The host of a `Signature-Agent` value (`"https://chatgpt.com"`), or null. */
function hostOf(value: string): string | null {
  const raw = (value.split(";")[0] ?? "").trim();
  const text = unquote(raw) ?? raw;
  if (!text) return null;
  try {
    return new URL(text.includes("://") ? text : `https://${text}`).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The signing agent's host for one signature. `Signature-Agent` is either one string, or a dictionary with a member
 * per signature: the one the signature covers (`"signature-agent";key="x"`), else the one with the signature's own
 * label, else the only one.
 */
function signingHost(header: string, params: SignatureParams, label: string): string | null {
  const text = header.trim();
  if (!/^[a-z*][a-z0-9_.*-]*\s*=/.test(text)) return hostOf(text);
  const members = dictionary(text);
  const covered = params.components.find((c) => c.name === "signature-agent" && c.key !== undefined)?.key;
  const member = covered !== undefined ? members.get(covered) : (members.get(label) ?? (members.size === 1 ? [...members.values()][0] : undefined));
  return member === undefined ? null : hostOf(member);
}

/**
 * The signing agent whose key verifies one of the request's signatures, or null. `trusted` gives the signing agent
 * for a host, or null when its keys are unknown or too old. Every failure (missing or malformed headers, unknown
 * key, expired signature, bad signature, a WebCrypto without Ed25519) is simply "not signed".
 */
export async function verifiedSigner(trusted: (host: string) => Signer | null, request: Request, now: number): Promise<Signer | null> {
  const agentHeader = request.headers.get("signature-agent");
  const inputHeader = request.headers.get("signature-input");
  const signatureHeader = request.headers.get("signature");
  if (!agentHeader || !inputHeader || !signatureHeader) return null;
  const url = new URL(request.url);
  const signatures = dictionary(signatureHeader);
  const seconds = Math.floor(now / 1000);
  for (const [label, rawParams] of dictionary(inputHeader)) {
    const params = parseSignatureInput(rawParams);
    if (!params || params.tag !== "web-bot-auth" || (params.alg !== undefined && params.alg !== "ed25519")) continue;
    // A signature that never expires, or isn't dated, could be replayed forever.
    if (params.created === undefined || params.expires === undefined) continue;
    if (params.expires <= seconds || params.created > seconds + SIGNATURE_SKEW_S) continue;
    // It must cover this site (`@authority`), or one captured elsewhere could be replayed here, and the
    // Signature-Agent header, or anyone could claim to be the signer.
    if (!params.components.some((c) => c.name === "@authority" && c.key === undefined)) continue;
    if (!params.components.some((c) => c.name === "signature-agent")) continue;
    const host = signingHost(agentHeader, params, label);
    const signer = host === null ? null : trusted(host);
    if (!signer) continue;
    const key = signer.keys.find((k) => k.kid === params.keyid && (k.nbf == null || k.nbf <= seconds) && (k.exp == null || k.exp > seconds));
    const signature = /^:([A-Za-z0-9+/=]*):$/.exec(signatures.get(label) ?? "")?.[1];
    if (!key || signature === undefined) continue;
    const base = signatureBase(params, rawParams, request, url);
    const cryptoKey = base === null ? null : await key.crypto();
    if (!cryptoKey || base === null) continue;
    const signatureBytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
    const ok = await crypto.subtle
      .verify({ name: "Ed25519" }, cryptoKey, signatureBytes, new TextEncoder().encode(base))
      .catch(() => false);
    if (ok) return signer;
  }
  return null;
}
