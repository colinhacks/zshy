import { globby } from "globby";
import * as path from "node:path";
import * as ts from "typescript";

export interface ProjectOptions {
	configPath: string;
	compilerOptions: ts.CompilerOptions &
		Required<
			Pick<ts.CompilerOptions, "module" | "moduleResolution" | "outDir">
		>;
	// jsExtension?: string;
	// dtsExtension?: string;
	mode: "cts" | "ts" | "mts";
	// module: ts.ModuleKind;
}

// Get entry points using the same logic as esbuild.mts
export async function getEntryPoints(patterns: string[]): Promise<string[]> {
	const results: string[] = [];
	for (const pattern of patterns) {
		const _results = await globby(pattern, {
			ignore: ["**/*.d.ts"],
		});

		if (!pattern.endsWith("/*") && _results.length === 0) {
			console.error(`❌ File does not exist: ${pattern}`);
			process.exit(1);
		}

		results.push(..._results);
	}
	return results;
}

export function readTsconfig(tsconfigPath: string) {
	// Read and parse tsconfig.json
	const configPath = path.resolve(tsconfigPath);
	const configFile = ts.readConfigFile(configPath, ts.sys.readFile);

	if (configFile.error) {
		console.error(
			"Error reading tsconfig.json:",
			ts.formatDiagnostic(configFile.error, {
				getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
				getCanonicalFileName: (fileName) => fileName,
				getNewLine: () => ts.sys.newLine,
			}),
		);
		process.exit(1);
	}

	// Parse the config
	const parsedConfig = ts.parseJsonConfigFileContent(
		configFile.config,
		ts.sys,
		path.dirname(configPath),
	);

	if (parsedConfig.errors.length > 0) {
		console.error("Error parsing tsconfig.json:");
		for (const error of parsedConfig.errors) {
			console.error(
				ts.formatDiagnostic(error, {
					getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
					getCanonicalFileName: (fileName) => fileName,
					getNewLine: () => ts.sys.newLine,
				}),
			);
		}
		process.exit(1);
	}

	if (!parsedConfig.options) {
		throw new Error("❌ Error reading tsconfig.json#compilerOptions");
	}
	return parsedConfig.options!;
}

