import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuildContext } from "../src/compile.js";
import { compileProjectTs7 } from "../src/compile-ts7.js";
import { isTestFile, readTsconfig, relativePosix } from "../src/utils.js";

// Gate for the TypeScript 7.1 engine (src/compile-ts7.ts), which is a prototype
// and is NOT yet wired into the default build.
//
// It rebuilds every fixture whose output is committed to git and compares
// against that output. That committed output is the same baseline CI already
// enforces for the classic engine, via the dirty-tree check in test.yml, so
// "byte-identical to the golden files" is exactly the bar the classic engine
// is held to.
//
// Residual differences are pinned per fixture, so a regression in zshy's own
// transforms fails loudly and an upstream fix shows up as a test to update.

const REPO = path.resolve(import.meta.dirname, "..");
/** Files that live in an output directory but are inputs, not build output. */
const NOT_OUTPUT = new Set(["package.json", "tsconfig.json", "jsr.json"]);

interface Fixture {
  name: string;
  /**
   * Files whose content still differs, with the reason. Every entry here is an
   * upstream tsgo emit difference reproducible with all of zshy's transforms
   * disabled — not something zshy's port does differently.
   */
  knownDivergences: Record<string, string>;
  /**
   * Golden files `compileProjectTs7` is not responsible for: asset entrypoints
   * are copied by main.ts, and a tsbuildinfo is a build artifact rather than a
   * compile output.
   */
  notEmittedByCompile?: string[];
  /**
   * How many sourcemaps still have differing `mappings`.
   *
   * Pinned as a count rather than a file list because this is overwhelmingly
   * upstream: comparing tsc 5.8.3 against tsgo 7.1 on the same sources with
   * ZERO zshy transforms in play, 36 of 42 maps (86%) already differ. The
   * engine's own rate across all fixtures is lower than that, so the post-emit
   * text rewrites are not the driver. The count still gates a regression — if
   * a transform starts damaging maps it did not touch before, this rises.
   */
  knownMappingDivergences?: number;
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
    notEmittedByCompile: ["dist/env.d.ts", "dist/tsconfig.tsbuildinfo"],
    knownMappingDivergences: 55,
  },
  { name: "tsconfig-paths", knownDivergences: {} },
  { name: "ignore-tests", knownDivergences: {}, knownMappingDivergences: 4 },
  { name: "multi-bin", knownDivergences: {} },
  { name: "custom-conditions", knownDivergences: {}, knownMappingDivergences: 2 },
  { name: "custom-paths", knownDivergences: {} },
  { name: "no-edit-package-json", knownDivergences: {}, knownMappingDivergences: 1 },
  { name: "jsr", knownDivergences: {}, knownMappingDivergences: 1 },
  { name: "flat", knownDivergences: {} },
  { name: "bin", knownDivergences: {} },
  { name: "esm-only", knownDivergences: {} },
  { name: "seal-cjs-exports", knownDivergences: {}, knownMappingDivergences: 8 },
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

/**
 * The committed build output for a fixture, as git sees it.
 *
 * Scoped to the fixture's own output directories rather than matched by
 * extension: `custom-paths` has stale hand-committed `src/*.js` next to its
 * real output, `basic` has hand-written ambient `src/*.d.ts`, and a flat build
 * puts its output in the same directory as package.json and the source tree.
 * Assets count as output — zshy copies them — so this deliberately does not
 * filter by extension.
 */
