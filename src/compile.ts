import * as fs from "node:fs";
import * as path from "node:path";
import {
  type CallExpression,
  type Expression,
  type Node,
  ScriptKind,
  type SourceFile,
  type StringLiteral,
  SyntaxKind,
} from "typescript/ast";
import {
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isStringLiteral,
} from "typescript/ast/is";
import {
  type API,
  type CompilerOptions,
  type Diagnostic,
  DiagnosticCategory,
  formatDiagnostics,
  formatDiagnosticsWithColorAndContext,
  type ModuleKind,
  type ModuleResolutionKind,
  type RawCompilerOptions,
} from "typescript/sync";
import * as utils from "./utils.js";

export interface BuildContext {
  writtenFiles: Set<string>;
  copiedAssets: Set<string>;
  errorCount: number;
  warningCount: number;
}

export interface ProjectOptions {
  configPath: string;
  compilerOptions: RawCompilerOptions & { module: ModuleKind; moduleResolution: ModuleResolutionKind; outDir: string };
  pkgJsonDir: string; // Add package root for relative path display
  rootDir: string; // Add source root for asset copying
  verbose: boolean;
  dryRun: boolean;
}

// The TypeScript 7 API has no transformer hook, so zshy rewrites specifiers as edits over the emitted text. Each edit
// is located by node position in the parsed output, never by matching text, so a string or comment that merely looks
// like a specifier is left alone.

/** Parses a tsconfig, `extends` included, and exits on any error in it. */
export function readTsconfig(api: API, tsconfigPath: string): CompilerOptions {
  const parsed = api.parseConfigFile(path.resolve(tsconfigPath));
  if (parsed.errors.length > 0) {
    utils.log.error("Error parsing tsconfig.json:");
    console.error(formatDiagnostics(parsed.errors, api));
    process.exit(1);
  }
  return parsed.options;
}

/**
 * Maps a relative specifier onto the file it will name in the output. ES modules need full paths, so an extensionless
 * specifier gains `.js` (or `/index.js` for a directory), and a `.ts` one becomes `.js`; TypeScript's own
 * `rewriteRelativeImportExtensions` does the latter in the JavaScript but not in declarations. Asset specifiers are
 * recorded for copying.
 */
function mapSpecifier(
  specifier: string,
  sourceFileName: string,
  rootDir: string,
  onAssetImport: (relPath: string) => void
): string {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return specifier;

  // A declaration path is not a module specifier to remap: `./module.d.ts` would otherwise be read as extension ".ts"
  // and mangled into "./module.d.cjs".
  if (/\.d\.(ts|cts|mts)$/.test(specifier)) return specifier;

  const specExt = path.extname(specifier).toLowerCase();

  if (specExt === ".ts") {
    return `${specifier.slice(0, -3)}.js`;
  }

  if (specExt === "") {
    const resolved = path.resolve(path.dirname(sourceFileName), specifier);
    if (fs.existsSync(path.join(resolved, "index.ts")) && !fs.existsSync(`${resolved}.ts`)) {
      return `${specifier}/index.js`;
    }
    return `${specifier}.js`;
  }

  if (utils.isAssetFile(specifier)) {
    const resolved = path.resolve(path.dirname(sourceFileName), specifier);
    onAssetImport(path.relative(rootDir, resolved));
    return specifier;
  }

  return specifier;
}

/** A read-only walk over every node, the TS 7 counterpart of a recursive `ts.forEachChild`. */
function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  node.forEachChild((child) => {
    walk(child, visit);
  });
}

function isImportCall(node: CallExpression): boolean {
  return node.expression.kind === SyntaxKind.ImportKeyword;
}

/**
 * The specifiers zshy rewrites, read off the SOURCE file: `import`/`export ... from`, and dynamic `import()` with a
 * literal argument. Nothing else is touched — not `import x = require()`, not a hand-written
 * `require()`, not an `import("./x")` type in a declaration file — so the map built here is what decides which literals
 * in the emitted output may change.
 */
