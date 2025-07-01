import * as path from "node:path";
import { globby } from "globby";
import * as ts from "typescript";

export function formatForLog(data: unknown) {
  return JSON.stringify(data, null, 2).split("\n").join("\n   ");
}

export function emojiLog(_emoji: string, content: string, level: "log" | "warn" | "error" = "log") {
  console[level]("→  " + content);
}
export interface ProjectOptions {
  configPath: string;
  compilerOptions: ts.CompilerOptions & Required<Pick<ts.CompilerOptions, "module" | "moduleResolution" | "outDir">>;
  mode: "cts" | "ts" | "mts";
  verbose?: boolean;
  dryRun?: boolean;
  packageRoot?: string; // Add package root for relative path display
}

// Get entry points using the same logic as esbuild.mts
export async function getEntryPoints(patterns: string[]): Promise<string[]> {
  const results: string[] = [];
  for (const pattern of patterns) {
    const _results = await globby(pattern, {
      ignore: ["**/*.d.ts"],
    });

    if (!pattern.endsWith("/*") && _results.length === 0) {
      emojiLog("❌", `File does not exist: ${pattern}`, "error");
      process.exit(1);
    }

    results.push(..._results);
  }
  return results;
}

export function readTsconfig(tsconfigPath: string) {
  // Read and parse tsconfig.json
  const configPath = path.resolve(tsconfigPath);
  const configDir = path.dirname(configPath);

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);

  if (configFile.error) {
    console.error(
      "Error reading tsconfig.json:",
      ts.formatDiagnostic(configFile.error, {
        getCurrentDirectory: () => configDir,
        getCanonicalFileName: (fileName) => fileName,
        getNewLine: () => ts.sys.newLine,
      })
    );
    process.exit(1);
  }

  // Parse the config with explicit base path
  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    {
      ...ts.sys,
      // Override getCurrentDirectory to use the tsconfig directory
      getCurrentDirectory: () => configDir,
    },
    configDir
  );

  if (parsedConfig.errors.length > 0) {
    emojiLog("❌", "Error parsing tsconfig.json:", "error");
    for (const error of parsedConfig.errors) {
      console.error(
        ts.formatDiagnostic(error, {
          getCurrentDirectory: () => configDir,
          getCanonicalFileName: (fileName) => fileName,
          getNewLine: () => ts.sys.newLine,
        })
      );
    }
    process.exit(1);
  }

  if (!parsedConfig.options) {
    emojiLog("❌", "Error reading tsconfig.json#/compilerOptions", "error");
    process.exit(1);
  }
  return parsedConfig.options!;
}

export async function compileProject(config: ProjectOptions, entryPoints: string[]): Promise<string[]> {
  // Deduplicate entry points before compilation

  // Track files that would be written
  const writtenFiles: string[] = [];

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

    // Track the file that would be written
    writtenFiles.push(outputFileName);

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
        if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const originalText = node.moduleSpecifier.text;

          if (originalText.endsWith(".js")) {
            const newText = originalText.slice(0, -3) + jsExt;

            return ts.factory.updateImportDeclaration(
              node,
              node.modifiers,
              node.importClause,
              ts.factory.createStringLiteral(newText),
              node.assertClause
            );
          }

          // if import is extensionless, add .js extension
          if (originalText.startsWith("./") || originalText.startsWith("../")) {
            // console.dir("import", { depth: null });
            // console.dir(originalText, { depth: null });
            const hasExtension = path.extname(originalText) !== "";

            if (!hasExtension) {
              const newText = originalText + jsExt;
              // console.dir(newText, { depth: null });

              return ts.factory.updateImportDeclaration(
                node,
                node.modifiers,
                node.importClause,
                ts.factory.createStringLiteral(newText),
                node.assertClause
              );
            }
          }
        }

        // Handle export declarations
        if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const originalText = node.moduleSpecifier.text;

          if (originalText.endsWith(".js")) {
            const newText = originalText.slice(0, -3) + jsExt;

            return ts.factory.updateExportDeclaration(
              node,
              node.modifiers,
              node.isTypeOnly,
              node.exportClause,
              ts.factory.createStringLiteral(newText),
              node.assertClause
            );
          }

          // if export is extensionless, add .js extension
          if (originalText.startsWith("./") || originalText.startsWith("../")) {
            const hasExtension = path.extname(originalText) !== "";

            if (!hasExtension) {
              const newText = originalText + jsExt;

              return ts.factory.updateExportDeclaration(
                node,
                node.modifiers,
                node.isTypeOnly,
                node.exportClause,
                ts.factory.createStringLiteral(newText),
                node.assertClause
              );
            }
          }
        }

        // Handle dynamic imports
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const arg = node.arguments[0]!;
          if (ts.isStringLiteral(arg)) {
            const originalText = arg.text;

            if (originalText.endsWith(".js")) {
              const newText = originalText.slice(0, -3) + jsExt;
              return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
                ts.factory.createStringLiteral(newText),
                ...node.arguments.slice(1),
              ]);
            }

            // if dynamic import is extensionless, add .js extension
            if (originalText.startsWith("./") || originalText.startsWith("../")) {
              const hasExtension = path.extname(originalText) !== "";

              if (!hasExtension) {
                const newText = originalText + jsExt;
                return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
                  ts.factory.createStringLiteral(newText),
                  ...node.arguments.slice(1),
                ]);
              }
            }
          }
        }

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

    if (errorCount > 0 || warningCount > 0) {
      emojiLog("⚠️", `Found ${errorCount} error(s) and ${warningCount} warning(s)`, "warn");
      console.log();
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
    emojiLog("❌", "Emit was skipped due to errors", "error");
  } else {
    // console.log(`✅ Emitted ${config.jsExtension} and ${config.dtsExtension}
    // files`);
  }

  // Report any emit diagnostics
  if (emitResult.diagnostics.length > 0) {
    const emitErrors = emitResult.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
    const emitWarnings = emitResult.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Warning);

    emojiLog("❌", `Found ${emitErrors.length} error(s) and ${emitWarnings.length} warning(s) during emit:`, "error");
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

  // Return the list of files that were written or would be written
  return writtenFiles;
}
