#!/usr/bin/env node
import { globby } from "globby";
import { table } from "table";
import * as fs from "node:fs";
import * as path from "node:path/posix";
import * as ts from "typescript";
import parseArgs from "arg";

import { getEntryPoints, compileProject, readTsconfig } from "./utils";

function isSourceFile(filePath: string): boolean {
	return (
		filePath.endsWith(".ts") ||
		filePath.endsWith(".mts") ||
		filePath.endsWith(".cts") ||
		filePath.endsWith(".tsx")
	);
}

function removeExtension(filePath: string): string {
	return filePath.split(".").slice(0, -1).join(".") || filePath;
}

async function main(): Promise<void> {
	console.log("💎 Starting zshy build...");

	///////////////////////////////////
	///    parse command line args  ///
	///////////////////////////////////

	// Parse command line arguments using arg library
	let args;
	try {
		args = parseArgs({
			"--help": Boolean,
			"--verbose": Boolean,
			"--project": String,

			// Aliases
			"-h": "--help",
			"-p": "--project",
		});
	} catch (error) {
		if (error instanceof Error) {
			console.error(`❌ ${error.message}`);
		}
		console.error(`Use --help for usage information`);
		process.exit(1);
	}

	// Handle help flag
	if (args["--help"]) {
		console.log(`
Usage: zshy [options]

Options:
  -h, --help             Show this help message
  -p, --project <path>   Path to tsconfig.json file
	    --verbose          Enable verbose output

Examples:
  zshy                                    # Use ./tsconfig.json or package.json#zshy.tsconfig
  zshy --project ./tsconfig.build.json    # Use specific tsconfig file
	zshy --verbose                          # Enable verbose logging
		`);
		process.exit(0);
	}

	const isVerbose = args["--verbose"];

	if (isVerbose) {
		console.log("🗣️ Verbose mode enabled");
	}

	///////////////////////////////////
	///    find and read pkg json   ///
	///////////////////////////////////

	// Find package.json by scanning up the file system
	let packageJsonPath = "./package.json";
	let currentDir = process.cwd();

	while (currentDir !== path.dirname(currentDir)) {
		const candidatePath = path.join(currentDir, "package.json");
		if (fs.existsSync(candidatePath)) {
			packageJsonPath = candidatePath;
			break;
		}
		currentDir = path.dirname(currentDir);
	}

	if (!fs.existsSync(packageJsonPath)) {
		console.error(
			"❌ package.json not found in current directory or any parent directories",
		);
		process.exit(1);
	}

	// read package.json and extract the "zshy" exports config
	// console.log("📦 Extracting entry points from package.json exports...");
	const pkgJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
	const pkgJsonDir = path.dirname(packageJsonPath);

	// print project root
	console.log(`⚙️  Detected project root: ${pkgJsonDir}`);
	console.log(
		`📦 Reading package.json from ./${path.relative(
			pkgJsonDir,
			packageJsonPath,
		)}`,
	);

	/////////////////////////////////
	///    parse zshy config      ///
	/////////////////////////////////

	// const pkgJson = JSON.parse(fs.readFileSync("./package.json", "utf-8"));
	const CONFIG_KEY = "zshy";

	let config!: {
		exports: Record<string, string>;
		bin?: Record<string, string> | string;
		sourceDialects?: string[];
		tsconfig?: string; // optional path to tsconfig.json file
		// outDir?: string; // optional, can be used to specify output directory
		// other properties can be added as needed
	};

	if (!pkgJson[CONFIG_KEY]) {
		console.error(`❌ No "${CONFIG_KEY}" key found in package.json`);
		process.exit(1);
	}

	if (typeof pkgJson[CONFIG_KEY] === "string") {
		config = {
			exports: { ".": pkgJson[CONFIG_KEY] },
		};
	} else if (typeof pkgJson[CONFIG_KEY] === "object") {
		config = { ...pkgJson[CONFIG_KEY] };

		if (typeof config.exports === "string") {
			config.exports = { ".": config.exports };
		} else if (typeof config.exports === "undefined") {
			console.error(`❌ Missing "exports" key in package.json#${CONFIG_KEY}`);
			process.exit(1);
		} else if (typeof config.exports !== "object") {
			console.error(`❌ Invalid "exports" key in package.json#${CONFIG_KEY}`);
			process.exit(1);
		}

		// Validate bin field if present
		if (config.bin !== undefined) {
			if (typeof config.bin === "string") {
				// Keep string format - we'll handle this in entry point extraction
			} else if (typeof config.bin === "object" && config.bin !== null) {
				// Object format is valid
			} else {
				console.error(`❌ Invalid "bin" key in package.json#${CONFIG_KEY}, expected string or object`);
				process.exit(1);
			}
		}
		// {
		// 	exports: { ".": pkgJson[CONFIG_KEY].exports },
		// };
	} else if (typeof pkgJson[CONFIG_KEY] === "undefined") {
		console.error(`❌ Missing "${CONFIG_KEY}" key in package.json`);
		process.exit(1);
	} else {
		console.error(
			`❌ Invalid "${CONFIG_KEY}" key in package.json, expected string or object`,
		);
		process.exit(1);
	}

	if (isVerbose) {
		console.log("🔧 Parsed zshy config:", JSON.stringify(config, null, 2));
	}

	///////////////////////////
	///    read tsconfig    ///
	///////////////////////////

	// Determine tsconfig.json path
	let tsconfigPath: string;
	if (args["--project"]) {
		// CLI flag takes priority
		const resolvedProjectPath = path.resolve(process.cwd(), args["--project"]);

		if (fs.existsSync(resolvedProjectPath)) {
			if (fs.statSync(resolvedProjectPath).isDirectory()) {
				console.error(
					`❌ --project must point to a tsconfig.json file, not a directory: ${resolvedProjectPath}`,
				);
				process.exit(1);
			} else {
				// Use the file directly
				tsconfigPath = resolvedProjectPath;
			}
		} else {
			console.error(`❌ tsconfig.json file not found: ${resolvedProjectPath}`);
			process.exit(1);
		}
	} else if (config.tsconfig) {
		// Fallback to package.json config
		const resolvedProjectPath = path.resolve(pkgJsonDir, config.tsconfig);

		if (fs.existsSync(resolvedProjectPath)) {
			if (fs.statSync(resolvedProjectPath).isDirectory()) {
				console.error(
					`❌ zshy.tsconfig must point to a tsconfig.json file, not a directory: ${resolvedProjectPath}`,
				);
				process.exit(1);
			} else {
				// Use the file directly
				tsconfigPath = resolvedProjectPath;
			}
		} else {
			console.error(`❌ Tsconfig file not found: ${resolvedProjectPath}`);
			process.exit(1);
		}
	} else {
		// Default to tsconfig.json in the package.json directory
		tsconfigPath = path.join(pkgJsonDir, "tsconfig.json");
	}

	const _parsedConfig = readTsconfig(tsconfigPath);
	if (!fs.existsSync(tsconfigPath)) {
		// Check if tsconfig.json exists
		console.error(
			`❌ tsconfig.json not found at ${path.resolve(tsconfigPath)}`,
		);
		process.exit(1);
	}
	console.log(
		`📁 Reading tsconfig from ./${path.relative(pkgJsonDir, tsconfigPath)}`,
	);

	// if (_parsedConfig.rootDir) {
	// 	console.error(
	// 		`❌ rootDir is determined from your set of entrypoints; you can remove it from your tsconfig.json.`,
	// 	);
	// 	process.exit(1);
	// }

	// if (_parsedConfig.declarationDir) {
	// 	console.error(
	// 		`❌ declarationDir is not supported in zshy; you should remove it from your tsconfig.json.`,
	// 	);
	// 	process.exit(1);
	// }

	// set/override compiler options
	delete _parsedConfig.customConditions; //  can't be set for CommonJS builds

	const outDir = path.resolve(pkgJsonDir, _parsedConfig?.outDir || "./dist");
	const relOutDir = path.relative(pkgJsonDir, outDir);
	const declarationDir = path.resolve(
		pkgJsonDir,
		_parsedConfig?.declarationDir || relOutDir,
	);
	const relDeclarationDir = path.relative(pkgJsonDir, declarationDir);

	// clean up outDir and declarationDir
	if (relOutDir !== "") {
		console.log(`🗑️  Cleaning up outDir...`);
		fs.rmSync(outDir, { recursive: true, force: true });

		// // print success mesage in verbose mode
		if (isVerbose) {
			if (!fs.existsSync(outDir)) {
				console.log(`   ✅ Successfully cleaned up outDir: ${relOutDir}`);
			} else {
				console.error(
					`❌ Failed to clean up outDir: ${relOutDir}. Directory still exists.`,
				);
			}
		}
	} else {
		if (isVerbose)
			console.log(`🗑️  Skipping cleanup of outDir as it contains source files`);
	}
	if (relDeclarationDir !== relOutDir && relDeclarationDir !== "") {
		console.log(`🗑️  Cleaning up declarationDir...`);
		fs.rmSync(declarationDir, { recursive: true, force: true });
		// // print success mesage in verbose mode
		if (isVerbose) {
			if (!fs.existsSync(declarationDir)) {
				console.log(
					`   ✅ Successfully cleaned up declarationDir: ${relDeclarationDir}`,
				);
			} else {
				console.error(
					`❌ Failed to clean up declarationDir: ${relDeclarationDir}. Directory still exists.`,
				);
			}
		}
	} else {
		if (isVerbose)
			console.log(
				`🗑️  Skipping cleanup of declarationDir as it contains source files`,
			);
	}

	const tsconfigJson: ts.CompilerOptions = {
		..._parsedConfig,
		outDir,
		target: _parsedConfig.target ?? ts.ScriptTarget.ES2020, // ensure compatible target for CommonJS
		skipLibCheck: true, // skip library checks to reduce errors
		declaration: true,
		noEmit: false,
		emitDeclarationOnly: false,
		rewriteRelativeImportExtensions: true,
		verbatimModuleSyntax: false,
	};

	if (relOutDir === "") {
		if (!pkgJson.files) {
			console.log(
				'⚠️  You\'re building your code to the project root. This means your compiled files will be generated alongside your source files.\n   ➜ Setting "files" in package.json to exclude TypeScript source from the published package.',
			);
			pkgJson.files = [
				"**/*.js",
				"**/*.mjs",
				"**/*.cjs",
				"**/*.d.ts",
				"**/*.d.mts",
				"**/*.d.cts",
			];
		} else {
			console.warn(
				`⚠️  You're building your code to the project root. This means your compiled files will be generated alongside your source files.
   ➜ Ensure that your "files" in package.json excludes TypeScript source files, or your users may experience .d.ts resolution issues in some environments:

   "files": ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.d.ts", "**/*.d.mts", "**/*.d.cts"],
`,
			);
		}
	} else {
		if (!pkgJson.files) {
			console.log(
				`⚠️  The "files" key is missing in package.json. Setting to "${relOutDir}".`,
			);
			pkgJson.files = [relOutDir];
			if (relOutDir !== relDeclarationDir) {
				pkgJson.files.push(relDeclarationDir);
			}
		}
	}

	/////////////////////////////////
	///   extract entry points    ///
	/////////////////////////////////

	// Extract entry points from zshy exports config
	console.log("➡️  Determining entrypoints...");
	const entryPatterns: string[] = [];

	const rows: string[][] = [["Subpath", "Entrypoint"]];
	for (const [exportPath, sourcePath] of Object.entries(config.exports)) {
		if (exportPath.includes("package.json")) continue;
		let cleanExportPath!: string;
		if (exportPath === ".") {
			cleanExportPath = pkgJson.name;
		} else if (exportPath.startsWith("./")) {
			cleanExportPath = pkgJson.name + "/" + exportPath.slice(2);
		} else {
			console.error(
				`⚠️  Invalid subpath export "${exportPath}" — should start with "./"`,
			);
			process.exit(1);
		}
		if (typeof sourcePath === "string") {
			if (sourcePath.includes("*")) {
				if (!sourcePath.endsWith("/*")) {
					console.error(
						`❌ Wildcard paths should not contain file extensions: ${sourcePath}`,
					);
					process.exit(1);
				}
				const pattern = sourcePath.slice(0, -2) + "/*.{ts,tsx,mts,cts}";
				const wildcardFiles = await globby([pattern], {
					ignore: ["**/*.d.ts"],
					cwd: pkgJsonDir,
					deep: 1,
				});
				entryPatterns.push(...wildcardFiles);

				rows.push([
					`"${cleanExportPath}"`,
					`${sourcePath} (${wildcardFiles.length} matches)`,
				]);
			} else if (isSourceFile(sourcePath)) {
				entryPatterns.push(sourcePath);

				rows.push([`"${cleanExportPath}"`, sourcePath]);
			}
		}
	}

	// Extract bin entry points from zshy bin config
	if (config.bin) {
		if (typeof config.bin === "string") {
			// Single bin entry
			if (isSourceFile(config.bin)) {
				entryPatterns.push(config.bin);
				rows.push([`bin:${pkgJson.name}`, config.bin]);
			}
		} else {
			// Multiple bin entries
			for (const [binName, sourcePath] of Object.entries(config.bin as Record<string, string>)) {
				if (typeof sourcePath === "string" && isSourceFile(sourcePath)) {
					entryPatterns.push(sourcePath);
					rows.push([`bin:${binName}`, sourcePath]);
				}
			}
		}
	}

	console.log(
		"   " +
			table(rows, {
				drawHorizontalLine: (lineIndex, rowCount) => {
					return (
						lineIndex === 0 ||
						lineIndex === 1 ||
						// lineIndex === rowCount - 1 ||
						lineIndex === rowCount
					);
				},
			})
				.split("\n")
				.join("\n   ")
				.trim(),
	);

	///////////////////////////////
	///   compute entry points  ///
	///////////////////////////////

	// compute entry points
	const entryPoints = await getEntryPoints(entryPatterns);
	// disallow .mts and .cts files
	if (entryPoints.some((ep) => ep.endsWith(".mts") || ep.endsWith(".cts"))) {
		console.error(
			"❌ Source files with .mts or .cts extensions are not supported. Please use regular .ts files.",
		);
		process.exit(1);
	}
	if (entryPoints.length === 0) {
		console.error(
			"❌ No entry points found matching the specified patterns in package.json#zshy exports",
		);
		process.exit(1);
	}

	///////////////////////////////
	///   compute root dir      ///
	///////////////////////////////

	// Compute common ancestor directory for all entry points
	let rootDir: string;
	if (tsconfigJson.rootDir) {
		rootDir = path.resolve(tsconfigPath, tsconfigJson.rootDir);
	} else {
		// compute rootDir from entrypoints
		rootDir =
			entryPoints.length > 0
				? entryPoints.reduce(
						(common, entryPoint) => {
							const entryDir = path.dirname(path.resolve(entryPoint));
							const commonDir = path.resolve(common);

							// Find the longest common path
							const entryParts = entryDir.split(path.sep);
							const commonParts = commonDir.split(path.sep);

							let i = 0;
							while (
								i < entryParts.length &&
								i < commonParts.length &&
								entryParts[i] === commonParts[i]
							) {
								i++;
							}

							return commonParts.slice(0, i).join(path.sep) || path.sep;
						},
						path.dirname(path.resolve(entryPoints[0]!)),
					)
				: process.cwd();
	}

	const relRootDir = path.relative(pkgJsonDir, rootDir);

	// Display resolved paths table
	console.log("🔧 Resolved build paths:");
	const pathRows: string[][] = [["Location", "Resolved path"]];

	// pathRows.push([
	// 	"package.json",
	// 	`./${path.relative(pkgJsonDir, packageJsonPath)}`,
	// ]);
	// pathRows.push(["tsconfig", `./${path.relative(pkgJsonDir, tsconfigPath)}`]);
	pathRows.push(["rootDir", relRootDir ? `./${relRootDir}` : "."]);
	pathRows.push(["outDir", relOutDir ? `./${relOutDir}` : "."]);

	if (relDeclarationDir !== relOutDir) {
		pathRows.push([
			"declarationDir",
			relDeclarationDir ? `./${relDeclarationDir}` : ".",
		]);
	}

	console.log(
		"   " +
			table(pathRows, {
				drawHorizontalLine: (lineIndex, rowCount) => {
					return (
						lineIndex === 0 ||
						lineIndex === 1 ||
						// lineIndex === rowCount - 1 ||
						lineIndex === rowCount
					);
				},
			})
				.split("\n")
				.join("\n   ")
				.trim(),
	);

	const isTypeModule = pkgJson.type === "module";
	if (isTypeModule) {
		console.log(`🟨 Package is an ES module (package.json#type is \"module\")`);
	} else {
		console.log(
			`🐢 Package is a CommonJS module (${pkgJson.type === "commonjs" ? 'package.json#type is "commonjs"' : 'package.json#type not set to "module"'})`,
		);
	}

	///////////////////////////////
	///       compile tsc        ///
	///////////////////////////////

	try {
		// CJS
		console.log(
			`🧱 Building CJS...${isTypeModule ? ` (rewriting .ts -> .cjs/.d.cts)` : ``}`,
		);
		await compileProject(
			{
				configPath: tsconfigPath,
				mode: isTypeModule ? "cts" : "ts",
				verbose: isVerbose,
				compilerOptions: {
					...tsconfigJson,
					module: ts.ModuleKind.CommonJS,
					moduleResolution: ts.ModuleResolutionKind.Node10,
					outDir,
				},
			},
			entryPoints,
		);

		// ESM
		console.log(
			`🧱 Building ESM...${isTypeModule ? `` : ` (rewriting .ts -> .mjs/.d.mts)`}`,
		);
		await compileProject(
			{
				configPath: tsconfigPath,
				mode: isTypeModule ? "ts" : "mts",
				verbose: isVerbose,
				compilerOptions: {
					...tsconfigJson,
					module: ts.ModuleKind.ESNext,
					moduleResolution: ts.ModuleResolutionKind.Bundler,
					outDir,
				},
			},
			entryPoints,
		);

		///////////////////////////////
		///   generate exports      ///
		///////////////////////////////

		// generate package.json exports
		console.log("📦 Updating package.json exports...");

		// Generate exports based on zshy config
		const newExports: Record<string, any> = {};

		const sourceDialects = config.sourceDialects || [];

		for (const [exportPath, sourcePath] of Object.entries(config.exports)) {
			if (exportPath.includes("package.json")) {
				newExports[exportPath] = sourcePath;
				continue;
			}
			const absSourcePath = path.resolve(pkgJsonDir, sourcePath);
			const relSourcePath = path.relative(rootDir, absSourcePath);
			const absJsPath = path.resolve(outDir, relSourcePath);
			const absDtsPath = path.resolve(declarationDir, relSourcePath);
			const relJsPath = "./" + path.relative(pkgJsonDir, absJsPath);
			const relDtsPath = "./" + path.relative(pkgJsonDir, absDtsPath);

			if (typeof sourcePath === "string") {
				if (sourcePath.endsWith("/*")) {
					// Handle wildcard exports
					// const relSourcePath =
					// 	"./" +
					// 	path.relative(
					// 		pkgJsonDir,
					// 		path.resolve(outDir, sourcePath.slice(0, -2)),
					// 	) +
					// 	"/*";
					newExports[exportPath] = {
						types: relDtsPath,
						import: relJsPath,
						require: relJsPath,
					};
					for (const sd of sourceDialects) {
						newExports[exportPath] = {
							[sd]: sourcePath,
							...newExports[exportPath],
						};
					}
				} else if (isSourceFile(sourcePath)) {
					const esmPath =
						removeExtension(relJsPath) + (isTypeModule ? `.js` : `.mjs`); // ./v4/index.js or ./v4/index.mjs
					const cjsPath =
						removeExtension(relJsPath) + (isTypeModule ? `.cjs` : `.js`);

					const dtsPath =
						removeExtension(relDtsPath) + (isTypeModule ? `.d.cts` : `.d.ts`); // ./

					newExports[exportPath] = {
						types: dtsPath,
						import: esmPath,
						require: cjsPath,
					};

					if (exportPath === ".") {
						pkgJson.main = cjsPath;
						pkgJson.module = esmPath;
						pkgJson.types = dtsPath;
					}
					for (const sd of sourceDialects) {
						newExports[exportPath] = {
							[sd]: sourcePath,
							...newExports[exportPath],
						};
					}
				} else {
					console.error(`❌ Invalid entrypoint: ${sourcePath}`);
					process.exit();
				}
			}
		}

		///////////////////////////////
		///      generate bin        ///
		///////////////////////////////

		// Generate bin field based on zshy bin config
		if (config.bin) {
			console.log("📦 Updating package.json bin...");
			const newBin: Record<string, string> = {};

			// Convert config.bin to object format for processing
			const binEntries = typeof config.bin === "string" 
				? [[pkgJson.name, config.bin]] 
				: Object.entries(config.bin);

			for (const [binName, sourcePath] of binEntries) {
				if (typeof sourcePath === "string" && isSourceFile(sourcePath)) {
					const absSourcePath = path.resolve(pkgJsonDir, sourcePath);
					const relSourcePath = path.relative(rootDir, absSourcePath);
					const absJsPath = path.resolve(outDir, relSourcePath);
					const relJsPath = "./" + path.relative(pkgJsonDir, absJsPath);

					// Use CommonJS entrypoint for bin
					const binPath = removeExtension(relJsPath) + (isTypeModule ? `.cjs` : `.js`);
					newBin[binName] = binPath;
				}
			}

			// If original config.bin was a string, output as string
			if (typeof config.bin === "string") {
				pkgJson.bin = Object.values(newBin)[0];
				
				if (isVerbose) {
					console.log(`   Generated bin (string): "${Object.values(newBin)[0]}"`);
				}
			} else {
				// Output as object
				pkgJson.bin = newBin;
				
				if (isVerbose) {
					console.log("   Generated bin (object):");
					console.log(
						"   " + JSON.stringify(newBin, null, 2).split("\n").join("\n   "),
					);
				}
			}
		}

		///////////////////////////////
		///     write pkg json      ///
		///////////////////////////////

		// Update package.json with new exports
		pkgJson.exports = newExports;
		fs.writeFileSync(packageJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");

		// console.log("✅ Updating package.json#exports");
		if (isVerbose) {
			console.log("   Generated exports:");
			console.log(
				"   " + JSON.stringify(newExports, null, 2).split("\n").join("\n   "),
			);
		}

		// // run `@arethetypeswrong/cli --pack .` to check types
		// console.log("🔍 Checking types with @arethetypeswrong/cli...");
		// const { execSync } = await import("node:child_process");
		// execSync(`npx @arethetypeswrong/cli --pack ${pkgJsonDir}`, {
		// 	stdio: "inherit",
		// 	cwd: pkgJsonDir,
		// });

		///////////////////////////////////
		///     print directory tree    ///
		///////////////////////////////////

		if (isVerbose) {
			// Recursively print directory contents
			const printDirectoryTree = (
				dirPath: string,
				prefix = "",
				isLast = true,
			) => {
				// Check if the directory exists
				if (!fs.existsSync(dirPath)) {
					console.error(`❌ ${prefix}└── [Error: Directory does not exist]`);
					process.exit(1);
				}
				try {
					const items = fs
						.readdirSync(dirPath, { withFileTypes: true })
						.sort((a, b) => {
							// Directories first, then files, both alphabetically
							if (a.isDirectory() && !b.isDirectory()) return -1;
							if (!a.isDirectory() && b.isDirectory()) return 1;
							return a.name.localeCompare(b.name);
						});

					items.forEach((item, index) => {
						const isLastItem = index === items.length - 1;
						const connector = isLastItem ? "└── " : "├── ";
						console.log(`${prefix}${connector}${item.name}`);

						if (item.isDirectory()) {
							const extension = isLastItem ? "    " : "│   ";
							printDirectoryTree(
								path.join(dirPath, item.name),
								prefix + extension,
								isLastItem,
							);
						}
					});
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);
					console.log(
						`${prefix}└── [Error reading directory: ${errorMessage}]`,
					);
				}
			};

			// Print outDir if it's not inside or equal to rootDir
			const shouldPrintOutDir = relOutDir !== "" && relOutDir !== relRootDir;

			if (shouldPrintOutDir) {
				console.log(`📁 Contents of outDir (${relOutDir}):`);
				printDirectoryTree(outDir);
			}

			// Print declarationDir if it's different from outDir
			const shouldPrintDeclarationDir =
				relDeclarationDir !== relOutDir &&
				relDeclarationDir !== "" &&
				relDeclarationDir !== relRootDir;

			if (shouldPrintDeclarationDir) {
				console.log(`📁 Contents of declarationDir (${relDeclarationDir}):`);
				printDirectoryTree(declarationDir);
			}
		}

		console.log("🎉 Build complete!");
	} catch (error) {
		console.error("❌ Build failed:", error);
		process.exit(1);
	}
}

// Run the script
main().catch((error) => {
	console.error("❌ Script failed:", error);
	process.exit(1);
});
