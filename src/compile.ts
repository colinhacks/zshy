import * as fs from "node:fs";
import * as path from "node:path";
import {
  type CallExpression,
  type ExportDeclaration,
  type Expression,
  type Node,
  NodeFlags,
  ScriptKind,
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
  ext: "cjs" | "js" | "mjs";
  format: "cjs" | "esm";
  pkgJsonDir: string; // Add package root for relative path display
  rootDir: string; // Add source root for asset copying
  verbose: boolean;
  dryRun: boolean;
  cjsInterop?: boolean; // Enable CJS interop for single default exports
  sealCjsExports?: boolean; // Freeze each CommonJS module's exports so re-exports settle into data properties
}

// The TypeScript 7 API has no transformer hook, so zshy's transforms run as edits over the emitted text. Each one
// locates what it changes by node position in the parsed output, never by matching text, so a string or comment that
// merely looks like a specifier is left alone.

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
 * What a module exports, read from its SOURCE: the CJS interop decision depends on type-only exports, which are erased
 * from the emitted JavaScript.
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
 * CJS interop applies to a module whose only export is its default: its CommonJS output gains
 * `module.exports = exports.default;`, so `require()` returns the default export itself.
 */
export function appliesCjsInterop(sourceFile: SourceFile): boolean {
  const shape = analyzeExportShape(sourceFile);
  return shape.hasDefaultExport && !shape.hasNamedExports && !shape.hasTypeOnlyExports;
}

/**
 * Maps a relative specifier onto the build's output extension. TypeScript's own `rewriteRelativeImportExtensions` has
 * already turned `.ts`/`.cts`/`.mts` into `.js`/`.cjs`/`.mjs` in the JavaScript, so only `.js` and extensionless
 * specifiers are left to map; asset specifiers are recorded for copying.
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
 * The specifiers zshy rewrites, read off the SOURCE file: `import`/`export ... from`, and dynamic `import()` with a
 * literal argument. Nothing else is touched — not `import x = require()`, not a hand-written
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
    // spellings. A `.tsx`/`.cts`/`.mts` specifier gets no entry at all — only `.js` and `.ts` are remapped — and keeps
    // whatever TypeScript emitted for it.
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
 * The edits to one emitted file, computed on its parsed AST so that a string in any other position — a default
 * parameter, an object key, a comment — is never mistaken for a specifier.
 *
 * Specifier positions: `import`/`export ... from` and dynamic `import()` in an ES module; the `require()` calls those
 * lower to in a CommonJS one. A literal is rewritten only if the source-side map says it should be, and always
 * double-quoted.
 *
 * In CommonJS output, `import.meta.url` / `.dirname` / `.filename` are replaced as property accesses on the
 * `import.meta` meta-property.
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
 * The declaration form of CJS interop, applied to `.d.ts`/`.d.cts` output.
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

// sealCjsExports

// TypeScript emits re-exports as `__createBinding` accessors, so callers read every API off the namespace through a getter. `__createBinding` copies a source descriptor instead of wrapping it when that descriptor is a non-writable, non-configurable data property, so a module has to be sealed before its re-exporters load. Reassigning `module.exports` would settle the same exports but blind `cjs-module-lexer`, and named imports from ESM would stop resolving.
const SEAL_CJS_EXPORTS_SETTLE = [
  "  var keys = Object.getOwnPropertyNames(exports);",
  "  for (var i = 0; i < keys.length; i++) {",
  "    var desc = Object.getOwnPropertyDescriptor(exports, keys[i]);",
  "    if (!desc || !desc.get || !desc.configurable) continue;",
  "    var value;",
  "    try {",
  "      value = desc.get();",
  "    } catch (e) {",
  "      continue;",
  "    }",
  "    // a circular require may not have settled this one yet, so leave it live",
  "    if (value === undefined) continue;",
  "    Object.defineProperty(exports, keys[i], { value: value, writable: false, enumerable: desc.enumerable, configurable: false });",
  "  }",
];

// only the freeze settles a module's own local exports, which is what lets a star re-exporter copy them instead of wrapping them
const SEAL_CJS_EXPORTS_FREEZE = "  Object.freeze(exports);";

export interface CjsEmitFacts {
  // `exports.x` written from inside a function runs after the epilogue, so freezing would make it throw
  writesExportsLate: boolean;
  // `module.exports = ...` hands callers something other than the object the epilogue seals, so sealing it achieves nothing
  rebindsModuleExports: boolean;
}

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

/** Walks a parsed emitted-CommonJS file for the two facts the seal depends on. */
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
    // `typescript/ast/is` has no `isFunctionLike`; on emitted JavaScript the only function-like nodes are declarations
    // (function expressions and arrows included), so `isFunctionLikeDeclaration` covers the same set.
    const nested = insideFunction || isFunctionLikeDeclaration(node);
    node.forEachChild((child) => {
      visit(child, nested);
    });
  };

  visit(source, false);
  return facts;
}

