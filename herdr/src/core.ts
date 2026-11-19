/** Everything the mod's UI uses from TypeScript, bundled into `herdr/git-diff/core.js`. */
export { openRepo, defaultRefs, GitError, MAX_GRAPH_COMMITS, type Host, type Repo } from "./repo";
export { parseFilePatch, splitLines, unifiedRows, splitRows, expand, findLine, findPair, untab, inlineMarks, segments } from "./diffModel";
export { buildIndex, search, splitMatches, MAX_HITS } from "./search";
export { languageFor, SyntaxDoc, MAX_SYNTAX_CHARS } from "./syntax";
export { buildTree, visibleRows, allDirPaths, filesInTreeOrder, rowKey } from "@/lib/tree";
export { layoutGraph, commitsInRange } from "@/lib/graph";
export { WORKTREE, INDEX, PSEUDO_LABEL, isPseudoRev } from "@/shared/api";
export { OBJECT_ID } from "@/shared/gitText";
