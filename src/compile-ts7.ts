import * as fs from "node:fs";
import * as path from "node:path";
import { NodeFlags, ScriptTarget, SyntaxKind } from "typescript-next/unstable/ast";
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
} from "typescript-next/unstable/ast/is";
import { visitEachChild } from "typescript-next/unstable/ast/visitor";
import {
  API,
  fileNameToDocumentURI,
  formatDiagnosticsWithColorAndContext,
  ModuleKind,
  ModuleResolutionKind,
} from "typescript-next/unstable/sync";
import { appendSealEpilogue, type BuildContext, type CjsEmitFacts, type ProjectOptions } from "./compile.js";
import * as utils from "./utils.js";

// The TypeScript 7 API replaces `program.emit(..., customTransformers)` with a
// plain `emit()`; there is no transformer hook (microsoft/TypeScript#63875 item
// 3C is not implemented, and its `printNode` substrate does not preserve
// comments or formatting). zshy's transforms therefore run as text rewrites over
// the emitted output, which is byte-identical to the emit zshy builds on today.

interface ExportShape {
  hasDefaultExport: boolean;
  hasNamedExports: boolean;
  hasTypeOnlyExports: boolean;
}

function hasModifier(node: any, kind: number): boolean {
  return node.modifiers?.some((m: any) => m.kind === kind) ?? false;
}

function analyzeExportDeclaration(node: any): { hasNamedExports: boolean; hasTypeOnlyExports: boolean } {
  if (!node.exportClause && !node.moduleSpecifier) {
    return { hasNamedExports: false, hasTypeOnlyExports: false };
  }
  if (node.isTypeOnly) {
    return { hasNamedExports: false, hasTypeOnlyExports: true };
  }
  if (node.exportClause && isNamedExports(node.exportClause)) {
    return {
      hasNamedExports: node.exportClause.elements.some((e: any) => !e.isTypeOnly),
      hasTypeOnlyExports: node.exportClause.elements.some((e: any) => e.isTypeOnly),
    };
  }
  return { hasNamedExports: true, hasTypeOnlyExports: false };
}

/**
 * Port of `analyzeExports` (see tx-analyze-exports.ts) onto the TS 7 AST.
 *
 * The decision this feeds — whether to apply CJS interop — depends on
 * type-only exports, which are erased from the emitted JS. Reading it from the
 * source AST is what keeps the interop rule identical to the transformer's.
 */
