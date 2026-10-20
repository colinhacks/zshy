import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engineKindFor } from "../src/engine.js";
import { relativePosix } from "../src/utils.js";

// Gate for the TypeScript 7 engine (src/compile-ts7.ts).
//
// Every fixture is copied beside itself and built by the real CLI with `typescript` resolved to the TypeScript 7.1
// devDependency (see test/support/typescript-7.mjs), then compared against the fixture's committed output. That output
// is what the classic engine produces — CI fails on a dirty tree after the classic suite rebuilds the same fixtures in
// place — so "byte-identical to the golden files" is exactly the bar the classic engine is held to.
//
// zshy.test.ts rebuilds the same fixtures in place, which is why vitest.config.ts runs test files one at a time.
//
// Residual differences are pinned per fixture, so a regression in zshy's own transforms fails loudly and an upstream
// fix shows up as a test to update.

const execFileAsync = promisify(execFile);

const REPO = path.resolve(import.meta.dirname, "..");
const CLI = path.join(REPO, "src", "index.ts");
const HOOK = path.join(REPO, "test", "support", "typescript-7.mjs");

/** Files that live in an output directory but are inputs, not build output. */
const NOT_OUTPUT = new Set(["package.json", "tsconfig.json", "jsr.json"]);
/** Inputs zshy rewrites in place; they must come out of the build exactly as the classic engine left them. */
const EDITED_IN_PLACE = ["package.json", "jsr.json"];
/** Every fixture keeps its sources under `src/`, which is the rootDir zshy computes for it. */
const ROOT_DIR = "src";

interface Fixture {
  name: string;
  /** The fixture's outDir and declarationDir, relative to it, when they are not `dist`. */
  outputDirs?: string[];
  /**
   * Files whose content still differs, with the reason. Every entry here is an upstream TypeScript 7 emit difference
   * reproducible with all of zshy's transforms disabled — not something zshy's port does differently.
   */
  knownDivergences: Record<string, string>;
}

const FIXTURES: Fixture[] = [
  {
    name: "basic",
    knownDivergences: {
      "dist/default-arrow.d.cts":
        "tsgo emits `declare function _default(): void` for `declare const _default: () => void`",
      "dist/default-arrow.d.ts": "as above",
      "dist/default-literal.d.cts": 'tsgo emits `declare const _default = "x"` for `declare const _default: "x"`',
      "dist/default-literal.d.ts": "as above",
    },
  },
  { name: "tsconfig-paths", knownDivergences: {} },
  { name: "ignore-tests", knownDivergences: {} },
  { name: "multi-bin", knownDivergences: {} },
  { name: "custom-conditions", knownDivergences: {} },
  { name: "custom-paths", outputDirs: ["dist/build/src", "dist/types/src"], knownDivergences: {} },
  { name: "no-edit-package-json", knownDivergences: {} },
  { name: "jsr", knownDivergences: {} },
  { name: "flat", outputDirs: [""], knownDivergences: {} },
  { name: "bin", knownDivergences: {} },
  { name: "esm-only", knownDivergences: {} },
  { name: "seal-cjs-exports", knownDivergences: {} },
  // The one fixture with a mutable exported binding: settling is off for the whole build and only the freeze is emitted.
  { name: "seal-cjs-exports-live", knownDivergences: {} },
];

// The gate above only ever sees builds that succeed. These pin the other half of the classic contract: an error is
// counted, and nothing reaches disk. The classic engine reports a declaration-emit error twice — once before emit and
// once from the emit itself — and counts both.
const FAILING = [
  { name: "esm-only-error", reason: "a type error (TS2322)", errors: 1 },
  { name: "declaration-error", reason: "a declaration-emit error (TS9007, isolatedDeclarations)", errors: 2 },
];

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** A fixture's tracked files and their contents, keyed by path relative to the fixture. */
function committedFiles(fixtureDir: string): Map<string, Buffer> {
  return new Map(
    execFileSync("git", ["ls-files", "-z", fixtureDir], { cwd: REPO, encoding: "utf8" })
      .split("\0")
      .filter(Boolean)
      .map((p) => [relativePosix(fixtureDir, path.join(REPO, p)), fs.readFileSync(path.join(REPO, p))])
  );
}

/**
 * The committed build output among a fixture's files.
 *
 * Scoped to the fixture's own output directories rather than matched by extension: `custom-paths` has stale
 * hand-committed `src/*.js` next to its real output, `basic` has hand-written ambient `src/*.d.ts`, and a flat build
 * puts its output in the same directory as package.json and the source tree. Assets count as output — zshy copies them
 * — so this deliberately does not filter by extension.
 */
function goldenFiles(committed: Map<string, Buffer>, outputDirs: string[]): string[] {
  return [...committed.keys()]
    .filter((rel) => outputDirs.some((d) => d === "" || rel.startsWith(`${d}/`)))
    .filter((rel) => !rel.startsWith(`${ROOT_DIR}/`))
    .filter((rel) => !NOT_OUTPUT.has(path.basename(rel)));
}

/**
 * Sourcemap `sources` are relative to the map's own directory, so compare what the paths resolve TO, relative to the
 * fixture, rather than the paths themselves.
 */
function sourcemapSources(map: string, mapPath: string): string[] {
  return (JSON.parse(map).sources as string[]).map((s) => path.posix.join(path.posix.dirname(mapPath), s));
}

interface Ts7Build {
  exitCode: number;
  output: string;
  /** Where the copy was built: a sibling of the fixture, so relative `extends` and sourcemap paths are unchanged. */
  dir: string;
  /** Files the build wrote, relative to `dir`. */
  produced: string[];
  /** Committed files the classic engine wrote, relative to the fixture. */
  golden: string[];
  /** Every committed file of the fixture, relative to it. */
  committed: Map<string, Buffer>;
}