function collectSpecifierRewrites(
  sourceFile: SourceFile,
  rootDir: string,
  onAssetImport: (relPath: string) => void
): Map<string, string> {
  const rewrites = new Map<string, string>();
  walk(sourceFile, (node) => {
    let literal: Expression | undefined;
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      literal = node.moduleSpecifier;
    } else if (isCallExpression(node) && isImportCall(node)) {
      literal = node.arguments[0];
    }
    if (!literal || !isStringLiteral(literal) || rewrites.has(literal.text)) return;
    const mapped = mapSpecifier(literal.text, sourceFile.fileName, rootDir, onAssetImport);
    if (mapped === literal.text) return;
    // A declaration file carries the source specifier verbatim, but in the JavaScript TypeScript's own
    // `rewriteRelativeImportExtensions` has already turned `./a.ts` into `./a.js`, so the rewrite is keyed by both
    // spellings. A `.tsx`/`.cts`/`.mts` specifier gets no entry at all — only `.ts` is remapped — and keeps whatever
    // TypeScript emitted for it.
    rewrites.set(literal.text, mapped);
    rewrites.set(
      literal.text.replace(/\.([cm]?)tsx?$/, (_, cm) => `.${cm}js`),
      mapped
    );
  });
  return rewrites;
}

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

function isSpecifierPosition(node: StringLiteral, isCommonJs: boolean): boolean {
  const parent = node.parent;
  if (isImportDeclaration(parent) || isExportDeclaration(parent)) return parent.moduleSpecifier === node;
  if (!isCallExpression(parent) || parent.arguments[0] !== node) return false;
  return (
    isImportCall(parent) || (isCommonJs && isIdentifier(parent.expression) && parent.expression.text === "require")
  );
}

/**
 * The specifier edits to one emitted file, computed on its parsed AST so that a string in any other position — a
 * default parameter, an object key, a comment — is never mistaken for a specifier.
 *
 * Specifier positions: `import`/`export ... from` and dynamic `import()`, plus `require()` in the CommonJS a `.cts`
 * source emits. A literal is rewritten only if the source-side map says it should be, and always double-quoted.
 */
function collectEmitEdits(emitted: SourceFile, rewrites: Map<string, string>, isCommonJs: boolean): TextEdit[] {
  const edits: TextEdit[] = [];
  walk(emitted, (node) => {
    if (!isStringLiteral(node)) return;
    const rewrite = rewrites.get(node.text);
    if (rewrite !== undefined && isSpecifierPosition(node, isCommonJs)) {
      edits.push({ start: node.getStart(emitted), end: node.end, text: `"${rewrite}"` });
    }
  });
  return edits;
}