function goldenFiles(fixtureDir: string, outputDirs: string[], rootDir: string): string[] {
  return execFileSync("git", ["ls-files", fixtureDir], { cwd: REPO, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((f) => relativePosix(fixtureDir, path.join(REPO, f)))
    .filter((rel) => outputDirs.some((d) => d === "" || rel.startsWith(`${d}/`)))
    .filter((rel) => rootDir === "" || !rel.startsWith(`${rootDir}/`))
    .filter((rel) => !NOT_OUTPUT.has(path.basename(rel)));
}

/** zshy appends a sourceMappingURL comment naming the pre-rename file. */
const normalize = (text: string) => text.replace(/\n\/\/# sourceMappingURL=.*$/m, "").trimEnd();

/**
 * Sourcemap `sources` are relative to the file's own directory, and this test
 * builds one level deeper than the golden output, so compare what the paths
 * resolve TO rather than the paths themselves.
 */
function sourcemapSources(mapPath: string, fixtureDir: string): string[] {
  const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  // `sources` point back into the fixture's src tree from wherever the map
  // lives, so resolving them yields the same absolute path for both trees.
  return (map.sources as string[]).map((s: string) =>
    relativePosix(fixtureDir, path.resolve(path.dirname(mapPath), s))
  );
}

/** Derives entrypoints from package.json#/zshy the way main.ts does. */
function entryPointsFor(base: string, zshy: any): string[] {
  const rawExports = typeof zshy.exports === "string" ? { ".": zshy.exports } : (zshy.exports ?? {});
  const fromExports = Object.values(rawExports as Record<string, string>).flatMap((sourcePath) => {
    if (sourcePath.includes("*")) {
      const pattern = sourcePath.endsWith("/**/*") ? sourcePath.slice(2, -5) : sourcePath.slice(2, -2);
      const dir = path.join(base, pattern);
      if (!fs.existsSync(dir)) return [];
      const deep = sourcePath.endsWith("/**/*");
      const files = deep ? walk(dir) : fs.readdirSync(dir).map((f) => path.join(dir, f));
      return files
        .filter((f) => fs.statSync(f).isFile() && /\.(ts|tsx|cts|mts)$/.test(f) && !f.endsWith(".d.ts"))
        .map((f) => relativePosix(base, f))
        .filter((f) => !isTestFile(f));
    }
    return /\.(ts|tsx|cts|mts)$/.test(sourcePath) && !sourcePath.endsWith(".d.ts") ? [sourcePath.slice(2)] : [];
  });

  const bin =
    typeof zshy.bin === "string"
      ? [zshy.bin.slice(2)]
      : Object.values((zshy.bin ?? {}) as Record<string, string>).map((p) => p.slice(2));

  return [...new Set([...fromExports, ...bin])];
}

for (const fixture of FIXTURES) {
  describe(`TypeScript 7.1 engine — ${fixture.name}`, () => {
    const BASE = path.join(REPO, "test", fixture.name);
    // Everything is rebased under one scratch root so the fixture's own
    // outDir/declarationDir layout is preserved exactly, including `outDir: "."`
    // and a declarationDir that differs from outDir.
    const OUT_ROOT = path.join(BASE, ".zshy-ts7-out");

    let produced: string[] = [];
    let golden: string[] = [];
    let ctx: BuildContext;

    beforeAll(async () => {
      fs.rmSync(OUT_ROOT, { recursive: true, force: true });

      const pkg = JSON.parse(fs.readFileSync(path.join(BASE, "package.json"), "utf8"));
      const zshy = typeof pkg.zshy === "string" ? { exports: pkg.zshy } : pkg.zshy;
      const parsed = readTsconfig(path.join(BASE, "tsconfig.json")) as any;
      delete parsed.customConditions;

      const relOutDir = relativePosix(BASE, path.resolve(BASE, parsed.outDir ?? "./dist"));
      const relDeclDir = relativePosix(BASE, path.resolve(BASE, parsed.declarationDir ?? parsed.outDir ?? "./dist"));

      const compilerOptions: any = {
        ...parsed,
        outDir: path.join(OUT_ROOT, relOutDir),
        skipLibCheck: true,
        declaration: true,
        esModuleInterop: true,
        noEmit: false,
        emitDeclarationOnly: false,
        rewriteRelativeImportExtensions: true,
        verbatimModuleSyntax: false,
        composite: false,
      };
      if (parsed.declarationDir) compilerOptions.declarationDir = path.join(OUT_ROOT, relDeclDir);

      const entryPoints = entryPointsFor(BASE, zshy);
      const rootDir = parsed.rootDir
        ? path.resolve(BASE, parsed.rootDir)
        : path.dirname(path.resolve(BASE, entryPoints[0]!));

      golden = goldenFiles(
        path.join("test", fixture.name),
        [...new Set([relOutDir, relDeclDir])],
        relativePosix(BASE, rootDir)
      );

      ctx = { writtenFiles: new Set(), copiedAssets: new Set(), errorCount: 0, warningCount: 0 };
      const base = {
        configPath: path.join(BASE, "tsconfig.json"),
        pkgJsonDir: BASE,
        rootDir,
        verbose: false,
        dryRun: false,
        cjsInterop: true,
        sealCjsExports: zshy.sealCjsExports === true,
      };
      const isTypeModule = pkg.type === "module";

      // Mirrors main.ts: the CJS pass is skipped entirely when zshy.cjs is false.
      if (zshy.cjs !== false) {
        await compileProjectTs7(
          { ...base, ext: isTypeModule ? "cjs" : "js", format: "cjs", compilerOptions } as any,
          entryPoints,
          ctx
        );
      }
      await compileProjectTs7(
        { ...base, ext: isTypeModule ? "js" : "mjs", format: "esm", compilerOptions } as any,
        entryPoints,
        ctx
      );

      produced = walk(OUT_ROOT).map((p) => path.relative(OUT_ROOT, p));
    }, 120_000);

    afterAll(() => {
      // CI fails on a dirty tree, so this must not survive the run.
      fs.rmSync(OUT_ROOT, { recursive: true, force: true });
    });

    it("compiles without diagnostics", () => {
      expect({ errors: ctx.errorCount, warnings: ctx.warningCount }).toEqual({ errors: 0, warnings: 0 });
    });

    it("emits every file the classic engine emits", () => {
      const missing = golden
        .filter((rel) => !(fixture.notEmittedByCompile ?? []).includes(rel))
        .filter((rel) => !produced.includes(rel));
      expect(missing).toEqual([]);
    });

    it("emits no files the classic engine does not", () => {
      expect(produced.filter((rel) => !golden.includes(rel))).toEqual([]);
    });

    it("produces byte-identical JavaScript", () => {
      const differing = produced
        .filter((rel) => /\.(js|cjs|mjs)$/.test(rel) && golden.includes(rel))
        .filter(
          (rel) =>
            normalize(fs.readFileSync(path.join(OUT_ROOT, rel), "utf8")) !==
            normalize(fs.readFileSync(path.join(BASE, rel), "utf8"))
        );
      expect(differing).toEqual([]);
    });

    it("produces byte-identical declarations apart from known tsgo divergences", () => {
      const differing = produced
        .filter((rel) => /\.d\.(ts|cts|mts)$/.test(rel) && golden.includes(rel))
        .filter(
          (rel) =>
            normalize(fs.readFileSync(path.join(OUT_ROOT, rel), "utf8")) !==
            normalize(fs.readFileSync(path.join(BASE, rel), "utf8"))
        );
      expect(differing.sort()).toEqual(Object.keys(fixture.knownDivergences).sort());
    });

    it("produces byte-identical sourcemap mappings apart from known divergences", () => {
      const differing = produced
        .filter((rel) => rel.endsWith(".map") && golden.includes(rel))
        .filter(
          (rel) =>
            JSON.parse(fs.readFileSync(path.join(OUT_ROOT, rel), "utf8")).mappings !==
            JSON.parse(fs.readFileSync(path.join(BASE, rel), "utf8")).mappings
        );
      expect(differing.length).toBe(fixture.knownMappingDivergences ?? 0);
    });

    it("resolves sourcemaps to the same sources as the classic engine", () => {
      // `mappings` are not yet byte-identical — tsgo emits different mappings
      // around default exports (reproduced with zshy's transforms disabled) and
      // the post-emit text rewrites append content the mappings do not cover.
      // What must hold today is that every map still points at the right source.
      const wrong = produced
        .filter((rel) => rel.endsWith(".map") && golden.includes(rel))
        .filter(
          (rel) =>
            JSON.stringify(sourcemapSources(path.join(OUT_ROOT, rel), BASE)) !==
            JSON.stringify(sourcemapSources(path.join(BASE, rel), BASE))
        );
      expect(wrong).toEqual([]);
    });
  });
}
