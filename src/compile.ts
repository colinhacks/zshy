import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { createCjsInteropTransformer } from "./tx-cjs-interop.js";
import { createCjsInteropDeclarationTransformer } from "./tx-cjs-interop-declaration.js";
import { createExportEqualsTransformer } from "./tx-export-equals.js";
import { createExtensionRewriteTransformer } from "./tx-extension-rewrite.js";
import { createImportMetaShimTransformer } from "./tx-import-meta-shim.js";
import { createPathsResolverTransformer } from "./tx-paths-resolver.js";
import * as utils from "./utils.js";

export interface BuildContext {
  writtenFiles: Set<string>;
  copiedAssets: Set<string>;
  errorCount: number;
  warningCount: number;
}

export interface ProjectOptions {
  configPath: string;
  compilerOptions: ts.CompilerOptions & Required<Pick<ts.CompilerOptions, "module" | "moduleResolution" | "outDir">>;
  ext: "cjs" | "js" | "mjs";
  format: "cjs" | "esm";
  pkgJsonDir: string; // Add package root for relative path display
  rootDir: string; // Add source root for asset copying
  verbose: boolean;
  dryRun: boolean;
  cjsInterop?: boolean; // Enable CJS interop for single default exports
  sealCjsExports?: boolean; // Freeze each CommonJS module's exports so re-exports settle into data properties
  paths?: Record<string, string[]>; // TypeScript paths configuration
  baseUrl?: string; // TypeScript baseUrl configuration
}

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

function isExportsNamespace(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === "exports";
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "module" &&
    node.name.text === "exports"
  );
}

function writesExportsProperty(node: ts.Node): boolean {
  let target: ts.Expression | undefined;
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    target = node.left;
  } else if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    target = node.operand;
  }

  if (!target) return false;
  return (
    (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) &&
    isExportsNamespace(target.expression)
  );
}

interface CjsEmitFacts {
  // `exports.x` written from inside a function runs after the epilogue, so freezing would make it throw
  writesExportsLate: boolean;
  // `module.exports = ...` hands callers something other than the object the epilogue seals, so sealing it achieves nothing
  rebindsModuleExports: boolean;
}

function analyzeCjsEmit(data: string): CjsEmitFacts {
  const source = ts.createSourceFile("emit.cjs", data, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  const facts: CjsEmitFacts = {
    writesExportsLate: false,
    rebindsModuleExports: false,
  };

  const visit = (node: ts.Node, insideFunction: boolean): void => {
    if (
      !facts.rebindsModuleExports &&
      !insideFunction &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === "module" &&
      node.left.name.text === "exports"
    ) {
      facts.rebindsModuleExports = true;
    }
    if (!facts.writesExportsLate && insideFunction && writesExportsProperty(node)) {
      facts.writesExportsLate = true;
    }
    const nested = insideFunction || ts.isFunctionLike(node);
    ts.forEachChild(node, (child) => visit(child, nested));
  };

  visit(source, false);
  return facts;
}

// above the sourceMappingURL comment so it stays last; either way every existing line keeps its position, so the source map holds
function appendSealEpilogue(data: string, settleAccessors: boolean): string {
  const facts = analyzeCjsEmit(data);
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
function hasMutableExportedBinding(source: ts.SourceFile): boolean {
  const mutableLocals = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
    if (isConst) continue;
    const exported = ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (exported) return true;
      mutableLocals.add(declaration.name.text);
    }
  }

  return source.statements.some(
    (statement) =>
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause.elements.some((element) => mutableLocals.has((element.propertyName ?? element.name).text))
  );
}