export async function compileProject(
	config: ProjectOptions,
	entryPoints: string[],
): Promise<void> {
	const exts = [];
	// exts.push(config.jsExtension ?? ".js");
	// exts.push(config.dtsExtension ?? ".d.ts");
	// console.log(
	// 	`🧱 Building${
	// 		config.mode === "ts"
	// 			? ".js/.d.ts"
	// 			: config.mode === "mts"
	// 				? ".mjs/.d.ts"
	// 				: ".cjs/.d.ts"
	// 	}...`,
	// );

	// Create compiler host
	const host = ts.createCompilerHost(config.compilerOptions);
	const originalWriteFile = host.writeFile;

	const jsExt =
		config.mode === "mts" ? ".mjs" : config.mode === "cts" ? ".cjs" : ".js";
	const dtsExt =
		config.mode === "mts"
			? ".d.mts"
			: config.mode === "cts"
				? ".d.cts"
				: ".d.ts";
	host.writeFile = (
		fileName,
		data,
		writeByteOrderMark,
		onError,
		sourceFiles,
	) => {
		// Transform output file extensions
		let outputFileName = fileName;
		const processedData = data;

		// if (config.jsExtension) {
		if (fileName.endsWith(".js")) {
			outputFileName = fileName.replace(/\.js$/, jsExt);
		}
		// }
		// if (config.dtsExtension) {
		if (fileName.endsWith(".d.ts")) {
			outputFileName = fileName.replace(/\.d\.ts$/, dtsExt);
		}
		// }

		// console.log(`   ${outputFileName}`);

		if (originalWriteFile) {
			originalWriteFile(
				outputFileName,
				processedData,
				writeByteOrderMark,
				onError,
				sourceFiles,
			);
		}
	};

	// Create the TypeScript program using entry points
	const program = ts.createProgram({
		rootNames: entryPoints,
		options: config.compilerOptions,
		host,
	});

	// Create a transformer factory to rewrite extensions
	const extensionRewriteTransformer: ts.TransformerFactory<
		ts.SourceFile | ts.Bundle
	> = (context) => {
		return (sourceFile) => {
			const visitor = (node: ts.Node): ts.Node => {
				if (
					ts.isImportDeclaration(node) &&
					node.moduleSpecifier &&
					ts.isStringLiteral(node.moduleSpecifier)
				) {
					const originalText = node.moduleSpecifier.text;

					if (originalText.endsWith(".js")) {
						const newText = originalText.slice(0, -3) + jsExt;

						return ts.factory.updateImportDeclaration(
							node,
							node.modifiers,
							node.importClause,
							ts.factory.createStringLiteral(newText),
							node.assertClause,
						);
					}

					// if import is extensionless, add .js extension
					if (originalText.startsWith("./") || originalText.startsWith("../")) {
						console.dir("import", { depth: null });
						console.dir(originalText, { depth: null });
						const hasExtension = path.extname(originalText) !== "";

						if (!hasExtension) {
							const newText = originalText + jsExt;
							console.dir(newText, { depth: null });

							return ts.factory.updateImportDeclaration(
								node,
								node.modifiers,
								node.importClause,
								ts.factory.createStringLiteral(newText),
								node.assertClause,
							);
						}
					}
				}

				// Handle export declarations
				if (
					ts.isExportDeclaration(node) &&
					node.moduleSpecifier &&
					ts.isStringLiteral(node.moduleSpecifier)
				) {
					const originalText = node.moduleSpecifier.text;

					if (originalText.endsWith(".js")) {
						const newText = originalText.slice(0, -3) + jsExt;

						return ts.factory.updateExportDeclaration(
							node,
							node.modifiers,
							node.isTypeOnly,
							node.exportClause,
							ts.factory.createStringLiteral(newText),
							node.assertClause,
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
								node.assertClause,
							);
						}
					}
				}

				// Handle dynamic imports
				if (
					ts.isCallExpression(node) &&
					node.expression.kind === ts.SyntaxKind.ImportKeyword
				) {
					const arg = node.arguments[0]!;
					if (ts.isStringLiteral(arg)) {
						const originalText = arg.text;

						if (originalText.endsWith(".js")) {
							const newText = originalText.slice(0, -3) + jsExt;
							// console.log(`Rewriting dynamic import from ${originalText} to
							// ${newText}`);
							return ts.factory.updateCallExpression(
								node,
								node.expression,
								node.typeArguments,
								[
									ts.factory.createStringLiteral(newText),
									...node.arguments.slice(1),
								],
							);
						}

						// if dynamic import is extensionless, add .js extension
						if (
							originalText.startsWith("./") ||
							originalText.startsWith("../")
						) {
							const hasExtension = path.extname(originalText) !== "";

							if (!hasExtension) {
								const newText = originalText + jsExt;
								return ts.factory.updateCallExpression(
									node,
									node.expression,
									node.typeArguments,
									[
										ts.factory.createStringLiteral(newText),
										...node.arguments.slice(1),
									],
								);
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
		const errorCount = diagnostics.filter(
			(d) => d.category === ts.DiagnosticCategory.Error,
		).length;
		const warningCount = diagnostics.filter(
			(d) => d.category === ts.DiagnosticCategory.Warning,
		).length;

		console.log(`⚠️ Found ${errorCount} errors and ${warningCount} warnings`);

		// Only show first 5 errors to avoid overwhelming output
		const firstErrors = diagnostics
			.filter((d) => d.category === ts.DiagnosticCategory.Error)
			.slice(0, 5);

		if (firstErrors.length > 0) {
			console.log("First few compilation errors:");
			for (const diagnostic of firstErrors) {
				console.error(
					ts.formatDiagnostic(diagnostic, {
						getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
						getCanonicalFileName: (fileName) => fileName,
						getNewLine: () => ts.sys.newLine,
					}),
				);
			}

			if (errorCount > 5) {
				console.log(`... and ${errorCount - 5} more errors`);
			}
		}
	}

	// emit the files
	const emitResult = program.emit(undefined, undefined, undefined, undefined, {
		before: [
			extensionRewriteTransformer as ts.TransformerFactory<ts.SourceFile>,
		],
		afterDeclarations: [extensionRewriteTransformer],
	});

	if (emitResult.emitSkipped) {
		console.error("❌ Emit was skipped due to errors");
	} else {
		// console.log(`✅ Emitted ${config.jsExtension} and ${config.dtsExtension}
		// files`);
	}

	// Report any emit diagnostics
	if (emitResult.diagnostics.length > 0) {
		console.error("❌ Errors detected during emit:");
		for (const diagnostic of emitResult.diagnostics) {
			console.error(
				ts.formatDiagnostic(diagnostic, {
					getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
					getCanonicalFileName: (fileName) => fileName,
					getNewLine: () => ts.sys.newLine,
				}),
			);
		}
	}
}
