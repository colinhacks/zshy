import * as fs from "node:fs";
import * as path from "node:path";
import { SyntaxKind } from "typescript-next/unstable/ast";
import {
  isClassDeclaration,
  isEnumDeclaration,
  isExportAssignment,
  isExportDeclaration,
  isFunctionDeclaration,
  isInterfaceDeclaration,
  isNamedExports,
  isTypeAliasDeclaration,
  isVariableStatement,
} from "typescript-next/unstable/ast/is";
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
