import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { createCjsInteropTransformer } from "./tx-cjs-interop.js";
import { createCjsInteropDeclarationTransformer } from "./tx-cjs-interop-declaration.js";
import { createExportEqualsTransformer } from "./tx-export-equals.js";
import { createExtensionRewriteTransformer } from "./tx-extension-rewrite.js";
import { createImportMetaShimTransformer } from "./tx-import-meta-shim.js";
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

  host.writeFile = (fileName, data, writeByteOrderMark, onError, sourceFiles) => {
    // Transform output file extensions
    let outputFileName = fileName;
    const processedData = data;
    if (fileName.endsWith(".js")) {
      outputFileName = fileName.replace(/\.js$/, jsExt);
    }

    if (fileName.endsWith(".d.ts")) {
      outputFileName = fileName.replace(/\.d\.ts$/, dtsExt);
    }
    // Handle source map files
    if (fileName.endsWith(".js.map")) {
      outputFileName = fileName.replace(/\.js\.map$/, jsExt + ".map");
    }

    if (fileName.endsWith(".d.ts.map")) {
      outputFileName = fileName.replace(/\.d\.ts\.map$/, dtsExt + ".map");
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
    // Filter out ts1343 errors for CJS builds
    const filteredDiagnostics = diagnostics.filter((d) => {
      if (config.format === "cjs") {
        return d.code !== 1343 && d.code !== 1259;
      }
    }); // Ignore ts1343 (import.meta not available) for CJS

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
      utils.emojiLog("⚠️", `Found ${errorCount} error(s) and ${warningCount} warning(s)`, "warn");
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
  const before: ts.TransformerFactory<ts.SourceFile>[] = [
    extensionRewriteTransformer as ts.TransformerFactory<ts.SourceFile>,
  ];
  const after: ts.TransformerFactory<ts.SourceFile>[] = [];
  const afterDeclarations: ts.TransformerFactory<ts.SourceFile | ts.Bundle>[] = [extensionRewriteTransformer];

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
      utils.emojiLog("🔄", `Enabling CJS interop transform...`);
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
    utils.emojiLog("❌", "Emit was skipped due to errors", "error");
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

    utils.emojiLog(
      "❌",
      `Found ${emitErrors.length} error(s) and ${emitWarnings.length} warning(s) during emit:`,
      "error"
    );
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
      utils.emojiLog("📄", `Found ${assetImports.size} asset import(s), copying to output directory...`);
    }

    // utils.copyAssets(assetImports, config, ctx);
    for (const assetPath of assetImports) {
      try {
        // Asset paths are now relative to rootDir
        const sourceFile = path.resolve(config.rootDir, assetPath);

        if (!fs.existsSync(sourceFile)) {
          if (config.verbose) {
            utils.emojiLog("⚠️", `Asset not found: ${assetPath} (resolved to ${sourceFile})`, "warn");
          }
          continue;
        }

        // Create the destination path in outDir, maintaining the same relative structure
        const destFile = path.resolve(config.compilerOptions.outDir, assetPath);

        // Skip if this asset has already been copied
        if (ctx.copiedAssets.has(destFile)) {
          continue;
        }

        const destDir = path.dirname(destFile);

        // Track the file that would be copied
        // Use posix paths here because typescript also outputs them posix
        // style.
        ctx.writtenFiles.add(utils.toPosix(destFile));
        ctx.copiedAssets.add(destFile);

        if (!config.dryRun) {
          // Ensure destination directory exists
          fs.mkdirSync(destDir, { recursive: true });

          // Copy the file
          fs.copyFileSync(sourceFile, destFile);
        }

        if (config.verbose) {
          const relativeSource = config.pkgJsonDir ? utils.toPosix(path.relative(config.pkgJsonDir, sourceFile)) : sourceFile;
          const relativeDest = config.pkgJsonDir ? utils.toPosix(path.relative(config.pkgJsonDir, destFile)) : destFile;
          utils.emojiLog(
            "📄",
            `${config.dryRun ? "[dryrun] " : ""}Copied asset: ./${relativeSource} → ./${relativeDest}`
          );
        }
      } catch (error) {
        utils.emojiLog("❌", `Failed to copy asset ${assetPath}: ${error}`, "error");
      }
    }
  }
}
