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

export interface TailscaleSelf {
  /** MagicDNS FQDN, e.g. `laptop.tailnet-name.ts.net.` */
  readonly dnsName?: string;
  /** Short machine name, resolved through the OS search domain (spoofable off-tailnet). */
  readonly hostName?: string;
  readonly ips: readonly string[];
}

/** Best effort: this machine's Tailscale identity from `tailscale status --json`. */
export const tailscaleSelf = (): TailscaleSelf | null => {
  const bin = Bun.which("tailscale");
  if (!bin) return null;
  try {
    const out = Bun.spawnSync([bin, "status", "--json"], { stderr: "ignore", timeout: 2000 });
    if (out.exitCode !== 0) return null;
    const self = JSON.parse(out.stdout.toString()).Self ?? {};
    const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
    return {
      dnsName: str(self.DNSName),
      hostName: str(self.HostName),
      ips: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((ip: unknown) => typeof ip === "string") : [],
    };
  } catch {
    return null;
  }
};

/** macOS Bonjour name (`scutil --get LocalHostName`), which `os.hostname()` may not reflect. */
const bonjourName = (): string | undefined => {
  if (process.platform !== "darwin") return undefined;
  const out = Bun.spawnSync(["scutil", "--get", "LocalHostName"], { stderr: "ignore", timeout: 1000 });
  const name = out.exitCode === 0 ? out.stdout.toString().trim() : "";
  return name ? `${name}.local` : undefined;
};

export interface MachineIdentity {
  readonly hostname: string;
  readonly bonjour?: string;
  readonly tailscale: TailscaleSelf | null;
}

export const machineIdentity = (): MachineIdentity => ({
  hostname: osHostname(),
  bonjour: bonjourName(),
  tailscale: tailscaleSelf(),
});

/**
 * Host names to accept for a given bind address.
 *
 * `.local` (mDNS) and single-label names can be answered by anyone on the
 * local network, so they're only safe when the server is already reachable
 * from that network (wildcard bind): spoofing them then gains nothing over
 * connecting directly. On a specific bind, e.g. the Tailscale IP only, a LAN
 * attacker could spoof such a name and rebind it to the tailnet address, so
 * only the MagicDNS FQDN is accepted, and only when the bind is a Tailscale IP.
 */
export const namesFor = (bindHost: string, id: MachineIdentity): string[] => {
  const ts = id.tailscale;
  if (!isWildcard(bindHost)) {
    const bound = normalizeHost(bindHost);
    const onTailnet = ts?.ips.some((ip) => normalizeHost(ip) === bound) ?? false;
    return onTailnet && ts?.dnsName ? [ts.dnsName] : [];
  }
  const h = id.hostname;
  const short = h.split(".")[0]!;
  const own = isIP(h) ? [] : [h, short, `${short}.local`];
  return [...new Set([...own, ...(id.bonjour ? [id.bonjour] : []), ...[ts?.dnsName, ts?.hostName].filter((n): n is string => !!n)])];
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
