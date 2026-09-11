import * as fs from "node:fs";
import * as path from "node:path";
import { NodeFlags, ScriptTarget, SyntaxKind } from "typescript-next/unstable/ast";
import {
  isBinaryExpression,
  isClassDeclaration,
  isElementAccessExpression,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isFunctionLikeDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isNamedExports,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isTypeAliasDeclaration,
  isVariableStatement,
} from "typescript-next/unstable/ast/is";
import { visitEachChild } from "typescript-next/unstable/ast/visitor";
import { API, fileNameToDocumentURI, ModuleKind } from "typescript-next/unstable/sync";
import type { BuildContext, ProjectOptions } from "./compile.js";
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

/** Rewrites every quoted relative module specifier in emitted text. */
function rewriteSpecifiers(
  text: string,
  sourceFileName: string,
  ext: string,
  rootDir: string,
  onAssetImport: (relPath: string) => void
): string {
  return text
    .split("\n")
    .map((line) => {
      // `/// <reference path="./x.ts" />` is a compiler directive, not an import.
      if (/^\s*\/\/\/\s*</.test(line)) return line;
      return line.replace(/(["'])(\.\.?\/[^"'\n]*)\1/g, (whole, quote, spec) => {
        const mapped = mapSpecifier(spec, sourceFileName, ext, rootDir, onAssetImport);
        return mapped === spec ? whole : `${quote}${mapped}${quote}`;
      });
    })
    .join("\n");
}

/** Mirrors createImportMetaShimTransformer. */
function applyImportMetaShim(text: string): string {
  return text
    .replace(/\bimport\.meta\.url\b/g, 'require("url").pathToFileURL(__filename)')
    .replace(/\bimport\.meta\.dirname\b/g, "__dirname")
    .replace(/\bimport\.meta\.filename\b/g, "__filename");
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
  const body = text.replace(declarationForm, `declare $1 ${name}`);
  const trailingComment = /\n(\/\/# sourceMappingURL=.*)$/.exec(body);

  if (trailingComment) {
    return body.replace(trailingComment[0], `\nexport = ${name};\n${trailingComment[1]}`);
  }
  return `${body.replace(/\n?$/, "\n")}export = ${name};\n`;
}

// ---------------------------------------------------------------------------
// sealCjsExports — port of the epilogue in compile.ts. The epilogue text is
// identical; only the two analyses change substrate. The classic engine parses
// the emitted CommonJS with `ts.createSourceFile`, which the TS 7 API does not
// expose, so the emitted files are parsed through a second, VFS-backed program
// instead (one program for all of them, not one per file).
// ---------------------------------------------------------------------------

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

const SEAL_CJS_EXPORTS_FREEZE = "  Object.freeze(exports);";

interface CjsEmitFacts {
  // `exports.x` written from inside a function runs after the epilogue, so freezing would make it throw
  writesExportsLate: boolean;
  // `module.exports = ...` hands callers something other than the object the epilogue seals, so sealing it achieves nothing
  rebindsModuleExports: boolean;
}

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

/** Above the sourceMappingURL comment so it stays last; every existing line keeps its position. */
function appendSealEpilogue(data: string, facts: CjsEmitFacts, settleAccessors: boolean): string {
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
 * Parses a batch of emitted CommonJS files through one VFS-backed program and
 * returns the seal facts for each, keyed by the caller's path.
 */
function analyzeEmittedCommonJs(files: Map<string, string>): Map<string, CjsEmitFacts> {
  const results = new Map<string, CjsEmitFacts>();
  if (files.size === 0) return results;

  const virtualRoot = "/zshy-seal-analysis";
  const virtualPaths = new Map<string, string>();
  let i = 0;
  for (const key of files.keys()) virtualPaths.set(key, `${virtualRoot}/${i++}.cjs`);
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
          types: [],
          skipLibCheck: true,
          module: ModuleKind.CommonJS,
          target: ScriptTarget.Latest,
        } as any,
      }
    );
    for (const [key, vpath] of virtualPaths) {
      const source = program.getSourceFile({ uri: fileNameToDocumentURI(vpath) });
      results.set(key, source ? analyzeCjsEmit(source) : { writesExportsLate: false, rebindsModuleExports: false });
    }
  } finally {
    api.close();
  }
  return results;
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

    // TypeScript 7 removed `moduleResolution: node10` (TS5108). Leaving it unset
    // lets the CommonJS pass fall back to the classic resolver, which is what
    // node10 selected; Node16/NodeNext reject this program outright.
    const { moduleResolution, ...withoutModuleResolution } = config.compilerOptions as any;
    const rest = migrateRemovedPathOptions(withoutModuleResolution, path.dirname(config.configPath));
    const compilerOptions = {
      ...rest,
      module: config.format === "cjs" ? ModuleKind.CommonJS : ModuleKind.ESNext,
      rootDir: config.rootDir,
      types: rest.types ?? discoverAtTypes(config.pkgJsonDir),
    };

    const program = api.createProgram(rootFiles, { compilerOptions });

    const diagnostics = [
      ...program.getProgramDiagnostics(),
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
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
      for (const d of filtered as any[]) {
        if (d.category === 1 || d.category === 0) {
          console.log(`${d.file ?? ""}: ${d.text ?? d.messageText ?? ""}`);
        }
      }
    }

    const shouldWriteFiles = errors.length === 0;
    const output = program.emitToString();

    // Outputs are computed first and written last, because the seal epilogue
    // needs every CommonJS file's final text (interop line included) in hand
    // before it can parse them as one batch.
    const pending: Array<{ finalPath: string; text: string; emitsCommonJs: boolean }> = [];

    for (const [outputPath, file] of output.outputFiles) {
      const sourceFileName = file.sourceFileName;
      let text = file.text;

      // A .cts source emits .cjs and .d.cts; a .mts source emits .mjs and
      // .d.mts. Matching only ".js"/".d.ts" would treat those as assets and
      // copy the TypeScript source over the emitted output.
      const isMap = outputPath.endsWith(".map");
      const isDts = /\.d\.(ts|cts|mts)$/.test(outputPath);
      const isJs = !isDts && !isMap && /\.(js|cjs|mjs)$/.test(outputPath);
      // .mjs output is an ES module even during the CommonJS pass, so the
      // CommonJS-only rewrites must not touch it.
      const isCommonJsOutput = isJs && !outputPath.endsWith(".mjs");

      // Non-code outputs (a resolveJsonModule .json, for instance) are assets:
      // copy the source bytes rather than the emitted text. TypeScript 7
      // re-serialises JSON with its own indentation, which would rewrite the
      // user's file for no reason.
      if (!isJs && !isDts && !isMap && sourceFileName && fs.existsSync(sourceFileName)) {
        text = fs.readFileSync(sourceFileName, "utf8");
      }

      if (sourceFileName && (isJs || isDts)) {
        if (isCommonJsOutput && config.format === "cjs") {
          text = applyImportMetaShim(text);
        }

        text = rewriteSpecifiers(text, sourceFileName, isDts ? jsExt : jsExt, config.rootDir, (asset) =>
          assetImports.add(asset)
        );

        if (config.cjsInterop && config.format === "cjs") {
          const sourceFile = program.getSourceFile({ uri: fileNameToDocumentURI(sourceFileName) });
          if (sourceFile) {
            const shape = analyzeExportShape(sourceFile);
            const applies = shape.hasDefaultExport && !shape.hasNamedExports && !shape.hasTypeOnlyExports;
            if (applies && isCommonJsOutput) {
              text = `${text.replace(/\n?$/, "\n")}module.exports = exports.default;\n`;
            } else if (applies && isDts && !outputPath.endsWith(".d.mts")) {
              text = applyDeclarationInterop(text);
            }
          }
        }
      }

      // Rename to the build's output extensions, exactly as the classic
      // `host.writeFile` override does.
      let finalPath = outputPath;
      if (outputPath.endsWith(".js")) finalPath = outputPath.replace(/\.js$/, jsExt);
      else if (outputPath.endsWith(".d.ts")) finalPath = outputPath.replace(/\.d\.ts$/, dtsExt);
      else if (outputPath.endsWith(".js.map")) finalPath = outputPath.replace(/\.js\.map$/, `${jsExt}.map`);
      else if (outputPath.endsWith(".d.ts.map")) finalPath = outputPath.replace(/\.d\.ts\.map$/, `${dtsExt}.map`);

      // A .cts source emits .cjs from BOTH passes and the ESM pass writes last,
      // so seal any .cjs output whichever pass produced it; a .js output is
      // CommonJS only in the CJS pass, and .mjs is real ESM with no `exports`.
      const emitsCommonJs = outputPath.endsWith(".cjs") || (config.format === "cjs" && outputPath.endsWith(".js"));
      pending.push({ finalPath, text, emitsCommonJs });
    }

    if (config.sealCjsExports) {
      const toAnalyze = new Map(pending.filter((p) => p.emitsCommonJs).map((p) => [p.finalPath, p.text]));
      const facts = analyzeEmittedCommonJs(toAnalyze);

      // Cleared if any source file in the build exports a mutable binding.
      const settleAccessors = !program.getSourceFileNames().some((name) => {
        const source = program.getSourceFile({ uri: fileNameToDocumentURI(name) });
        return source !== undefined && !source.isDeclarationFile && hasMutableExportedBinding(source);
      });

      for (const entry of pending) {
        if (!entry.emitsCommonJs) continue;
        const f = facts.get(entry.finalPath);
        if (f) entry.text = appendSealEpilogue(entry.text, f, settleAccessors);
      }
    }

    for (const { finalPath, text } of pending) {
      ctx.writtenFiles.add(finalPath);
      if (!config.dryRun && shouldWriteFiles) {
        fs.mkdirSync(path.dirname(finalPath), { recursive: true });
        fs.writeFileSync(finalPath, text);
      }
    }

    if (output.emitSkipped) {
      utils.log.error("Emit was skipped due to errors");
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
