import { isIP } from "node:net";
import { hostname as osHostname, networkInterfaces } from "node:os";

// DNS-rebinding guard: a hostile page can point its own domain at one of our
// addresses, making its requests same-origin in the browser. The Host header
// still names that domain, so only accept names that belong to this machine:
// loopback, our own interface IPs, our hostname, Tailscale's MagicDNS name, and
// anything passed explicitly. An attacker can't make a request carry those.

export const isWildcard = (host: string) => host === "0.0.0.0" || host === "::" || host === "";

/** Lower-cased hostname as the URL parser sees it (IPv6 bracketed + compressed), or null. */
export const normalizeHost = (name: string): string | null => {
  const bare = name.trim().replace(/^\[|\]$/g, "");
  if (!bare || bare.includes("%")) return null; // scoped link-local (fe80::1%en0) can't appear in Host
  try {
    return new URL(`http://${bare.includes(":") ? `[${bare}]` : bare}`).hostname.replace(/\.$/, "");
  } catch {
    return null;
  }
};

export const interfaceAddresses = (): string[] =>
  Object.values(networkInterfaces())
    .flat()
    .flatMap((i) => (i ? [i.address] : []));

/** Best effort: this machine's MagicDNS name, e.g. `laptop.tailnet-name.ts.net`. */
export const tailscaleNames = (): string[] => {
  const bin = Bun.which("tailscale");
  if (!bin) return [];
  try {
    const out = Bun.spawnSync([bin, "status", "--json"], { stderr: "ignore", timeout: 2000 });
    if (out.exitCode !== 0) return [];
    const self = JSON.parse(out.stdout.toString()).Self ?? {};
    return [self.DNSName, self.HostName].filter((n): n is string => typeof n === "string" && n !== "");
  } catch {
    return [];
  }
};

/** macOS Bonjour name (`scutil --get LocalHostName`), which `os.hostname()` may not reflect. */
const bonjourName = (): string[] => {
  if (process.platform !== "darwin") return [];
  const out = Bun.spawnSync(["scutil", "--get", "LocalHostName"], { stderr: "ignore", timeout: 1000 });
  const name = out.exitCode === 0 ? out.stdout.toString().trim() : "";
  return name ? [`${name}.local`] : [];
};

/** Names this machine answers to: hostname, mDNS `.local`, Tailscale MagicDNS. */
export const machineNames = (): string[] => {
  const h = osHostname();
  const own = isIP(h) ? [] : [h, h.split(".")[0]!, `${h.split(".")[0]}.local`];
  return [...new Set([...own, ...bonjourName(), ...tailscaleNames()])];
};

/** Addresses worth printing: IPv4 plus non-link-local IPv6 (fe80:: needs a zone id browsers won't take). */
export const isShareableAddress = (addr: string) => !addr.includes("%") && !/^fe[89ab]/i.test(addr);

export interface HostGuardOptions {
  readonly bindHost: string;
  readonly port: number;
  /** Extra names/IPs to accept, e.g. a reverse-proxy or custom DNS name. */
  readonly extraHosts?: readonly string[];
  /** Injected for tests; defaults to the live interface list (re-read on a miss). */
  readonly addresses?: () => readonly string[];
  readonly names?: readonly string[];
}

export const makeHostGuard = (opts: HostGuardOptions) => {
  const addresses = opts.addresses ?? interfaceAddresses;
  const fixed = new Set(
    ["127.0.0.1", "localhost", "::1", ...(isWildcard(opts.bindHost) ? [] : [opts.bindHost]), ...(opts.names ?? []), ...(opts.extraHosts ?? [])]
      .map(normalizeHost)
      .filter((h): h is string => h !== null),
  );
  const build = () => new Set([...fixed, ...addresses().map(normalizeHost).filter((h): h is string => h !== null)]);
  let allowed = build();

  const isAllowedHost = (header: string | null): boolean => {
    if (!header) return false;
    let url: URL;
    try {
      url = new URL(`http://${header}`);
    } catch {
      return false;
    }
    if (Number(url.port || 80) !== opts.port || url.username || url.pathname !== "/") return false;
    const name = url.hostname.replace(/\.$/, "");
    if (allowed.has(name)) return true;
    // Interfaces come and go (VPN up, Wi-Fi change): refresh once before refusing.
    allowed = build();
    return allowed.has(name);
  };

  return {
    allowed: () => [...allowed],
    isTrustedRequest: (req: Request) =>
      isAllowedHost(req.headers.get("host")) && req.headers.get("sec-fetch-site") !== "cross-site",
  };
};
