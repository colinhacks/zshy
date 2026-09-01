import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BuildContext } from "../src/compile.js";
import { compileProjectTs7 } from "../src/compile-ts7.js";
import { readTsconfig } from "../src/utils.js";

// Gate for the TypeScript 7.1 engine (src/compile-ts7.ts), which is a prototype
// and is NOT yet wired into the default build. It compiles the `test/basic`
// fixture through the new API and compares the result against the committed
// `test/basic/dist`, which is the same byte-for-byte baseline CI already
// enforces for the classic engine.
//
// The residual differences are upstream tsgo emit divergences, pinned here so a
// regression in zshy's own transforms fails loudly and an upstream fix shows up
// as a test that needs updating.

const REPO = path.resolve(import.meta.dirname, "..");
const BASE = path.join(REPO, "test/basic");
const GOLDEN = path.join(BASE, "dist");
// Built in-tree at the same depth as `dist`: sourcemap `sources` paths are
// relative to the output directory, and `node_modules/@types` resolution walks
// up from it. Building somewhere else breaks both.
const OUT = path.join(BASE, ".zshy-ts7-out");

/**
 * Declaration shapes tsgo emits differently from tsc 5.x, measured with all of
 * zshy's transforms disabled:
 *   `declare const _default: () => void`  ->  `declare function _default(): void`
 *   `declare const _default: "literal"`   ->  `declare const _default = "literal"`
 * Both are type-equivalent. Upstream, not zshy's doing.
 */
const KNOWN_DECLARATION_DIVERGENCES = [
  "default-arrow.d.cts",
  "default-arrow.d.ts",
  "default-literal.d.cts",
  "default-literal.d.ts",
];

/**
 * Outputs the golden `dist` carries that `compileProjectTs7` is not responsible
 * for: `env.d.ts` is an asset entrypoint copied by main.ts, and the tsbuildinfo
 * is a committed build artifact rather than something a compile pass emits.
 */
const NOT_EMITTED_BY_COMPILE = ["env.d.ts", "tsconfig.tsbuildinfo"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** zshy appends a sourceMappingURL comment naming the pre-rename file. */
const normalize = (text: string) => text.replace(/\n\/\/# sourceMappingURL=.*$/m, "").trimEnd();

describe("TypeScript 7.1 engine — emit fidelity against the committed fixture", () => {
  let produced: string[] = [];
  let ctx: BuildContext;

  beforeAll(async () => {
    fs.rmSync(OUT, { recursive: true, force: true });

    const parsed = readTsconfig(path.join(BASE, "tsconfig.json")) as any;
    delete parsed.customConditions;

    // Mirrors the compilerOptions main.ts forces onto the user's tsconfig.
    const compilerOptions = {
      ...parsed,
      outDir: OUT,
      skipLibCheck: true,
      declaration: true,
      esModuleInterop: true,
      noEmit: false,
      emitDeclarationOnly: false,
      rewriteRelativeImportExtensions: true,
      verbatimModuleSyntax: false,
      composite: false,
    };

    const pkg = JSON.parse(fs.readFileSync(path.join(BASE, "package.json"), "utf8"));
    const entryPoints = [
      ...new Set(
        Object.values(pkg.zshy.exports as Record<string, string>)
          .flatMap((sourcePath) => {
            if (sourcePath.endsWith("/**/*")) {
              const dir = path.join(BASE, sourcePath.slice(2, -5));
              return fs
                .readdirSync(dir)
                .filter((f) => /\.(ts|tsx|cts|mts)$/.test(f) && !f.endsWith(".d.ts"))
                .map((f) => path.relative(BASE, path.join(dir, f)));
            }
            return /\.(ts|tsx|cts|mts)$/.test(sourcePath) && !sourcePath.endsWith(".d.ts") ? [sourcePath.slice(2)] : [];
          })
          .concat([(pkg.zshy.bin as string).slice(2)])
      ),
    ];

    ctx = { writtenFiles: new Set(), copiedAssets: new Set(), errorCount: 0, warningCount: 0 };
    const base = {
      configPath: path.join(BASE, "tsconfig.json"),
      pkgJsonDir: BASE,
      rootDir: path.join(BASE, "src"),
      verbose: false,
      dryRun: false,
      cjsInterop: true,
    };

    await compileProjectTs7({ ...base, ext: "cjs", format: "cjs", compilerOptions } as any, entryPoints, ctx);
    await compileProjectTs7({ ...base, ext: "js", format: "esm", compilerOptions } as any, entryPoints, ctx);

    produced = walk(OUT).map((p) => path.relative(OUT, p));
  }, 120_000);

  afterAll(() => {
    // CI fails on a dirty tree, so this must not survive the run.
    fs.rmSync(OUT, { recursive: true, force: true });
  });

  it("compiles the fixture without diagnostics", () => {
    expect(ctx.errorCount).toBe(0);
    expect(ctx.warningCount).toBe(0);
  });

  it("emits every file the classic engine emits", () => {
    const missing = walk(GOLDEN)
      .map((p) => path.relative(GOLDEN, p))
      .filter((rel) => !NOT_EMITTED_BY_COMPILE.includes(rel))
      .filter((rel) => !produced.includes(rel));
    expect(missing).toEqual([]);
  });

  it("emits no files the classic engine does not", () => {
    const extra = produced.filter((rel) => !fs.existsSync(path.join(GOLDEN, rel)));
    expect(extra).toEqual([]);
  });

  it("produces byte-identical JavaScript for every entrypoint", () => {
    const differing = produced
      .filter((rel) => /\.(js|cjs|mjs)$/.test(rel))
      .filter(
        (rel) =>
          normalize(fs.readFileSync(path.join(OUT, rel), "utf8")) !==
          normalize(fs.readFileSync(path.join(GOLDEN, rel), "utf8"))
      );
    expect(differing).toEqual([]);
  });

  it("produces byte-identical declarations apart from known tsgo divergences", () => {
    const differing = produced
      .filter((rel) => /\.d\.(ts|cts|mts)$/.test(rel))
      .filter(
        (rel) =>
          normalize(fs.readFileSync(path.join(OUT, rel), "utf8")) !==
          normalize(fs.readFileSync(path.join(GOLDEN, rel), "utf8"))
      );
    expect(differing.sort()).toEqual(KNOWN_DECLARATION_DIVERGENCES);
  });

  it("copies assets byte-for-byte rather than re-serialising them", () => {
    const config = path.join(OUT, "assets/config.json");
    expect(fs.readFileSync(config, "utf8")).toEqual(fs.readFileSync(path.join(GOLDEN, "assets/config.json"), "utf8"));
  });

  it("resolves sourcemaps to the same sources as the classic engine", () => {
    // Sourcemap `mappings` are NOT yet byte-identical, for two reasons: tsgo
    // emits different mappings from tsc 5.x around default exports (reproduced
    // with zshy's transforms disabled), and zshy's post-emit text rewrites
    // append content the mappings do not cover. Neither is settled, so this
    // asserts only the part that must hold today — every map still points at
    // the right source file.
    const maps = produced.filter((rel) => rel.endsWith(".map"));
    expect(maps.length).toBeGreaterThan(0);

    const wrongSources = maps.filter((rel) => {
      const produced = JSON.parse(fs.readFileSync(path.join(OUT, rel), "utf8"));
      const golden = JSON.parse(fs.readFileSync(path.join(GOLDEN, rel), "utf8"));
      return JSON.stringify(produced.sources) !== JSON.stringify(golden.sources);
    });
    expect(wrongSources).toEqual([]);
  });
});
