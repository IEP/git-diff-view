import { describe, expect, test } from "bun:test";
import { makeHostGuard, normalizeHost } from "./HostGuard";

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