async function buildWithTs7(name: string, outputDirs = ["dist"]): Promise<Ts7Build> {
  const fixtureDir = path.join(REPO, "test", name);
  const dir = path.join(REPO, "test", `.ts7-${name}`);
  fs.rmSync(dir, { recursive: true, force: true });

  const committed = committedFiles(fixtureDir);
  const golden = goldenFiles(committed, outputDirs);
  const inputs = [...committed.keys()].filter((rel) => !golden.includes(rel));
  for (const rel of inputs) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), committed.get(rel)!);
  }

  let exitCode = 0;
  let output: string;
  try {
    const result = await execFileAsync(
      process.execPath,
      ["--import", HOOK, "--import", "tsx", CLI, "--project", "./tsconfig.json", "--verbose"],
      { cwd: dir, encoding: "utf8" }
    );
    output = result.stdout + result.stderr;
  } catch (error: any) {
    exitCode = typeof error.code === "number" ? error.code : 1;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }

  const produced = walk(dir)
    .map((p) => relativePosix(dir, p))
    .filter((rel) => !inputs.includes(rel));
  return { exitCode, output, dir, produced, golden, committed };
}

/** The TypeScript the build ran on, from its verbose log; the hook means it is not necessarily the installed one. */
function versionUsed(output: string): string | undefined {
  return /Using TypeScript (\S+)/.exec(output)?.[1];
}

const builds = new Map<string, Ts7Build>();

beforeAll(async () => {
  // A handful at a time: each build is a Node process plus a TypeScript 7 server process
  const queue: { name: string; outputDirs?: string[] }[] = [...FIXTURES, ...FAILING];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      builds.set(next.name, await buildWithTs7(next.name, next.outputDirs));
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}, 300_000);

afterAll(() => {
  // CI fails on a dirty tree, so no copy may survive the run.
  for (const { dir } of builds.values()) fs.rmSync(dir, { recursive: true, force: true });
});

for (const fixture of FIXTURES) {
  describe(`TypeScript 7.1 engine — ${fixture.name}`, () => {
    const build = () => builds.get(fixture.name)!;
    const built = (rel: string) => fs.readFileSync(path.join(build().dir, rel), "utf8");
    const committed = (rel: string) => build().committed.get(rel)!.toString("utf8");

    it("builds on TypeScript 7 without diagnostics", () => {
      const { exitCode, output } = build();
      expect(engineKindFor(versionUsed(output) ?? "")).toBe("ts7");
      expect(output).not.toMatch(/Compilation finished with/);
      expect(exitCode).toBe(0);
    });

    it("emits every file the classic engine emits", () => {
      const { golden, produced } = build();
      expect(golden.filter((rel) => !produced.includes(rel))).toEqual([]);
    });

    it("emits no files the classic engine does not", () => {
      const { golden, produced } = build();
      expect(produced.filter((rel) => !golden.includes(rel))).toEqual([]);
    });

    it("edits package.json (and jsr.json) exactly as the classic engine does", () => {
      const differing = EDITED_IN_PLACE.filter((rel) => build().committed.has(rel)).filter(
        (rel) => built(rel) !== committed(rel)
      );
      expect(differing).toEqual([]);
    });

    it("produces byte-identical JavaScript", () => {
      const { golden, produced } = build();
      const differing = produced
        .filter((rel) => /\.(js|cjs|mjs)$/.test(rel) && golden.includes(rel))
        .filter((rel) => built(rel) !== committed(rel));
      expect(differing).toEqual([]);
    });

    it("produces byte-identical declarations apart from known tsgo divergences", () => {
      const { golden, produced } = build();
      const differing = produced
        .filter((rel) => /\.d\.(ts|cts|mts)$/.test(rel) && golden.includes(rel))
        .filter((rel) => built(rel) !== committed(rel));
      expect(differing.sort()).toEqual(Object.keys(fixture.knownDivergences).sort());
    });

    // Which sourcemaps still have differing `mappings`, pinned as the exact set. This is overwhelmingly upstream:
    // TypeScript 5.8 and 7.1 already map most of these files differently on the same sources with ZERO zshy transforms
    // in play. The snapshot still gates a regression — a map that starts differing, or stops, shows up by name.
    it("produces byte-identical sourcemap mappings apart from known divergences", () => {
      const { golden, produced } = build();
      const differing = produced
        .filter((rel) => rel.endsWith(".map") && golden.includes(rel))
        .filter((rel) => JSON.parse(built(rel)).mappings !== JSON.parse(committed(rel)).mappings);
      expect(differing.sort()).toMatchSnapshot();
    });

    it("resolves sourcemaps to the same sources as the classic engine", () => {
      const { golden, produced } = build();
      const wrong = produced
        .filter((rel) => rel.endsWith(".map") && golden.includes(rel))
        .filter(
          (rel) =>
            JSON.stringify(sourcemapSources(built(rel), rel)) !== JSON.stringify(sourcemapSources(committed(rel), rel))
        );
      expect(wrong).toEqual([]);
    });
  });
}

describe("TypeScript 7.1 engine — builds that must fail", () => {
  for (const { name, reason, errors } of FAILING) {
    it(`reports ${reason} and writes nothing`, () => {
      const { exitCode, output, produced } = builds.get(name)!;
      expect(engineKindFor(versionUsed(output) ?? "")).toBe("ts7");
      expect(output).toContain(`Compilation finished with ${errors} error${errors === 1 ? "" : "s"}`);
      expect(exitCode).toBe(1);
      expect(produced).toEqual([]);
    });
  }
});
