import * as fs from "node:fs";
import * as path from "node:path";
import type * as ts from "typescript";
import {
  type CallExpression,
  type ExportDeclaration,
  type Expression,
  type Node,
  NodeFlags,
  ScriptKind,
  ScriptTarget,
  type SourceFile,
  type StringLiteral,
  SyntaxKind,
} from "typescript/ast";
import {
  isBinaryExpression,
  isCallExpression,
  isClassDeclaration,
  isElementAccessExpression,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isFunctionLikeDeclaration,
  isIdentifier,
  isImportDeclaration,
  isInterfaceDeclaration,
  isMetaProperty,
  isNamedExports,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableStatement,
} from "typescript/ast/is";
import {
  API,
  type Diagnostic,
  DiagnosticCategory,
  formatDiagnostics,
  formatDiagnosticsWithColorAndContext,
  ModuleKind,
  ModuleResolutionKind,
} from "typescript/sync";
import { appendSealEpilogue, type BuildContext, type CjsEmitFacts, type ProjectOptions } from "./compile.js";
import type { Engine } from "./engine.js";
import * as utils from "./utils.js";

// The TypeScript 7 API replaces `program.emit(..., customTransformers)` with a plain `emit()` and has no transformer
// hook, so zshy's transforms run here as edits over the emitted text instead. Each one locates what it changes by node
// position in the parsed output, never by matching text, so a string or comment that merely looks like a specifier is
// left alone, exactly as the classic transformers leave it.

export function createTs7Engine(version: string): Engine {
  // one API process serves the whole build: tsconfig parsing, both passes, and parsing the emitted output
  const api = new API({ cwd: process.cwd() });
  return {
    kind: "ts7",
    version,
    ModuleKind: ModuleKind as unknown as typeof ts.ModuleKind,
    ModuleResolutionKind: ModuleResolutionKind as unknown as typeof ts.ModuleResolutionKind,
    ScriptTarget: ScriptTarget as unknown as typeof ts.ScriptTarget,
    readTsconfig: (tsconfigPath) => readTsconfig(api, tsconfigPath),
    compileProject: (config, entryPoints, ctx) => compileProjectTs7(api, config, entryPoints, ctx),
    close: () => api.close(),
  };
}

// mirrors utils.readTsconfig
function readTsconfig(api: API, tsconfigPath: string): ts.CompilerOptions {
  const parsed = api.parseConfigFile(path.resolve(tsconfigPath));
  if (parsed.errors.length > 0) {
    utils.log.error("Error parsing tsconfig.json:");
    console.error(formatDiagnostics(parsed.errors, api));
    process.exit(1);
  }
  return parsed.options as ts.CompilerOptions;
}

interface ExportShape {
  hasDefaultExport: boolean;
  hasNamedExports: boolean;
  hasTypeOnlyExports: boolean;
}

