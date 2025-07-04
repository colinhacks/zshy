import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

import * as utils from "./utils";

export interface BuildContext {
  writtenFiles: Set<string>;
  copiedAssets: Set<string>;
  errorCount: number;
  warningCount: number;
}

export interface ProjectOptions {
  configPath: string;
  compilerOptions: ts.CompilerOptions & Required<Pick<ts.CompilerOptions, "module" | "moduleResolution" | "outDir">>;
  mode: "cts" | "ts" | "mts";
  pkgJsonDir: string; // Add package root for relative path display
  rootDir: string; // Add source root for asset copying
  verbose: boolean;
  dryRun: boolean;
}

export async function compileProject(config: ProjectOptions, entryPoints: string[], ctx: BuildContext): Promise<void> {
  // Deduplicate entry points before compilation

  // Track asset imports encountered during transformation
  const assetImports = new Set<string>();

  // Create compiler host
  const host = ts.createCompilerHost(config.compilerOptions);
  const originalWriteFile = host.writeFile;

  const jsExt = config.mode === "mts" ? ".mjs" : config.mode === "cts" ? ".cjs" : ".js";
  const dtsExt = config.mode === "mts" ? ".d.mts" : config.mode === "cts" ? ".d.cts" : ".d.ts";
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

    if (!config.dryRun && originalWriteFile) {
      originalWriteFile(outputFileName, processedData, writeByteOrderMark, onError, sourceFiles);
    }
  };

  // Create the TypeScript program using unique entry points
  const program = ts.createProgram({
    rootNames: entryPoints,
    options: config.compilerOptions,
    host,
  });

  // Create a transformer factory to rewrite extensions
  const extensionRewriteTransformer: ts.TransformerFactory<ts.SourceFile | ts.Bundle> = (context) => {
    return (sourceFile) => {
      const visitor = (node: ts.Node): ts.Node => {
        const isImport = ts.isImportDeclaration(node);
        const isExport = ts.isExportDeclaration(node);
        const isDynamicImport = ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
        // const isImportOrExport  = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        //  || (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword);

        let originalText: string; // = isImport ? node.moduleSpecifier.text : isExport ? node.moduleSpecifier?.text :
        if (isImport || isExport || isDynamicImport) {
          if (isImport || isExport) {
            if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) {
              return ts.visitEachChild(node, visitor, context);
            }

            originalText = node.moduleSpecifier.text;
          } else if (isDynamicImport) {
            const arg = node.arguments[0]!;
            if (!ts.isStringLiteral(arg)) {
              // continue
              return ts.visitEachChild(node, visitor, context);
            }
            originalText = arg.text;
          } else {
            // If it's not an import, export, or dynamic import, just visit children
            return ts.visitEachChild(node, visitor, context);
          }

          // const originalText = node.moduleSpecifier.text;

          const isRelativeImport = originalText.startsWith("./") || originalText.startsWith("../");
          if (!isRelativeImport) {
            // If it's not a relative import, don't transform it
            return node;
          }

          const ext = path.extname(originalText).toLowerCase();

          // rewrite .js to resolved js extension
          if (ext === ".js" || ext === ".ts") {
            const newText = originalText.slice(0, -3) + jsExt;
            if (isImport) {
              return ts.factory.updateImportDeclaration(
                node,
                node.modifiers,
                node.importClause,
                ts.factory.createStringLiteral(newText),
                node.assertClause
              );
            } else if (isExport) {
              return ts.factory.updateExportDeclaration(
                node,
                node.modifiers,
                node.isTypeOnly,
                node.exportClause,
                ts.factory.createStringLiteral(newText),
                node.assertClause
              );
            } else if (isDynamicImport) {
              return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
                ts.factory.createStringLiteral(newText),
                ...node.arguments.slice(1),
              ]);
            }
          }

          // rewrite extensionless imports to .js
          if (ext === "") {
            const newText = originalText + jsExt;
            if (isImport) {
              return ts.factory.updateImportDeclaration(
                node,
                node.modifiers,
                node.importClause,
                ts.factory.createStringLiteral(newText),
                node.assertClause
              );
            } else if (isExport) {
              return ts.factory.updateExportDeclaration(
                node,
                node.modifiers,
                node.isTypeOnly,
                node.exportClause,
                ts.factory.createStringLiteral(newText),
                node.assertClause
              );
            } else if (isDynamicImport) {
              return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
                ts.factory.createStringLiteral(newText),
                ...node.arguments.slice(1),
              ]);
            }
          }

          // copy asset files
          if (utils.isAssetFile(originalText)) {
            // it's an asset
            if (ts.isSourceFile(sourceFile)) {
              const sourceFileDir = path.dirname(sourceFile.fileName);
              const resolvedAssetPath = path.resolve(sourceFileDir, originalText);
              // Make it relative to the source root (rootDir)
              const relAssetPath = path.relative(config.rootDir, resolvedAssetPath);
              assetImports.add(relAssetPath);
            }
            // Don't transform asset dynamic imports, leave them as-is
            return node;
          }
        }

        // // Handle export declarations
        // if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        //   const originalText = node.moduleSpecifier.text;

        //   // Check if this is an asset export (relative path with asset extension)
        //   if ((originalText.startsWith("./") || originalText.startsWith("../")) && isAssetFile(originalText)) {
        //     // Resolve the asset path relative to the source file's directory
        //     if (ts.isSourceFile(sourceFile)) {
        //       const sourceFileDir = path.dirname(sourceFile.fileName);
        //       const resolvedAssetPath = path.resolve(sourceFileDir, originalText);
        //       // Make it relative to the source root (rootDir)
        //       const relAssetPath = path.relative(config.rootDir, resolvedAssetPath);
        //       assetImports.add(relAssetPath);
        //     }
        //     // Don't transform asset exports, leave them as-is
        //     return node;
        //   }

        //   if (originalText.endsWith(".js")) {
        //     const newText = originalText.slice(0, -3) + jsExt;

        //     return ts.factory.updateExportDeclaration(
        //       node,
        //       node.modifiers,
        //       node.isTypeOnly,
        //       node.exportClause,
        //       ts.factory.createStringLiteral(newText),
        //       node.assertClause
        //     );
        //   }

        //   // if export is extensionless, add .js extension
        //   if (originalText.startsWith("./") || originalText.startsWith("../")) {
        //     const hasExtension = path.extname(originalText) !== "";

        //     if (!hasExtension) {
        //       const newText = originalText + jsExt;

        //       return ts.factory.updateExportDeclaration(
        //         node,
        //         node.modifiers,
        //         node.isTypeOnly,
        //         node.exportClause,
        //         ts.factory.createStringLiteral(newText),
        //         node.assertClause
        //       );
        //     }
        //   }
        // }

        // Handle dynamic imports
        // if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        //   const arg = node.arguments[0]!;
        //   if (ts.isStringLiteral(arg)) {
        //     const originalText = arg.text;

        //     // Check if this is an asset dynamic import (relative path with asset extension)
        //     if ((originalText.startsWith("./") || originalText.startsWith("../")) && isAssetFile(originalText)) {
        //       // Resolve the asset path relative to the source file's directory
        //       if (ts.isSourceFile(sourceFile)) {
        //         const sourceFileDir = path.dirname(sourceFile.fileName);
        //         const resolvedAssetPath = path.resolve(sourceFileDir, originalText);
        //         // Make it relative to the source root (rootDir)
        //         const relAssetPath = path.relative(config.rootDir, resolvedAssetPath);
        //         assetImports.add(relAssetPath);
        //       }
        //       // Don't transform asset dynamic imports, leave them as-is
        //       return node;
        //     }

        //     if (originalText.endsWith(".js")) {
        //       const newText = originalText.slice(0, -3) + jsExt;
        //       return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
        //         ts.factory.createStringLiteral(newText),
        //         ...node.arguments.slice(1),
        //       ]);
        //     }

        //     // if dynamic import is extensionless, add .js extension
        //     if (originalText.startsWith("./") || originalText.startsWith("../")) {
        //       const hasExtension = path.extname(originalText) !== "";

        //       if (!hasExtension) {
        //         const newText = originalText + jsExt;
        //         return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
        //           ts.factory.createStringLiteral(newText),
        //           ...node.arguments.slice(1),
        //         ]);
        //       }
        //     }
        //   }
        // }

        return ts.visitEachChild(node, visitor, context);
      };

      return ts.visitNode(sourceFile, visitor) as ts.SourceFile;
    };
  };

  // Check for semantic errors
  const diagnostics = ts.getPreEmitDiagnostics(program);

  if (diagnostics.length > 0) {
    const errorCount = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error).length;
    const warningCount = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Warning).length;

    // Update the build context with error and warning counts
    ctx.errorCount += errorCount;
    ctx.warningCount += warningCount;

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
    const relevantDiagnostics = diagnostics.filter(
      (d) => d.category === ts.DiagnosticCategory.Error || d.category === ts.DiagnosticCategory.Warning
    );

    if (relevantDiagnostics.length > 0) {
      console.log(ts.formatDiagnosticsWithColorAndContext(relevantDiagnostics, formatHost));
    }
  }

  // emit the files
  const emitResult = program.emit(undefined, undefined, undefined, undefined, {
    before: [extensionRewriteTransformer as ts.TransformerFactory<ts.SourceFile>],
    afterDeclarations: [extensionRewriteTransformer],
  });

  if (emitResult.emitSkipped) {
    utils.emojiLog("❌", "Emit was skipped due to errors", "error");
  } else {
    // console.log(`✅ Emitted ${config.jsExtension} and ${config.dtsExtension}
    // files`);
  }

  // Report any emit diagnostics
  if (emitResult.diagnostics.length > 0) {
    const emitErrors = emitResult.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
    const emitWarnings = emitResult.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Warning);

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
    const relevantEmitDiagnostics = emitResult.diagnostics.filter(
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
        ctx.writtenFiles.add(destFile);
        ctx.copiedAssets.add(destFile);

        if (!config.dryRun) {
          // Ensure destination directory exists
          fs.mkdirSync(destDir, { recursive: true });

          // Copy the file
          fs.copyFileSync(sourceFile, destFile);
        }

        if (config.verbose) {
          const relativeSource = config.pkgJsonDir ? path.relative(config.pkgJsonDir, sourceFile) : sourceFile;
          const relativeDest = config.pkgJsonDir ? path.relative(config.pkgJsonDir, destFile) : destFile;
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