function applyEdits(text: string, edits: TextEdit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

/**
 * Parses one emitted file, the TS 7 counterpart of `ts.createSourceFile`. Each file keeps its real name, so `.d.cts`
 * parses as a declaration file and `.mjs` as an ES module.
 */
function parseEmitted<T>(api: API, fileName: string, text: string, fn: (source: SourceFile) => T): T {
  const scriptKind = /\.d\.[cm]?ts$/.test(fileName) ? ScriptKind.TS : ScriptKind.JS;
  const lease = api.createSourceFile(fileName, text, { scriptKind });
  try {
    return fn(lease.sourceFile);
  } finally {
    lease.dispose();
  }
}

function errorsAndWarnings(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter(
    (d) => d.category === DiagnosticCategory.Error || d.category === DiagnosticCategory.Warning
  );
}

export async function compileProject(
  api: API,
  config: ProjectOptions,
  entryPoints: string[],
  ctx: BuildContext
): Promise<void> {
  const assetImports = new Set<string>();

  const program = api.createProgram(
    entryPoints.map((entry) => path.resolve(config.pkgJsonDir, entry)),
    {
      ...config.compilerOptions,
      // Left unset, TypeScript 7 roots the output at the tsconfig's directory; zshy roots it at the entrypoints' common
      // directory, which main.ts has computed.
      rootDir: config.rootDir,
    }
  );

  try {
    // Every pre-emit diagnostic, declaration-emit ones included: an `isolatedDeclarations` error is reported only by the
    // declaration emitter, and `declaration` is always on for zshy.
    const diagnostics = [
      ...program.getConfigFileParsingDiagnostics(),
      ...program.getProgramDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSemanticDiagnostics(),
      ...(config.compilerOptions.declaration || config.compilerOptions.composite
        ? program.getDeclarationDiagnostics()
        : []),
    ];

    const errorCount = diagnostics.filter((d) => d.category === DiagnosticCategory.Error).length;
    const warningCount = diagnostics.filter((d) => d.category === DiagnosticCategory.Warning).length;
    ctx.errorCount += errorCount;
    ctx.warningCount += warningCount;

    if (errorCount > 0 || warningCount > 0) {
      utils.log.warn(`Found ${errorCount} error(s) and ${warningCount} warning(s)`);
    }
    const relevant = errorsAndWarnings(diagnostics);
    if (relevant.length > 0) {
      console.log(formatDiagnosticsWithColorAndContext(relevant, program));
    }

    const output = program.emitToString();

    if (output.emitSkipped) {
      utils.log.error("Emit was skipped due to errors");
    }

    // Emit-time diagnostics count too.
    if (output.diagnostics.length > 0) {
      const emitErrors = output.diagnostics.filter((d) => d.category === DiagnosticCategory.Error);
      const emitWarnings = output.diagnostics.filter((d) => d.category === DiagnosticCategory.Warning);
      ctx.errorCount += emitErrors.length;
      ctx.warningCount += emitWarnings.length;
      utils.log.error(`Found ${emitErrors.length} error(s) and ${emitWarnings.length} warning(s) during emit:`);
      console.log();
      const relevantEmit = errorsAndWarnings(output.diagnostics);
      if (relevantEmit.length > 0) {
        console.log(formatDiagnosticsWithColorAndContext(relevantEmit, program));
      }
    }

    // Nothing is written once there is an error, and a skipped emit is not output.
    const shouldWriteFiles = errorCount === 0 && !output.emitSkipped;

    const sourceFiles = new Map<string, SourceFile | undefined>();
    const rewritesBySource = new Map<string, Map<string, string>>();

    for (const [outputPath, file] of output.outputFiles) {
      const sourceFileName = file.sourceFileName;
      let text = file.text;

      // A .cts source emits .cjs and .d.cts; a .mts source emits .mjs and .d.mts. Matching only ".js"/".d.ts" would
      // treat those as assets and copy the TypeScript source over the emitted output.
      const isMap = outputPath.endsWith(".map");
      const isDts = /\.d\.(ts|cts|mts)$/.test(outputPath);
      const isJs = !isDts && !isMap && /\.(js|cjs|mjs)$/.test(outputPath);

      if ((isJs || isDts) && sourceFileName) {
        let rewrites = rewritesBySource.get(sourceFileName);
        if (!rewrites) {
          if (!sourceFiles.has(sourceFileName)) sourceFiles.set(sourceFileName, program.getSourceFile(sourceFileName));
          const sourceFile = sourceFiles.get(sourceFileName);
          rewrites = sourceFile
            ? collectSpecifierRewrites(sourceFile, config.rootDir, (asset) => assetImports.add(asset))
            : new Map();
          rewritesBySource.set(sourceFileName, rewrites);
        }
        if (rewrites.size > 0) {
          // a .cts source still emits CommonJS, whose imports are `require()` calls
          const isCommonJs = isJs && outputPath.endsWith(".cjs");
          const emittedText = text;
          text = parseEmitted(api, outputPath, emittedText, (emitted) =>
            applyEdits(emittedText, collectEmitEdits(emitted, rewrites, isCommonJs))
          );
        }
      } else if (!isMap && sourceFileName && fs.existsSync(sourceFileName)) {
        // Non-code outputs (a resolveJsonModule .json, for instance) are assets: copy the source bytes rather than the
        // emitted text. TypeScript 7 re-serialises JSON with its own indentation, which would rewrite the user's file
        // for no reason.
        text = fs.readFileSync(sourceFileName, "utf8");
      }

      ctx.writtenFiles.add(outputPath);
      if (!config.dryRun && shouldWriteFiles) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, text);
      }
    }
  } finally {
    program.dispose();
  }

  // Copy assets discovered during specifier rewriting.
  if (assetImports.size > 0 && config.verbose) {
    utils.log.info(`Found ${assetImports.size} asset import(s), copying to output directory...`);
  }
  for (const assetPath of assetImports) {
    try {
      const sourceFile = path.resolve(config.rootDir, assetPath);
      if (!fs.existsSync(sourceFile)) {
        if (config.verbose) {
          utils.log.warn(`Asset not found: ${assetPath} (resolved to ${sourceFile})`);
        }
        continue;
      }

      const destFile = path.resolve(config.compilerOptions.outDir, assetPath);
      const posixDestFile = utils.toPosix(destFile);
      if (ctx.copiedAssets.has(posixDestFile)) continue;

      ctx.writtenFiles.add(posixDestFile);
      ctx.copiedAssets.add(posixDestFile);

      if (!config.dryRun) {
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.copyFileSync(sourceFile, destFile);
      }

      if (config.verbose) {
        const relativeSource = utils.relativePosix(config.pkgJsonDir, sourceFile);
        const relativeDest = utils.relativePosix(config.pkgJsonDir, destFile);
        utils.log.info(`${config.dryRun ? "[dryrun] " : ""}Copied asset: ./${relativeSource} → ./${relativeDest}`);
      }
    } catch (error) {
      utils.log.error(`Failed to copy asset ${assetPath}: ${error}`);
    }
  }
}
