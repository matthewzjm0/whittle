import { PipelineError } from "./limits";

export function isLoopbackAddress(address: string): boolean {
  return /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(address) || address === "::1";
}

export function isPublicAddress(address: string): boolean {
  if (address.includes(":")) {
    const parts = address.toLowerCase().split("::");
    if (parts.length > 2 || address.includes(".") || address.includes("%")) return false;
    const left = parts[0] ? parts[0].split(":") : [];
    const right = parts[1] ? parts[1].split(":") : [];
    const groups = parts.length === 2
      ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
      : left;
    if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return false;
    const words = groups.map((group) => parseInt(group, 16));
    // Only global unicast. Exclude special-purpose, tunneling and documentation ranges.
    return words[0] >= 0x2000 && words[0] <= 0x3fff
      && !(words[0] === 0x2001 && (words[1] < 0x200 || words[1] === 0xdb8))
      && words[0] !== 0x2002
      && !(words[0] === 0x3fff && words[1] < 0x1000);
  }
  const octets = address.split(".").map(Number);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(address)
    || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = octets;
  return a > 0 && a < 224 && a !== 10 && a !== 127
    && !(a === 100 && b >= 64 && b <= 127)
    && !(a === 169 && b === 254)
    && !(a === 172 && b >= 16 && b <= 31)
    && !(a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
    && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    && !(a === 203 && b === 0 && c === 113);
}

export function parseEndpoint(baseUrl: string): URL {
  if (typeof baseUrl !== "string" || baseUrl.length > 2048 || /[\s\\]/.test(baseUrl)) {
    throw new PipelineError("endpoint");
  }
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new PipelineError("endpoint"); }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  const loopback = host === "localhost" || isLoopbackAddress(host);
  if (!/^https?:\/\//i.test(baseUrl) || /^[a-z]+:\/\/[^/]*@/i.test(baseUrl) || url.username || url.password
    || baseUrl.includes("?") || baseUrl.includes("#")
    || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new PipelineError("endpoint");
  }
  if ((host.includes(":") || /^[\d.]+$/.test(host)) && !loopback && !isPublicAddress(host)) {
    throw new PipelineError("address");
  }
  if (!host || (host !== "localhost" && !host.includes(".") && !host.includes(":"))) {
    throw new PipelineError("address");
  }
  return url;
}

/** Custom API URLs may include a fixed query string, but never credentials or fragments. */
export function parseCustomEndpoint(rawUrl: string): URL {
  if (typeof rawUrl !== "string" || rawUrl.length > 2048 || /[\s\\]/.test(rawUrl)) {
    throw new PipelineError("endpoint");
  }
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new PipelineError("endpoint"); }
  if (!/^https?:\/\//i.test(rawUrl) || /^[a-z]+:\/\/[^/]*@/i.test(rawUrl)
    || url.username || url.password || rawUrl.includes("#") || url.hash) {
    throw new PipelineError("endpoint");
  }
  for (const key of url.searchParams.keys()) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (["apikey", "key", "token", "accesstoken", "auth", "authorization", "clientsecret", "credential", "password", "secret", "sig", "signature"].includes(normalized)) {
      throw new PipelineError("endpoint");
    }
  }
  parseEndpoint(`${url.origin}${url.pathname}`);
  return url;
}
