import rules from "./vendor/public-suffix-rules.json";

// Mozilla Public Suffix List, including PRIVATE domains. The complete upstream
// snapshot and MPL-2.0 license accompany the derived, bundled rule array.
const suffixes = new Set(
  rules.map((rule) => {
    const prefix = rule.startsWith("!") ? "!" : rule.startsWith("*.") ? "*." : "";
    return prefix + new URL(`https://${rule.slice(prefix.length)}`).hostname;
  }),
);

/** Registrable domain (eTLD+1); IPs and local hosts are exact-host scopes. */
export function siteForUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  const labels = host.split(".");
  let length = 1;
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i).join(".");
    if (suffixes.has(`!${suffix}`)) {
      length = labels.length - i - 1;
      break;
    }
    if (suffixes.has(suffix)) length = Math.max(length, labels.length - i);
    if (i > 0 && suffixes.has(`*.${suffix}`)) length = Math.max(length, labels.length - i + 1);
  }
  return labels.slice(-Math.min(labels.length, length + 1)).join(".");
}

export function isWithinScope(url: string, scope: string | null): boolean {
  const site = siteForUrl(url);
  if (!site) return false;
  if (scope === null) return true;
  const expected = siteForUrl(scope.includes("://") ? scope : `https://${scope}`);
  return expected !== null && site === expected;
}
