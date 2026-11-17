import { describe, expect, test } from "bun:test";
import { makeHostGuard, namesFor, normalizeHost } from "./HostGuard";

const req = (host: string | null, site?: string) =>
  new Request("http://x/api/repo", {
    headers: { ...(host !== null && { host }), ...(site && { "sec-fetch-site": site }) },
  });

const guard = (extra: Partial<Parameters<typeof makeHostGuard>[0]> = {}) =>
  makeHostGuard({
    bindHost: "0.0.0.0",
    port: 3000,
    addresses: () => ["127.0.0.1", "192.168.0.140", "100.123.180.109", "fd7a:115c:a1e0:0:0:0:ed01:b46d", "fe80::1%en0"],
    names: ["Laptop.local", "laptop.tailnet.ts.net."],
    ...extra,
  });

describe("normalizeHost", () => {
  test("brackets and compresses IPv6, lower-cases names, drops trailing dot", () => {
    expect(normalizeHost("fd7a:115c:a1e0:0:0:0:ed01:b46d")).toBe("[fd7a:115c:a1e0::ed01:b46d]");
    expect(normalizeHost("[::1]")).toBe("[::1]");
    expect(normalizeHost("Box.Example.")).toBe("box.example");
    expect(normalizeHost("fe80::1%en0")).toBeNull();
  });
});

describe("makeHostGuard", () => {
  const g = guard();

  test.each([
    "localhost:3000",
    "127.0.0.1:3000",
    "[::1]:3000",
    "192.168.0.140:3000",
    "100.123.180.109:3000",
    "[fd7a:115c:a1e0::ed01:b46d]:3000",
    "laptop.local:3000",
    "LAPTOP.tailnet.ts.net:3000",
  ])("accepts %s", (host) => expect(g.isTrustedRequest(req(host))).toBe(true));

  test.each([
    "evil.example:3000", // DNS rebinding
    "192.168.0.140:4000", // wrong port
    "192.168.0.140", // implicit :80
    "0.0.0.0:3000", // the wildcard is not a real address
    "user@192.168.0.140:3000",
    "",
  ])("rejects %s", (host) => expect(g.isTrustedRequest(req(host))).toBe(false));

  test("rejects missing Host and cross-site fetches", () => {
    expect(g.isTrustedRequest(req(null))).toBe(false);
    expect(g.isTrustedRequest(req("localhost:3000", "cross-site"))).toBe(false);
    expect(g.isTrustedRequest(req("localhost:3000", "same-origin"))).toBe(true);
  });

  test("extra hosts are accepted", () => {
    expect(guard({ extraHosts: ["diff.home.arpa"] }).isTrustedRequest(req("diff.home.arpa:3000"))).toBe(true);
  });

  test("picks up interfaces that appear after startup", () => {
    const addrs = ["127.0.0.1"];
    const live = guard({ addresses: () => addrs });
    expect(live.isTrustedRequest(req("10.0.0.5:3000"))).toBe(false);
    addrs.push("10.0.0.5");
    expect(live.isTrustedRequest(req("10.0.0.5:3000"))).toBe(true);
  });
});

describe("namesFor", () => {
  const id = {
    hostname: "laptop.lan",
    bonjour: "Laptop.local",
    tailscale: { dnsName: "laptop.tailnet.ts.net.", hostName: "laptop", ips: ["100.64.0.7", "fd7a:115c:a1e0::7"] },
  };

  test("wildcard bind accepts hostname, mDNS and Tailscale names", () => {
    expect(namesFor("0.0.0.0", id)).toEqual([
      "laptop.lan", "laptop", "laptop.local", "Laptop.local", "laptop.tailnet.ts.net.",
    ]);
  });

  test("Tailscale-IP bind accepts only the MagicDNS FQDN (no spoofable .local / short names)", () => {
    expect(namesFor("100.64.0.7", id)).toEqual(["laptop.tailnet.ts.net."]);
    expect(namesFor("fd7a:115c:a1e0:0::7", id)).toEqual(["laptop.tailnet.ts.net."]);
  });

  test("other specific binds accept no names, only IP literals", () => {
    expect(namesFor("192.168.0.140", id)).toEqual([]);
    expect(namesFor("100.64.0.7", { ...id, tailscale: null })).toEqual([]);
  });

  test("a hostname that is an IP doesn't yield bogus names", () => {
    expect(namesFor("0.0.0.0", { hostname: "192.168.0.140", tailscale: null })).toEqual([]);
  });

  test("a Tailscale-only guard rejects a spoofed .local Host", () => {
    const g = makeHostGuard({
      bindHost: "100.64.0.7",
      port: 3000,
      names: namesFor("100.64.0.7", id),
      addresses: () => ["127.0.0.1", "100.64.0.7", "192.168.0.140"],
    });
    expect(g.isTrustedRequest(req("laptop.local:3000"))).toBe(false);
    expect(g.isTrustedRequest(req("laptop:3000"))).toBe(false);
    expect(g.isTrustedRequest(req("laptop.tailnet.ts.net:3000"))).toBe(true);
    expect(g.isTrustedRequest(req("100.64.0.7:3000"))).toBe(true);
  });
});