function hasModifier(node: Node, kind: SyntaxKind): boolean {
  const modifiers: readonly Node[] | undefined = (node as { modifiers?: readonly Node[] }).modifiers;
  return modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function analyzeExportDeclaration(node: ExportDeclaration): { hasNamedExports: boolean; hasTypeOnlyExports: boolean } {
  if (!node.exportClause && !node.moduleSpecifier) {
    return { hasNamedExports: false, hasTypeOnlyExports: false };
  }
  if (node.isTypeOnly) {
    return { hasNamedExports: false, hasTypeOnlyExports: true };
  }
  if (node.exportClause && isNamedExports(node.exportClause)) {
    return {
      hasNamedExports: node.exportClause.elements.some((e) => !e.isTypeOnly),
      hasTypeOnlyExports: node.exportClause.elements.some((e) => e.isTypeOnly),
    };
  }
  return { hasNamedExports: true, hasTypeOnlyExports: false };
}

/**
 * Port of `analyzeExports` (see tx-analyze-exports.ts) onto the TS 7 AST.
 *
 * The decision this feeds — whether to apply CJS interop — depends on type-only exports, which are erased from the
 * emitted JS. Reading it from the source AST is what keeps the interop rule identical to the transformer's.
 */
function analyzeExportShape(sourceFile: SourceFile): ExportShape {
  let hasDefaultExport = false;
  let hasNamedExports = false;
  let hasTypeOnlyExports = false;

  for (const stmt of sourceFile.statements) {
    const isExported = hasModifier(stmt, SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(stmt, SyntaxKind.DefaultKeyword);

    if (isExportAssignment(stmt) && !stmt.isExportEquals) {
      hasDefaultExport = true;
    } else if (
      (isFunctionDeclaration(stmt) ||
        isClassDeclaration(stmt) ||
        isInterfaceDeclaration(stmt) ||
        isTypeAliasDeclaration(stmt) ||
        isEnumDeclaration(stmt)) &&
      isExported &&
      isDefault
    ) {
      hasDefaultExport = true;
    } else if (isExportDeclaration(stmt)) {
      const info = analyzeExportDeclaration(stmt);
      hasNamedExports ||= info.hasNamedExports;
      hasTypeOnlyExports ||= info.hasTypeOnlyExports;
    } else if (isVariableStatement(stmt) && isExported) {
      hasNamedExports = true;
    } else if ((isFunctionDeclaration(stmt) || isClassDeclaration(stmt)) && isExported && !isDefault) {
      hasNamedExports = true;
    } else if (isEnumDeclaration(stmt) && isExported && !isDefault) {
      // Regular enums emit runtime JS; const enums are erased (type-only).
      if (hasModifier(stmt, SyntaxKind.ConstKeyword)) {
        hasTypeOnlyExports = true;
      } else {
        hasNamedExports = true;
      }
    } else if ((isTypeAliasDeclaration(stmt) || isInterfaceDeclaration(stmt)) && isExported && !isDefault) {
      hasTypeOnlyExports = true;
    }
  }

  return { hasDefaultExport, hasNamedExports, hasTypeOnlyExports };
}

/**
 * Mirrors createExtensionRewriteTransformer. TypeScript's own `rewriteRelativeImportExtensions` has already turned
 * `.ts`/`.cts`/`.mts` into `.js`/`.cjs`/`.mjs` by this point, so only `.js` and extensionless specifiers are left to
 * map onto the build's output extension.
 */
function mapSpecifier(
  specifier: string,
  sourceFileName: string,
  ext: string,
  rootDir: string,
  onAssetImport: (relPath: string) => void
): string {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return specifier;

  // A declaration path is not a module specifier to remap: `./module.d.ts` would otherwise be read as extension ".ts"
  // and mangled into "./module.d.cjs".
  if (/\.d\.(ts|cts|mts)$/.test(specifier)) return specifier;

  const specExt = path.extname(specifier).toLowerCase();

  if (specExt === ".js" || specExt === ".ts") {
    return specifier.slice(0, -3) + ext;
  }

  if (specExt === "") {
    const resolved = path.resolve(path.dirname(sourceFileName), specifier);
    if (fs.existsSync(path.join(resolved, "index.ts")) && !fs.existsSync(`${resolved}.ts`)) {
      return `${specifier}/index${ext}`;
    }
    return specifier + ext;
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
 * The specifiers the classic transformer rewrites, read off the SOURCE file: `import`/`export ... from`, and dynamic
 * `import()` with a literal argument. Nothing else is touched — not `import x = require()`, not a hand-written
 * `require()`, not an `import("./x")` type in a declaration file — so the map built here is what decides which literals
 * in the emitted output may change.
 */
function collectSpecifierRewrites(
  sourceFile: SourceFile,
  ext: string,
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
    const mapped = mapSpecifier(literal.text, sourceFile.fileName, ext, rootDir, onAssetImport);
    if (mapped === literal.text) return;
    // A declaration file carries the source specifier verbatim, but in the JavaScript TypeScript's own
    // `rewriteRelativeImportExtensions` has already turned `./a.ts` into `./a.js`, so the rewrite is keyed by both
    // spellings. A `.tsx`/`.cts`/`.mts` specifier gets no entry at all — the classic transformer only remaps `.js` and
    // `.ts` — and keeps whatever TypeScript emitted for it.
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

const IMPORT_META_SHIM: Record<string, string> = {
  url: 'require("url").pathToFileURL(__filename)',
  dirname: "__dirname",
  filename: "__filename",
};

/**
 * The by-position equivalents of the classic `before` transformers, computed on the parsed EMITTED file so that a
 * string in any other position — a default parameter, an object key, a comment — is never mistaken for a specifier.
 *
 * Specifier positions: `import`/`export ... from` and dynamic `import()` in an ES module; the `require()` calls those
 * lower to in a CommonJS one. A literal is rewritten only if the source-side map says the classic transformer would
 * have rewritten it, and it is re-emitted double-quoted because the classic transformer replaces the node with a fresh
 * `createStringLiteral`.
 *
 * `import.meta.url` / `.dirname` / `.filename` are replaced as property accesses on the `import.meta` meta-property,
 * mirroring tx-import-meta-shim.
 */
function collectEmitEdits(
  emitted: SourceFile,
  rewrites: Map<string, string>,
  isCommonJs: boolean,
  shimImportMeta: boolean
): TextEdit[] {
  const edits: TextEdit[] = [];
  walk(emitted, (node) => {
    if (isStringLiteral(node)) {
      const rewrite = rewrites.get(node.text);
      if (rewrite !== undefined && isSpecifierPosition(node, isCommonJs)) {
        edits.push({ start: node.getStart(emitted), end: node.end, text: `"${rewrite}"` });
      }
      return;
    }

    if (
      shimImportMeta &&
      isPropertyAccessExpression(node) &&
      isMetaProperty(node.expression) &&
      node.expression.keywordToken === SyntaxKind.ImportKeyword &&
      isIdentifier(node.name)
    ) {
      const replacement = IMPORT_META_SHIM[node.name.text];
      if (replacement) edits.push({ start: node.getStart(emitted), end: node.end, text: replacement });
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

/**
 * Appends a statement the way a trailing statement added by a `before` / `afterDeclarations` transformer is printed:
 * as the last line of code, ahead of the `//# sourceMappingURL=` comment the printer writes after everything.
 */
function appendStatement(text: string, statement: string): string {
  const trailingComment = /\n(\/\/# sourceMappingURL=.*)$/.exec(text);
  if (trailingComment) {
    return text.replace(trailingComment[0], `\n${statement}\n${trailingComment[1]}`);
  }
  return `${text.replace(/\n?$/, "\n")}${statement}\n`;
}

/**
 * Mirrors createCjsInteropDeclarationTransformer.
 *
 * Case A — `export default <identifier>;` becomes `export = <identifier>;` in place. Case B — `export default class C
 * {}` / `export default function f()` loses the `export default` modifiers, gains `declare`, and picks up a trailing
 * `export = C;`.
 */
function applyDeclarationInterop(text: string): string {
  // Case A: a standalone `export default Foo;` statement.
  const identifierForm = /^export default ([A-Za-z_$][\w$]*);$/m;
  if (identifierForm.test(text)) {
    return text.replace(identifierForm, "export = $1;");
  }

  // Case B: `export default` directly on a declaration.
  const declarationForm =
    /^export default (abstract class|class|function\*?|enum|interface|type)\s+([A-Za-z_$][\w$]*)/m;
  const match = declarationForm.exec(text);
  if (!match) return text;

  const name = match[2]!;
  return appendStatement(text.replace(declarationForm, `declare $1 ${name}`), `export = ${name};`);
}

// ---------------------------------------------------------------------------
// sealCjsExports — the epilogue text and `appendSealEpilogue` are imported from compile.ts so there is one copy of what
// gets emitted. Only the two analyses change substrate: they walk the TS 7 AST of the emitted output.
// ---------------------------------------------------------------------------

function isExportsNamespace(node: Node): boolean {
  if (isIdentifier(node)) return node.text === "exports";
  return (
    isPropertyAccessExpression(node) &&
    isIdentifier(node.expression) &&
    node.expression.text === "module" &&
    isIdentifier(node.name) &&
    node.name.text === "exports"
  );
}

function writesExportsProperty(node: Node): boolean {
  let target: Expression | undefined;
  if (
    isBinaryExpression(node) &&
    node.operatorToken.kind >= SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= SyntaxKind.LastAssignment
  ) {
    target = node.left;
  } else if (
    (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) &&
    (node.operator === SyntaxKind.PlusPlusToken || node.operator === SyntaxKind.MinusMinusToken)
  ) {
    target = node.operand;
  }

  if (!target) return false;
  return (
    (isPropertyAccessExpression(target) || isElementAccessExpression(target)) && isExportsNamespace(target.expression)
  );
}

/** Mirrors `analyzeCjsEmit` in compile.ts: walks a parsed emitted-CommonJS file for the two facts the seal depends on. */
function analyzeCjsEmit(source: SourceFile): CjsEmitFacts {
  const facts: CjsEmitFacts = { writesExportsLate: false, rebindsModuleExports: false };

  const visit = (node: Node, insideFunction: boolean): void => {
    if (
      !facts.rebindsModuleExports &&
      !insideFunction &&
      isBinaryExpression(node) &&
      node.operatorToken.kind === SyntaxKind.EqualsToken &&
      isPropertyAccessExpression(node.left) &&
      isIdentifier(node.left.expression) &&
      node.left.expression.text === "module" &&
      isIdentifier(node.left.name) &&
      node.left.name.text === "exports"
    ) {
      facts.rebindsModuleExports = true;
    }
    if (!facts.writesExportsLate && insideFunction && writesExportsProperty(node)) {
      facts.writesExportsLate = true;
    }
    // The classic engine asks `isFunctionLike`, which the TS 7 guards do not export; on emitted JavaScript the only
    // function-like nodes are declarations, so the narrower guard covers the same set.
    const nested = insideFunction || isFunctionLikeDeclaration(node);
    node.forEachChild((child) => {
      visit(child, nested);
    });
  };

  visit(source, false);
  return facts;
}

/** Mirrors `hasMutableExportedBinding` in compile.ts. */
function hasMutableExportedBinding(source: SourceFile): boolean {
  const mutableLocals = new Set<string>();
  for (const statement of source.statements) {
    if (!isVariableStatement(statement)) continue;
    const isConst = (statement.declarationList.flags & NodeFlags.Const) !== 0;
    if (isConst) continue;
    const exported = hasModifier(statement, SyntaxKind.ExportKeyword);
    for (const declaration of statement.declarationList.declarations) {
      if (!isIdentifier(declaration.name)) continue;
      if (exported) return true;
      mutableLocals.add(declaration.name.text);
    }
  }

  return source.statements.some(
    (statement) =>
      isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      isNamedExports(statement.exportClause) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause.elements.some((element) => {
        const local = element.propertyName ?? element.name;
        return isIdentifier(local) && mutableLocals.has(local.text);
      })
  );
}

function errorsAndWarnings(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return diagnostics.filter(
    (d) => d.category === DiagnosticCategory.Error || d.category === DiagnosticCategory.Warning
  );
}

/** Mirrors `compileProject` in compile.ts. */
async function compileProjectTs7(
  api: API,
  config: ProjectOptions,
  entryPoints: string[],
  ctx: BuildContext
): Promise<void> {
  const assetImports = new Set<string>();
  const jsExt = `.${config.ext}`;
  const dtsExt = config.ext === "mjs" ? ".d.mts" : config.ext === "cjs" ? ".d.cts" : ".d.ts";

  const program = api.createProgram(
    entryPoints.map((entry) => path.resolve(config.pkgJsonDir, entry)),
    {
      ...(config.compilerOptions as Record<string, unknown>),
      // TypeScript 7 roots the output at the tsconfig directory unless told otherwise, where the classic engine roots
      // it at the entrypoints' common directory; main.ts has already computed that directory, so name it.
      rootDir: config.rootDir,
    }
  );

  try {
    // The same set, in the same order, as the classic `ts.getPreEmitDiagnostics`: declaration-emit diagnostics are
    // part of it whenever `declaration` is on, which for zshy is always.
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

    // Filter out diagnostics that are expected from CJS-only transforms.
    const filtered = diagnostics.filter((d) => config.format !== "cjs" || (d.code !== 1343 && d.code !== 1259));

    const errorCount = filtered.filter((d) => d.category === DiagnosticCategory.Error).length;
    const warningCount = filtered.filter((d) => d.category === DiagnosticCategory.Warning).length;
    ctx.errorCount += errorCount;
    ctx.warningCount += warningCount;

    if (errorCount > 0 || warningCount > 0) {
      utils.log.warn(`Found ${errorCount} error(s) and ${warningCount} warning(s)`);
    }
    const relevant = errorsAndWarnings(filtered);
    if (relevant.length > 0) {
      console.log(formatDiagnosticsWithColorAndContext(relevant, program));
    }

    const output = program.emitToString();

    if (output.emitSkipped) {
      utils.log.error("Emit was skipped due to errors");
    }

    // Emit-time diagnostics count like the classic engine's `emitResult.diagnostics`.
    if (output.diagnostics.length > 0) {
      const emitDiagnostics =
        config.format === "cjs" ? output.diagnostics.filter((d) => d.code !== 1343) : output.diagnostics;
      const emitErrors = emitDiagnostics.filter((d) => d.category === DiagnosticCategory.Error);
      const emitWarnings = emitDiagnostics.filter((d) => d.category === DiagnosticCategory.Warning);
      ctx.errorCount += emitErrors.length;
      ctx.warningCount += emitWarnings.length;
      utils.log.error(`Found ${emitErrors.length} error(s) and ${emitWarnings.length} warning(s) during emit:`);
      console.log();
      const relevantEmit = errorsAndWarnings(emitDiagnostics);
      if (relevantEmit.length > 0) {
        console.log(formatDiagnosticsWithColorAndContext(relevantEmit, program));
      }
    }

    // The classic engine writes nothing once it has seen an error, and the emitter's own verdict is honoured too: a
    // skipped emit is not output.
    const shouldWriteFiles = errorCount === 0 && !output.emitSkipped;

    // Outputs are computed first and written last: the specifier rewrite needs each emitted file parsed, and the seal
    // epilogue needs every CommonJS file's final text (interop line included) parsed again.
    interface PendingOutput {
      outputPath: string;
      finalPath: string;
      text: string;
      sourceFileName: string | undefined;
      isJs: boolean;
      isDts: boolean;
      // CommonJS by OUTPUT extension: a .cts source emits .cjs from BOTH passes and the ESM pass writes last, so a .cjs
      // is CommonJS whichever pass made it; a .js is CommonJS only in the CJS pass, and .mjs is real ESM.
      isCommonJs: boolean;
    }
    const pending: PendingOutput[] = [];

    for (const [outputPath, file] of output.outputFiles) {
      const sourceFileName = file.sourceFileName;
      let text = file.text;

      // A .cts source emits .cjs and .d.cts; a .mts source emits .mjs and .d.mts. Matching only ".js"/".d.ts" would
      // treat those as assets and copy the TypeScript source over the emitted output.
      const isMap = outputPath.endsWith(".map");
      const isDts = /\.d\.(ts|cts|mts)$/.test(outputPath);
      const isJs = !isDts && !isMap && /\.(js|cjs|mjs)$/.test(outputPath);
      const isCommonJs = outputPath.endsWith(".cjs") || (config.format === "cjs" && outputPath.endsWith(".js"));

      // Non-code outputs (a resolveJsonModule .json, for instance) are assets: copy the source bytes rather than the
      // emitted text. TypeScript 7 re-serialises JSON with its own indentation, which would rewrite the user's file for
      // no reason.
      if (!isJs && !isDts && !isMap && sourceFileName && fs.existsSync(sourceFileName)) {
        text = fs.readFileSync(sourceFileName, "utf8");
      }

      // Rename to the build's output extensions, exactly as the classic `host.writeFile` override does.
      let finalPath: string = outputPath;
      if (outputPath.endsWith(".js")) finalPath = outputPath.replace(/\.js$/, jsExt);
      else if (outputPath.endsWith(".d.ts")) finalPath = outputPath.replace(/\.d\.ts$/, dtsExt);
      else if (outputPath.endsWith(".js.map")) finalPath = outputPath.replace(/\.js\.map$/, `${jsExt}.map`);
      else if (outputPath.endsWith(".d.ts.map")) finalPath = outputPath.replace(/\.d\.ts\.map$/, `${dtsExt}.map`);

      pending.push({ outputPath, finalPath, text, sourceFileName, isJs, isDts, isCommonJs });
    }

    // The classic `before` / `afterDeclarations` transformers: specifier rewriting on both JS and declarations, the
    // import.meta shim on CommonJS JS in the CJS pass, then the CJS interop line or its declaration form.
    const code = pending.filter((p) => p.sourceFileName && (p.isJs || p.isDts));
    const sourceFiles = new Map<string, SourceFile | undefined>();
    const sourceFileOf = (fileName: string): SourceFile | undefined => {
      if (!sourceFiles.has(fileName)) sourceFiles.set(fileName, program.getSourceFile(fileName));
      return sourceFiles.get(fileName);
    };

    const rewritesBySource = new Map<string, Map<string, string>>();
    for (const entry of code) {
      const sourceFileName = entry.sourceFileName!;
      let rewrites = rewritesBySource.get(sourceFileName);
      if (!rewrites) {
        const sourceFile = sourceFileOf(sourceFileName);
        rewrites = sourceFile
          ? collectSpecifierRewrites(sourceFile, jsExt, config.rootDir, (asset) => assetImports.add(asset))
          : new Map();
        rewritesBySource.set(sourceFileName, rewrites);
      }

      const shimImportMeta = entry.isJs && entry.isCommonJs && config.format === "cjs";
      if (rewrites.size === 0 && !shimImportMeta) continue;
      entry.text = parseEmitted(api, entry.finalPath, entry.text, (emitted) =>
        applyEdits(entry.text, collectEmitEdits(emitted, rewrites, entry.isCommonJs, shimImportMeta))
      );
    }

    if (config.cjsInterop && config.format === "cjs") {
      if (config.verbose) {
        utils.log.info(`Enabling CJS interop transform...`);
      }
      for (const entry of code) {
        const sourceFile = sourceFileOf(entry.sourceFileName!);
        if (!sourceFile) continue;
        const shape = analyzeExportShape(sourceFile);
        const applies = shape.hasDefaultExport && !shape.hasNamedExports && !shape.hasTypeOnlyExports;
        if (applies && entry.isJs && entry.isCommonJs) {
          entry.text = appendStatement(entry.text, "module.exports = exports.default;");
        } else if (applies && entry.isDts && !entry.outputPath.endsWith(".d.mts")) {
          entry.text = applyDeclarationInterop(entry.text);
        }
      }
    }

    if (config.sealCjsExports) {
      // Cleared if any source file in the build exports a mutable binding. The classic engine reads
      // `program.getSourceFiles()` in process; here every source file is a round trip, and the program includes the
      // whole lib and every `@types` package. A `.d.ts` name is always a declaration file, so rejecting those by name is
      // the same filter without the fetch; the survivors are still checked on `isDeclarationFile` as before.
      const settleAccessors = !program
        .getSourceFileNames()
        .filter((name) => !/\.d\.(ts|cts|mts)$/.test(name))
        .some((name) => {
          const source = sourceFileOf(name);
          return source !== undefined && !source.isDeclarationFile && hasMutableExportedBinding(source);
        });

      for (const entry of pending) {
        if (!entry.isJs || !entry.isCommonJs) continue;
        const facts = parseEmitted(api, entry.finalPath, entry.text, analyzeCjsEmit);
        entry.text = appendSealEpilogue(entry.text, facts, settleAccessors);
      }
    }

    for (const { finalPath, text } of pending) {
      ctx.writtenFiles.add(finalPath);
      if (!config.dryRun && shouldWriteFiles) {
        fs.mkdirSync(path.dirname(finalPath), { recursive: true });
        fs.writeFileSync(finalPath, text);
      }
    }
  } finally {
    program.dispose();
  }

  // Copy assets discovered during specifier rewriting, exactly as the classic engine does.
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