export async function compileProject(config: ProjectOptions, entryPoints: string[], ctx: BuildContext): Promise<void> {
  // Deduplicate entry points before compilation

  // Track asset imports encountered during transformation
  const assetImports = new Set<string>();

  // Create compiler host
  const host = ts.createCompilerHost(config.compilerOptions);
  const originalWriteFile = host.writeFile;

  const jsExt = "." + config.ext;
  const dtsExt = config.ext === "mjs" ? ".d.mts" : config.ext === "cjs" ? ".d.cts" : ".d.ts";

  // Track if we should write files (will be set after diagnostics check)
  let shouldWriteFiles = true;

  // cleared below if any source file exports a mutable binding
  let settleAccessors = true;

  host.writeFile = (fileName, data, writeByteOrderMark, onError, sourceFiles) => {
    // Transform output file extensions. When an extension is renamed we must
    // also rewrite the in-file references so the .cjs/.mjs build points at its
    // own source map instead of the original .js/.d.ts map (issue #71).
    let outputFileName = fileName;
    let processedData = data;
    if (fileName.endsWith(".js")) {
      outputFileName = fileName.replace(/\.js$/, jsExt);
      // Keep the trailing `//# sourceMappingURL=` comment pointing at the renamed map.
      // Anchored to end-of-file so a sourceMappingURL-looking string in user code is left alone.
      processedData = processedData.replace(/(\/\/# sourceMappingURL=\S+)\.js\.map(?=\s*$)/, `$1${jsExt}.map`);
    }

    // a `.cts` source emits `.cjs` from BOTH passes and the ESM pass writes last, so seal any `.cjs` output whichever pass produced it; a `.js` output is CommonJS only in the CJS pass, and `.mjs` is real ESM with no `exports`
    const emitsCommonJs = fileName.endsWith(".cjs") || (config.format === "cjs" && fileName.endsWith(".js"));
    if (config.sealCjsExports && emitsCommonJs) {
      processedData = appendSealEpilogue(processedData, settleAccessors);
    }

    if (fileName.endsWith(".d.ts")) {
      outputFileName = fileName.replace(/\.d\.ts$/, dtsExt);
      processedData = processedData.replace(/(\/\/# sourceMappingURL=\S+)\.d\.ts\.map(?=\s*$)/, `$1${dtsExt}.map`);
    }
    // Handle source map files
    if (fileName.endsWith(".js.map")) {
      outputFileName = fileName.replace(/\.js\.map$/, jsExt + ".map");
      // Keep the map's "file" field naming the renamed generated file.
      processedData = processedData.replace(/("file":\s*"[^"]+)\.js"/, `$1${jsExt}"`);
    }

    if (fileName.endsWith(".d.ts.map")) {
      outputFileName = fileName.replace(/\.d\.ts\.map$/, dtsExt + ".map");
      processedData = processedData.replace(/("file":\s*"[^"]+)\.d\.ts"/, `$1${dtsExt}"`);
    }

    // Track the file that would be written
    ctx.writtenFiles.add(outputFileName);

    if (!config.dryRun && shouldWriteFiles && originalWriteFile) {
      originalWriteFile(outputFileName, processedData, writeByteOrderMark, onError, sourceFiles);
    }
  };

  // Create the TypeScript program using unique entry points
  // For CJS builds, set noEmitOnError to false to allow emission despite ts1343 errors
  const programOptions = config.compilerOptions;

  const program = ts.createProgram({
    rootNames: entryPoints,
    options: programOptions,
    host,
  });

  if (config.sealCjsExports) {
    settleAccessors = !program
      .getSourceFiles()
      .some((source) => !source.isDeclarationFile && hasMutableExportedBinding(source));
  }

  // Create a transformer factory to resolve tsconfig paths
  const pathsResolverTransformer = config.paths
    ? createPathsResolverTransformer({
        baseUrl: config.baseUrl,
        paths: config.paths,
        tsconfigDir: path.dirname(config.configPath),
        rootDir: config.rootDir,
      })
    : null;

  // Create a transformer factory to rewrite extensions
  const extensionRewriteTransformer = createExtensionRewriteTransformer({
    rootDir: config.rootDir,
    ext: jsExt,
    onAssetImport: (assetPath: string) => {
      assetImports.add(assetPath);
    },
  });

  // Check for semantic errors
  const diagnostics = ts.getPreEmitDiagnostics(program);

  if (diagnostics.length > 0) {
    // Filter out diagnostics that are expected from CJS-only transforms.
    const filteredDiagnostics = diagnostics.filter((d) => {
      if (config.format === "cjs") {
        return d.code !== 1343 && d.code !== 1259;
      }

      return true;
    });

    const errorCount = filteredDiagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error).length;
    const warningCount = filteredDiagnostics.filter((d) => d.category === ts.DiagnosticCategory.Warning).length;

    // Update the build context with error and warning counts
    ctx.errorCount += errorCount;
    ctx.warningCount += warningCount;

    // Set shouldWriteFiles to false if there are errors (excluding ts1343 for CJS)
    if (errorCount > 0) {
      shouldWriteFiles = false;
    }

    if (errorCount > 0 || warningCount > 0) {
      utils.log.warn(`Found ${errorCount} error(s) and ${warningCount} warning(s)`);
    }

    // Format diagnostics with color and context like tsc, keeping original order
    const formatHost: ts.FormatDiagnosticsHost = {
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: (fileName) => fileName,
      getNewLine: () => ts.sys.newLine,
    };

    // Keep errors and warnings intermixed in their original order
    const relevantDiagnostics = filteredDiagnostics.filter(
      (d) => d.category === ts.DiagnosticCategory.Error || d.category === ts.DiagnosticCategory.Warning
    );

    if (relevantDiagnostics.length > 0) {
      console.log(ts.formatDiagnosticsWithColorAndContext(relevantDiagnostics, formatHost));
    }
  }

  // Prepare transformers
  const before: ts.TransformerFactory<ts.SourceFile>[] = [];

  // Add paths resolver transformer first if paths are configured
  if (pathsResolverTransformer) {
    before.push(pathsResolverTransformer as ts.TransformerFactory<ts.SourceFile>);
  }

  // Then add extension rewriter
  before.push(extensionRewriteTransformer as ts.TransformerFactory<ts.SourceFile>);

  const after: ts.TransformerFactory<ts.SourceFile>[] = [];
  const afterDeclarations: ts.TransformerFactory<ts.SourceFile | ts.Bundle>[] = [];

  // Add transformers for declarations
  if (pathsResolverTransformer) {
    afterDeclarations.push(pathsResolverTransformer);
  }
  afterDeclarations.push(extensionRewriteTransformer);

  // Add import.meta shim transformer for CJS builds
  if (config.format === "cjs") {
    before.unshift(createImportMetaShimTransformer());
  }

  // Add export = to export default transformer for ESM builds
  if (config.format === "esm") {
    createExportEqualsTransformer<ts.SourceFile>();
    // before.push(createExportEqualsTransformer<ts.SourceFile>());
    // afterDeclarations.push(createExportEqualsTransformer<ts.SourceFile | ts.Bundle>());
  }

  // Add CJS interop transformer for single default exports
  if (config.cjsInterop && config.format === "cjs") {
    if (config.verbose) {
      utils.log.info(`Enabling CJS interop transform...`);
    }
    before.push(createCjsInteropTransformer());
  }

  // Add CJS interop transformer for declaration files (export = transformation)
  if (config.cjsInterop && config.format === "cjs") {
    afterDeclarations.push(createCjsInteropDeclarationTransformer());
  }

  // emit the files
  const emitResult = program.emit(undefined, undefined, undefined, undefined, {
    before,
    after,
    afterDeclarations,
  });

  if (emitResult.emitSkipped) {
    utils.log.error("Emit was skipped due to errors");
  } else {
    // console.log(`✅ Emitted ${config.jsExtension} and ${config.dtsExtension}
    // files`);
  }

  // Report any emit diagnostics
  if (emitResult.diagnostics.length > 0) {
    // Filter out ts1343 errors for CJS builds
    const filteredEmitDiagnostics =
      config.format === "cjs"
        ? emitResult.diagnostics.filter((d) => d.code !== 1343) // Ignore ts1343 for CJS
        : emitResult.diagnostics;

    const emitErrors = filteredEmitDiagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
    const emitWarnings = filteredEmitDiagnostics.filter((d) => d.category === ts.DiagnosticCategory.Warning);

    // Update the build context with emit error and warning counts
    ctx.errorCount += emitErrors.length;
    ctx.warningCount += emitWarnings.length;

    utils.log.error(`Found ${emitErrors.length} error(s) and ${emitWarnings.length} warning(s) during emit:`);
    console.log();

    const formatHost: ts.FormatDiagnosticsHost = {
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: (fileName) => fileName,
      getNewLine: () => ts.sys.newLine,
    };

    // Keep errors and warnings intermixed in their original order
    const relevantEmitDiagnostics = filteredEmitDiagnostics.filter(
      (d) => d.category === ts.DiagnosticCategory.Error || d.category === ts.DiagnosticCategory.Warning
    );

    if (relevantEmitDiagnostics.length > 0) {
      console.log(ts.formatDiagnosticsWithColorAndContext(relevantEmitDiagnostics, formatHost));
    }
  }

  // Copy assets if any were found and rootDir is provided
  if (assetImports.size > 0) {
    if (config.verbose) {
      utils.log.info(`Found ${assetImports.size} asset import(s), copying to output directory...`);
    }

    // utils.copyAssets(assetImports, config, ctx);
    for (const assetPath of assetImports) {
      try {
        // Asset paths are now relative to rootDir
        const sourceFile = path.resolve(config.rootDir, assetPath);

        if (!fs.existsSync(sourceFile)) {
          if (config.verbose) {
            utils.log.warn(`Asset not found: ${assetPath} (resolved to ${sourceFile})`);
          }
          continue;
        }

        // Create the destination path in outDir, maintaining the same relative structure
        const destFile = path.resolve(config.compilerOptions.outDir, assetPath);
        const posixDestFile = utils.toPosix(destFile);

        // Skip if this asset has already been copied
        if (ctx.copiedAssets.has(posixDestFile)) {
          continue;
        }

        const destDir = path.dirname(destFile);

        // Track the file that would be copied
        // Use posix paths here because typescript also outputs them posix
        // style.
        ctx.writtenFiles.add(posixDestFile);
        ctx.copiedAssets.add(posixDestFile);

        if (!config.dryRun) {
          // Ensure destination directory exists
          fs.mkdirSync(destDir, { recursive: true });

          // Copy the file
          fs.copyFileSync(sourceFile, destFile);
        }

        if (config.verbose) {
          const relativeSource = config.pkgJsonDir ? utils.relativePosix(config.pkgJsonDir, sourceFile) : sourceFile;
          const relativeDest = config.pkgJsonDir ? utils.relativePosix(config.pkgJsonDir, destFile) : destFile;
          utils.log.info(`${config.dryRun ? "[dryrun] " : ""}Copied asset: ./${relativeSource} → ./${relativeDest}`);
        }
      } catch (error) {
        utils.log.error(`Failed to copy asset ${assetPath}: ${error}`);
      }
    }
  }
}