// above the sourceMappingURL comment so it stays last; either way every existing line keeps its position, so the source map holds
export function appendSealEpilogue(data: string, facts: CjsEmitFacts, settleAccessors: boolean): string {
  if (facts.rebindsModuleExports) return data;

  const lines = [
    ...(settleAccessors ? SEAL_CJS_EXPORTS_SETTLE : []),
    ...(facts.writesExportsLate ? [] : [SEAL_CJS_EXPORTS_FREEZE]),
  ];
  if (lines.length === 0) return data;

  const newline = data.includes("\r\n") ? "\r\n" : "\n";
  const epilogue = newline + ["// seal-cjs-exports", "(function () {", ...lines, "})();"].join(newline) + newline;

  const sourceMapComment = data.match(/\r?\n\/\/# sourceMappingURL=.*\s*$/);
  if (!sourceMapComment) {
    return data + epilogue;
  }
  const cut = data.length - sourceMapComment[0].length;
  return data.slice(0, cut) + epilogue.replace(/\r?\n$/, "") + sourceMapComment[0];
}

// TypeScript emits a named re-export as an unconditional getter onto the source binding, and the settle loop cannot tell one that forwards to a live `export let` from one that forwards to a constant. Snapshotting a live one makes `require` report the load-time value forever while `import` reports the current one, so a build containing any mutable exported binding gives up settling everywhere.
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

export async function compileProject(
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

    // Emit-time diagnostics count too.
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

    // Nothing is written once there is an error, and a skipped emit is not output.
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

      // Rename to the build's output extensions.
      let finalPath: string = outputPath;
      if (outputPath.endsWith(".js")) finalPath = outputPath.replace(/\.js$/, jsExt);
      else if (outputPath.endsWith(".d.ts")) finalPath = outputPath.replace(/\.d\.ts$/, dtsExt);
      else if (outputPath.endsWith(".js.map")) finalPath = outputPath.replace(/\.js\.map$/, `${jsExt}.map`);
      else if (outputPath.endsWith(".d.ts.map")) finalPath = outputPath.replace(/\.d\.ts\.map$/, `${dtsExt}.map`);

      pending.push({ outputPath, finalPath, text, sourceFileName, isJs, isDts, isCommonJs });
    }

    // Specifier rewriting on both JS and declarations, the import.meta shim on CommonJS JS in the CJS pass, then the
    // CJS interop line or its declaration form.
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
        const applies = appliesCjsInterop(sourceFile);
        if (applies && entry.isJs && entry.isCommonJs) {
          entry.text = appendStatement(entry.text, "module.exports = exports.default;");
        } else if (applies && entry.isDts && !entry.outputPath.endsWith(".d.mts")) {
          entry.text = applyDeclarationInterop(entry.text);
        }
      }
    }

    if (config.sealCjsExports) {
      // Cleared if any source file in the build exports a mutable binding. Every source file is a round trip to the
      // TypeScript process, and the program includes the whole lib and every `@types` package; a `.d.ts` name is always
      // a declaration file, so those are rejected by name without the fetch.
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
