import { describe, expect, test } from "bun:test";
import { parseGitHubRemote } from "./GitHub";

describe("parseGitHubRemote", () => {
  const ok = { owner: "sharkdp", name: "hexyl" };

  test.each([
    "git@github.com:sharkdp/hexyl.git",
    "git@github.com:sharkdp/hexyl",
    "https://github.com/sharkdp/hexyl.git",
    "https://github.com/sharkdp/hexyl/",
    "https://user:ghp_secret@github.com/sharkdp/hexyl.git",
    "ssh://git@github.com/sharkdp/hexyl.git",
    "ssh://git@github.com:22/sharkdp/hexyl",
    "git://github.com/sharkdp/hexyl.git",
    "https://GitHub.com/sharkdp/hexyl",
  ])("parses %s", (url) => {
    expect(parseGitHubRemote(url)).toEqual(ok);
  });

  test("keeps dots and dashes in repository names", () => {
    expect(parseGitHubRemote("git@github.com:tj/commander.js.git")).toEqual({ owner: "tj", name: "commander.js" });
  });

  test.each([
    "ssh://git@gitea.example.com:2222/deega/repo.git", // other host
    "git@github.example.com:org/repo.git", // GitHub Enterprise
    "https://github.com.evil.example/org/repo", // look-alike host
    "https://github.com/org", // missing repo
    "https://github.com/org/repo/tree/main", // extra path
    "https://github.com/org/..", // traversal
    "file:///github.com/org/repo",
    "/local/path/to/repo",
    "",
  ])("rejects %s", (url) => {
    expect(parseGitHubRemote(url)).toBeNull();
  });
});