function analyzeExportShape(sourceFile: any): ExportShape {
  let hasDefaultExport = false;
  let hasNamedExports = false;
  let hasTypeOnlyExports = false;

  for (const stmt of sourceFile.statements) {
    const isExported = hasModifier(stmt, SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(stmt, SyntaxKind.DefaultKeyword);

    if (isExportAssignment(stmt) && !(stmt as any).isExportEquals) {
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
 * Mirrors createExtensionRewriteTransformer. TypeScript's own
 * `rewriteRelativeImportExtensions` has already turned `.ts`/`.cts`/`.mts` into
 * `.js`/`.cjs`/`.mjs` by this point, so only `.js` and extensionless specifiers
 * are left to map onto the build's output extension.
 */
function mapSpecifier(
  specifier: string,
  sourceFileName: string,
  ext: string,
  rootDir: string,
  onAssetImport: (relPath: string) => void
): string {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return specifier;

  // A declaration path is not a module specifier to remap: `./module.d.ts`
  // would otherwise be read as extension ".ts" and mangled into "./module.d.cjs".
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

/** Walks a TS 7 AST read-only; `visitEachChild` is the traversal primitive it exposes. */
function walk(node: any, visit: (node: any) => void): void {
  visit(node);
  visitEachChild(node, (child: any) => {
    walk(child, visit);
    return child;
  });
}

/**
 * The specifiers the classic transformer rewrites, read off the SOURCE file:
 * `import`/`export ... from`, and dynamic `import()` with a literal argument.
 * Nothing else is touched — not `import x = require()`, not a hand-written
 * `require()`, not an `import("./x")` type in a declaration file — so the map
 * built here is what decides which literals in the emitted output may change.
 */
function collectSpecifierRewrites(
  sourceFile: any,
  sourceFileName: string,
  ext: string,
  rootDir: string,
  onAssetImport: (relPath: string) => void
): Map<string, string> {
  const rewrites = new Map<string, string>();
  walk(sourceFile, (node) => {
    let literal: any;
    if (isImportDeclaration(node) || isExportDeclaration(node)) {
      literal = node.moduleSpecifier;
    } else if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
      literal = node.arguments[0];
    }
    if (!literal || !isStringLiteral(literal) || rewrites.has(literal.text)) return;
    const mapped = mapSpecifier(literal.text, sourceFileName, ext, rootDir, onAssetImport);
    if (mapped === literal.text) return;
    // A declaration file carries the source specifier verbatim, but in the
    // JavaScript TypeScript's own `rewriteRelativeImportExtensions` has already
    // turned `./a.ts` into `./a.js`, so the rewrite is keyed by both spellings.
    // A `.tsx`/`.cts`/`.mts` specifier gets no entry at all — the classic
    // transformer only remaps `.js` and `.ts` — and keeps whatever TypeScript
    // emitted for it.
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

/**
 * The by-position equivalents of the classic `before` transformers, computed
 * on the parsed EMITTED file so that a string in any other position — a default
 * parameter, an object key, a comment — is never mistaken for a specifier.
 *
 * Specifier positions: `import`/`export ... from` and dynamic `import()` in an
 * ES module; the `require()` calls those lower to in a CommonJS one. A literal
 * is rewritten only if the source-side map says the classic transformer would
 * have rewritten it, and it is re-emitted double-quoted because the classic
 * transformer replaces the node with a fresh `createStringLiteral`.
 *
 * `import.meta.url` / `.dirname` / `.filename` are replaced as property
 * accesses on the `import.meta` meta-property, mirroring tx-import-meta-shim.
 */
function collectEmitEdits(
  emitted: any,
  rewrites: Map<string, string>,
  isCommonJs: boolean,
  shimImportMeta: boolean
): TextEdit[] {
  const edits: TextEdit[] = [];
  walk(emitted, (node) => {
    if (isStringLiteral(node) && rewrites.has(node.text)) {
      const parent = node.parent;
      const isSpecifier =
        ((isImportDeclaration(parent) || isExportDeclaration(parent)) && parent.moduleSpecifier === node) ||
        (isCallExpression(parent) &&
          parent.arguments[0] === node &&
          (parent.expression.kind === SyntaxKind.ImportKeyword ||
            (isCommonJs && isIdentifier(parent.expression) && parent.expression.text === "require")));
      if (isSpecifier) {
        edits.push({ start: node.getStart(emitted), end: node.end, text: `"${rewrites.get(node.text)}"` });
      }
      return;
    }

    if (
      shimImportMeta &&
      isPropertyAccessExpression(node) &&
      isMetaProperty(node.expression) &&
      node.expression.keywordToken === SyntaxKind.ImportKeyword
    ) {
      const replacement =
        node.name.text === "url"
          ? 'require("url").pathToFileURL(__filename)'
          : node.name.text === "dirname"
            ? "__dirname"
            : node.name.text === "filename"
              ? "__filename"
              : undefined;
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
 * Parses a batch of emitted files through one VFS-backed program and hands
 * their source files to `fn`, keyed by the caller's path. The TS 7 API does not
 * expose `createSourceFile`, so this is how the engine reads its own output:
 * each file keeps its real extension so `.d.cts` parses as a declaration file
 * and `.mjs` as an ES module.
 */
function withParsedOutputs<T>(files: Map<string, string>, fn: (get: (key: string) => any) => T): T {
  if (files.size === 0) return fn(() => undefined);

  const virtualRoot = "/zshy-emit-analysis";
  const virtualPaths = new Map<string, string>();
  let i = 0;
  for (const key of files.keys()) virtualPaths.set(key, `${virtualRoot}/${i++}-${path.basename(key)}`);
  const byVirtual = new Map([...virtualPaths].map(([key, v]) => [v, files.get(key)!]));

  const api = new API({
    cwd: virtualRoot,
    fs: {
      readFile: (p) => (byVirtual.has(p) ? byVirtual.get(p) : undefined),
      fileExists: (p) => (byVirtual.has(p) ? true : undefined),
      directoryExists: (p) => (p === virtualRoot ? true : undefined),
    },
  });
  try {
    const program = api.createProgram(
      [...byVirtual.keys()].map((p) => ({ uri: fileNameToDocumentURI(p) })),
      {
        compilerOptions: {
          allowJs: true,
          checkJs: false,
          noEmit: true,
          noLib: true,
          noResolve: true,
          types: [],
          skipLibCheck: true,
          module: ModuleKind.CommonJS,
          target: ScriptTarget.Latest,
        } as any,
      }
    );
    return fn((key) => {
      const vpath = virtualPaths.get(key);
      return vpath ? program.getSourceFile({ uri: fileNameToDocumentURI(vpath) }) : undefined;
    });
  } finally {
    api.close();
  }
}

/**
 * Appends a statement the way a trailing statement added by a `before` /
 * `afterDeclarations` transformer is printed: as the last line of code, ahead
 * of the `//# sourceMappingURL=` comment the printer writes after everything.
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
 * Case A — `export default <identifier>;` becomes `export = <identifier>;` in
 * place. Case B — `export default class C {}` / `export default function f()`
 * loses the `export default` modifiers, gains `declare`, and picks up a
 * trailing `export = C;`.
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
// sealCjsExports — the epilogue text and `appendSealEpilogue` are imported from
// compile.ts so there is one copy of what gets emitted. Only the two analyses
// change substrate: the classic engine parses the emitted CommonJS with
// `ts.createSourceFile`, which the TS 7 API does not expose, so the emitted
// files go through `withParsedOutputs` instead.
// ---------------------------------------------------------------------------

function isExportsNamespace(node: any): boolean {
  if (isIdentifier(node)) return node.text === "exports";
  return (
    isPropertyAccessExpression(node) &&
    isIdentifier((node as any).expression) &&
    (node as any).expression.text === "module" &&
    (node as any).name.text === "exports"
  );
}

function writesExportsProperty(node: any): boolean {
  let target: any;
  if (
    isBinaryExpression(node) &&
    (node as any).operatorToken.kind >= SyntaxKind.FirstAssignment &&
    (node as any).operatorToken.kind <= SyntaxKind.LastAssignment
  ) {
    target = (node as any).left;
  } else if (
    (isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) &&
    ((node as any).operator === SyntaxKind.PlusPlusToken || (node as any).operator === SyntaxKind.MinusMinusToken)
  ) {
    target = (node as any).operand;
  }

  if (!target) return false;
  return (
    (isPropertyAccessExpression(target) || isElementAccessExpression(target)) && isExportsNamespace(target.expression)
  );
}

/** Walks a parsed emitted-CommonJS file for the two facts the seal depends on. */
function analyzeCjsEmit(source: any): CjsEmitFacts {
  const facts: CjsEmitFacts = { writesExportsLate: false, rebindsModuleExports: false };

  const visit = (node: any, insideFunction: boolean): void => {
    if (
      !facts.rebindsModuleExports &&
      !insideFunction &&
      isBinaryExpression(node) &&
      node.operatorToken.kind === SyntaxKind.EqualsToken &&
      isPropertyAccessExpression(node.left) &&
      isIdentifier(node.left.expression) &&
      node.left.expression.text === "module" &&
      node.left.name.text === "exports"
    ) {
      facts.rebindsModuleExports = true;
    }
    if (!facts.writesExportsLate && insideFunction && writesExportsProperty(node)) {
      facts.writesExportsLate = true;
    }
    // The classic engine asks `isFunctionLike`, which the TS 7 guards do not
    // export; on emitted JavaScript the only function-like nodes are
    // declarations, so the narrower guard covers the same set.
    const nested = insideFunction || isFunctionLikeDeclaration(node);
    // visitEachChild is the traversal primitive the TS 7 AST exposes; the
    // visitor returns each node unchanged, so this is a read-only walk.
    visitEachChild(node, (child: any) => {
      visit(child, nested);
      return child;
    });
  };

  visit(source, false);
  return facts;
}

/**
 * A named re-export of a live `export let` cannot be told apart from one of a
 * constant once emitted, so any mutable exported binding anywhere in the build
 * disables settling everywhere. Mirrors the classic implementation exactly.
 */
function hasMutableExportedBinding(source: any): boolean {
  const mutableLocals = new Set<string>();
  for (const statement of source.statements) {
    if (!isVariableStatement(statement)) continue;
    const isConst = ((statement as any).declarationList.flags & NodeFlags.Const) !== 0;
    if (isConst) continue;
    const exported = hasModifier(statement, SyntaxKind.ExportKeyword);
    for (const declaration of (statement as any).declarationList.declarations) {
      if (!isIdentifier(declaration.name)) continue;
      if (exported) return true;
      mutableLocals.add(declaration.name.text);
    }
  }

  return source.statements.some(
    (statement: any) =>
      isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      isNamedExports(statement.exportClause) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause.elements.some((element: any) =>
        mutableLocals.has((element.propertyName ?? element.name).text)
      )
  );
}

/**
 * TypeScript 7's `createProgram` does not perform the automatic `@types`
 * inclusion that `tsc` and the classic `createProgram` do: with `types` unset,
 * the program simply has no ambient type packages, so `console`, `process` and
 * friends all go unresolved. Enumerating `node_modules/@types` and passing the
 * names explicitly reproduces the classic behaviour.
 *
 * Gap in the 7.1 nightly (measured against typescript@5.8.3 with identical
 * options: 3 diagnostics vs 31). Remove this once the API auto-includes.
 */
function discoverAtTypes(startDir: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let dir = startDir;

  while (true) {
    const typesDir = path.join(dir, "node_modules", "@types");
    if (fs.existsSync(typesDir)) {
      for (const entry of fs.readdirSync(typesDir)) {
        if (entry.startsWith(".") || seen.has(entry)) continue;
        seen.add(entry);
        names.push(entry);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return names;
}

/**
 * TypeScript 7 removed `baseUrl` (and with it, non-relative `paths` targets,
 * which are rejected with "Non-relative paths are not allowed"). A tsconfig
 * that still uses them cannot produce a program at all.
 *
 * Rather than fail the build, rewrite the pair into the form TS 7 accepts:
 * every `paths` target is resolved against the old `baseUrl` and re-expressed
 * relative to the tsconfig directory, which is what `paths` is resolved
 * against once `baseUrl` is gone. Resolution is unchanged, and emit is
 * unaffected either way — zshy does not rewrite alias specifiers.
 */
function migrateRemovedPathOptions(options: Record<string, any>, configDir: string): Record<string, any> {
  const { baseUrl, paths, ...rest } = options;
  if (!baseUrl && !paths) return options;

  const resolveBase = baseUrl ? path.resolve(configDir, baseUrl) : configDir;
  const migrated: Record<string, string[]> = {};

  for (const [pattern, targets] of Object.entries((paths ?? {}) as Record<string, string[]>)) {
    migrated[pattern] = targets.map((target) => {
      if (target.startsWith("./") || target.startsWith("../")) return target;
      const relative = utils.toPosix(path.relative(configDir, path.resolve(resolveBase, target)));
      return relative.startsWith(".") ? relative : `./${relative}`;
    });
  }

  return paths ? { ...rest, paths: migrated } : rest;
}

export async function compileProjectTs7(
  config: ProjectOptions,
  entryPoints: string[],
  ctx: BuildContext
): Promise<void> {
  const assetImports = new Set<string>();
  const jsExt = `.${config.ext}`;
  const dtsExt = config.ext === "mjs" ? ".d.mts" : config.ext === "cjs" ? ".d.cts" : ".d.ts";

  const api = new API({ cwd: config.pkgJsonDir });

  try {
    const rootFiles = entryPoints.map((entry) => ({
      uri: fileNameToDocumentURI(path.resolve(config.pkgJsonDir, entry)),
    }));

    // TypeScript 7 removed `moduleResolution: node10` (TS5108) and `classic`.
    // main.ts forces node10 for the CommonJS pass; dropping it there lets TS 7's
    // default apply, since Node16/NodeNext would change the emit. The ESM pass
    // keeps the `bundler` it asked for.
    const { moduleResolution, ...withoutModuleResolution } = config.compilerOptions as any;
    const keepsModuleResolution =
      moduleResolution === ModuleResolutionKind.Bundler ||
      moduleResolution === ModuleResolutionKind.Node16 ||
      moduleResolution === ModuleResolutionKind.NodeNext;
    const rest = migrateRemovedPathOptions(withoutModuleResolution, path.dirname(config.configPath));
    const compilerOptions = {
      ...rest,
      ...(keepsModuleResolution ? { moduleResolution } : {}),
      module: config.format === "cjs" ? ModuleKind.CommonJS : ModuleKind.ESNext,
      rootDir: config.rootDir,
      types: rest.types ?? discoverAtTypes(config.pkgJsonDir),
    };

    const program = api.createProgram(rootFiles, { compilerOptions });

    // The same set, in the same order, as the classic `ts.getPreEmitDiagnostics`:
    // declaration-emit diagnostics are part of it whenever `declaration` is on,
    // which for zshy is always.
    const diagnostics = [
      ...program.getConfigFileParsingDiagnostics(),
      ...program.getProgramDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSemanticDiagnostics(),
      ...(rest.declaration || rest.composite ? program.getDeclarationDiagnostics() : []),
    ];

    // ts1343 (`import.meta` outside an ESM target) and ts1259 are expected for
    // the CJS pass, because the import.meta shim runs after the checker.
    //
    // ts2882 ("cannot find module or type declarations for side-effect import")
    // is new in TypeScript 7 and fires on asset imports such as `import
    // "./styles.css"`. zshy supports those deliberately — it detects them and
    // copies the file — so the diagnostic is suppressed for specifiers zshy
    // recognises as assets.
    const filtered = diagnostics.filter((d: any) => {
      if (config.format === "cjs" && (d.code === 1343 || d.code === 1259)) return false;
      if (d.code === 2882 && typeof d.text === "string") {
        const match = /side-effect import of '([^']+)'/.exec(d.text);
        if (match?.[1] && utils.isAssetFile(match[1])) return false;
      }
      return true;
    });

    const errors = filtered.filter((d: any) => d.category === 1);
    const warnings = filtered.filter((d: any) => d.category === 0);
    ctx.errorCount += errors.length;
    ctx.warningCount += warnings.length;

    if (errors.length > 0 || warnings.length > 0) {
      utils.log.warn(`Found ${errors.length} error(s) and ${warnings.length} warning(s)`);
      const relevant = filtered.filter((d: any) => d.category === 1 || d.category === 0);
      console.log(formatDiagnosticsWithColorAndContext(relevant, program));
    }

    const output = program.emitToString();

    if (output.emitSkipped) {
      utils.log.error("Emit was skipped due to errors");
    }

    // Emit-time diagnostics count like the classic engine's `emitResult.diagnostics`.
    if (output.diagnostics.length > 0) {
      const emitDiagnostics =
        config.format === "cjs" ? output.diagnostics.filter((d: any) => d.code !== 1343) : output.diagnostics;
      const emitErrors = emitDiagnostics.filter((d: any) => d.category === 1);
      const emitWarnings = emitDiagnostics.filter((d: any) => d.category === 0);
      ctx.errorCount += emitErrors.length;
      ctx.warningCount += emitWarnings.length;
      utils.log.error(`Found ${emitErrors.length} error(s) and ${emitWarnings.length} warning(s) during emit:`);
      console.log(formatDiagnosticsWithColorAndContext([...emitErrors, ...emitWarnings], program));
    }

    // The classic engine writes nothing once it has seen an error, and the
    // emitter's own verdict is honoured too: a skipped emit is not output.
    const shouldWriteFiles = errors.length === 0 && !output.emitSkipped;

    // Outputs are computed first and written last: the specifier rewrite needs
    // the emitted files parsed, and the seal epilogue needs every CommonJS
    // file's final text (interop line included) parsed again, both in one
    // batch per pass rather than one program per file.
    interface PendingOutput {
      outputPath: string;
      finalPath: string;
      text: string;
      sourceFileName: string | undefined;
      isJs: boolean;
      isDts: boolean;
      // CommonJS by OUTPUT extension: a .cts source emits .cjs from BOTH passes
      // and the ESM pass writes last, so a .cjs is CommonJS whichever pass made
      // it; a .js is CommonJS only in the CJS pass, and .mjs is real ESM.
      isCommonJs: boolean;
    }
    const pending: PendingOutput[] = [];

    for (const [outputPath, file] of output.outputFiles) {
      const sourceFileName = file.sourceFileName;
      let text = file.text;

      // A .cts source emits .cjs and .d.cts; a .mts source emits .mjs and
      // .d.mts. Matching only ".js"/".d.ts" would treat those as assets and
      // copy the TypeScript source over the emitted output.
      const isMap = outputPath.endsWith(".map");
      const isDts = /\.d\.(ts|cts|mts)$/.test(outputPath);
      const isJs = !isDts && !isMap && /\.(js|cjs|mjs)$/.test(outputPath);
      const isCommonJs = outputPath.endsWith(".cjs") || (config.format === "cjs" && outputPath.endsWith(".js"));

      // Non-code outputs (a resolveJsonModule .json, for instance) are assets:
      // copy the source bytes rather than the emitted text. TypeScript 7
      // re-serialises JSON with its own indentation, which would rewrite the
      // user's file for no reason.
      if (!isJs && !isDts && !isMap && sourceFileName && fs.existsSync(sourceFileName)) {
        text = fs.readFileSync(sourceFileName, "utf8");
      }

      // Rename to the build's output extensions, exactly as the classic
      // `host.writeFile` override does.
      let finalPath = outputPath;
      if (outputPath.endsWith(".js")) finalPath = outputPath.replace(/\.js$/, jsExt);
      else if (outputPath.endsWith(".d.ts")) finalPath = outputPath.replace(/\.d\.ts$/, dtsExt);
      else if (outputPath.endsWith(".js.map")) finalPath = outputPath.replace(/\.js\.map$/, `${jsExt}.map`);
      else if (outputPath.endsWith(".d.ts.map")) finalPath = outputPath.replace(/\.d\.ts\.map$/, `${dtsExt}.map`);

      pending.push({ outputPath, finalPath, text, sourceFileName, isJs, isDts, isCommonJs });
    }

    // The classic `before` / `afterDeclarations` transformers: specifier
    // rewriting on both JS and declarations, the import.meta shim on CommonJS
    // JS in the CJS pass, then the CJS interop line or its declaration form.
    const code = pending.filter((p) => p.sourceFileName && (p.isJs || p.isDts));
    const rewritesBySource = new Map<string, Map<string, string>>();
    withParsedOutputs(new Map(code.map((p) => [p.finalPath, p.text])), (parsed) => {
      for (const entry of code) {
        const sourceFileName = entry.sourceFileName!;
        let rewrites = rewritesBySource.get(sourceFileName);
        if (!rewrites) {
          const sourceFile = program.getSourceFile({ uri: fileNameToDocumentURI(sourceFileName) });
          rewrites = sourceFile
            ? collectSpecifierRewrites(sourceFile, sourceFileName, jsExt, config.rootDir, (asset) =>
                assetImports.add(asset)
              )
            : new Map();
          rewritesBySource.set(sourceFileName, rewrites);
        }

        const emitted = parsed(entry.finalPath);
        if (!emitted) continue;
        const shimImportMeta = entry.isJs && entry.isCommonJs && config.format === "cjs";
        entry.text = applyEdits(entry.text, collectEmitEdits(emitted, rewrites, entry.isCommonJs, shimImportMeta));
      }
    });

    if (config.cjsInterop && config.format === "cjs") {
      for (const entry of code) {
        const sourceFile = program.getSourceFile({ uri: fileNameToDocumentURI(entry.sourceFileName!) });
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
      const sealed = pending.filter((p) => p.isJs && p.isCommonJs);

      // Cleared if any source file in the build exports a mutable binding.
      // The classic engine reads `program.getSourceFiles()` in process; here
      // every source file costs a round trip, and the program includes the
      // whole lib and every `@types` package — 90 files and 2.4 MB on a
      // three-file fixture. A `.d.ts` name is always a declaration file, so
      // rejecting those by name is the same filter without the fetch; the
      // survivors are still checked on `isDeclarationFile` as before.
      const settleAccessors = !program
        .getSourceFileNames()
        .filter((name) => !/\.d\.(ts|cts|mts)$/.test(name))
        .some((name) => {
          const source = program.getSourceFile({ uri: fileNameToDocumentURI(name) });
          return source !== undefined && !source.isDeclarationFile && hasMutableExportedBinding(source);
        });

      withParsedOutputs(new Map(sealed.map((p) => [p.finalPath, p.text])), (parsed) => {
        for (const entry of sealed) {
          const emitted = parsed(entry.finalPath);
          if (emitted) entry.text = appendSealEpilogue(entry.text, analyzeCjsEmit(emitted), settleAccessors);
        }
      });
    }

    for (const { finalPath, text } of pending) {
      ctx.writtenFiles.add(finalPath);
      if (!config.dryRun && shouldWriteFiles) {
        fs.mkdirSync(path.dirname(finalPath), { recursive: true });
        fs.writeFileSync(finalPath, text);
      }
    }

    // Copy assets discovered during specifier rewriting.
    for (const assetPath of assetImports) {
      const sourceFile = path.resolve(config.rootDir, assetPath);
      if (!fs.existsSync(sourceFile)) continue;

      const destFile = path.resolve(config.compilerOptions.outDir, assetPath);
      const posixDestFile = utils.toPosix(destFile);
      if (ctx.copiedAssets.has(posixDestFile)) continue;

      ctx.writtenFiles.add(posixDestFile);
      ctx.copiedAssets.add(posixDestFile);

      if (!config.dryRun) {
        fs.mkdirSync(path.dirname(destFile), { recursive: true });
        fs.copyFileSync(sourceFile, destFile);
      }
    }
  } finally {
    api.close();
  }
}
