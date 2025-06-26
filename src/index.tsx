import { globby } from "globby";
import { table } from "table";
import * as fs from "node:fs";
import * as path from "node:path/posix";
import * as ts from "typescript";

import {
	getEntryPoints,
	compileProject,
	readTsconfig,
	type ProjectOptions,
} from "./utils.js";

export { ProjectOptions };
export function arg(opts: ProjectOptions): void {}

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
		sourceDialects?: string[];
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

	///////////////////////////
	///    read tsconfig    ///
	///////////////////////////
	const tsconfigPath = path.join(pkgJsonDir, "tsconfig.json");
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

	if (_parsedConfig.rootDir) {
		console.error(
			`❌ rootDir is determined from your set of entrypoints; you can remove it from your tsconfig.json.`,
		);
		process.exit(1);
	}

	if (_parsedConfig.declarationDir) {
		console.error(
			`❌ declarationDir is not supported in zshy; you should remove it from your tsconfig.json.`,
		);
		process.exit(1);
	}

	// set/override compiler options
	delete _parsedConfig.customConditions; //  can't be set for CommonJS builds

	const outDir = path.resolve(pkgJsonDir, _parsedConfig?.outDir || "./dist");
	const relOutDir = path.relative(pkgJsonDir, outDir);

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
				`⚠️  You're building your code to the project root. This means your compiled files will be generated alongside your source files.\n   ➜ Ensure that your "files" in package.json excludes TypeScript source files, or your users may experience .d.ts resolution issues in some environments.
				
				\`\`\`
				"files": ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.d.ts", "**/*.d.mts", "**/*.d.cts"],
				\`\`\`
				`,
			);
		}
	} else {
		if (!pkgJson.files) {
			console.log(
				`⚠️  The "files" key is missing in package.json. Setting to "${relOutDir}".`,
			);
			pkgJson.files = [relOutDir];
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

	console.log("   " + table(rows).split("\n").join("\n   ").trim());

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

	// console.dir(_commonAncestor, { depth: null });
	const relRootDir = path.relative(pkgJsonDir, rootDir);
	console.log(
		`📂 Transpiling ${relRootDir ? `./${relRootDir}` : "."} (rootDir) to ${relOutDir ? `./${relOutDir}` : "."} (outDir)`,
	);

	const isTypeModule = pkgJson.type === "module";
	if (isTypeModule) {
		console.log(`🟨 Package is an ES module (package.json#type is \"module\")`);
	} else {
		console.log(
			`🐢 Package is a CJS module (${pkgJson.type === "commonjs" ? 'package.json#type is "commonjs"' : 'package.json#type not set to "module"'})`,
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

			if (typeof sourcePath === "string") {
				if (sourcePath.endsWith("/*")) {
					// Handle wildcard exports
					const relSourcePath =
						"./" +
						path.relative(
							pkgJsonDir,
							path.resolve(outDir, sourcePath.slice(0, -2)),
						) +
						"/*";
					newExports[exportPath] = {
						import: relSourcePath,
						require: relSourcePath,
					};
					for (const sd of sourceDialects) {
						newExports[exportPath] = {
							[sd]: sourcePath,
							...newExports[exportPath],
						};
					}
				} else if (isSourceFile(sourcePath)) {
					// Handle regular TypeScript entry points
					// const basePath = sourcePath.slice(0, -3); // ./v4/index.ts
					const absSourcePath = path.resolve(pkgJsonDir, sourcePath); // /path/to/v4/index.ts
					const sourcePathRelativeToRootDir = path.relative(
						rootDir,
						absSourcePath,
					); // index.ts
					const outPath = path.resolve(
						pkgJsonDir,
						outDir,
						sourcePathRelativeToRootDir,
					); // /path/to/dist/index.ts
					const outPathNoExt = removeExtension(outPath); // /path/to/dist/index

					const esmFile = isTypeModule
						? `${outPathNoExt}.js`
						: `${outPathNoExt}.mjs`; // ./v4/index.js or ./v4/index.mjs
					const cjsFile = isTypeModule
						? `${outPathNoExt}.cjs`
						: `${outPathNoExt}.js`;
					const dtsFile = isTypeModule
						? `${outPathNoExt}.d.cts`
						: `${outPathNoExt}.d.ts`;

					const relEsmFile =
						"./" + path.relative(pkgJsonDir, path.resolve(outDir, esmFile));
					const relCjsFile =
						"./" + path.relative(pkgJsonDir, path.resolve(outDir, cjsFile));
					const relDtsFile =
						"./" + path.relative(pkgJsonDir, path.resolve(outDir, dtsFile));

					newExports[exportPath] = {
						types: relDtsFile,
						import: relEsmFile,
						require: relCjsFile,
						// import: {
						//   types: relDtsFile,
						//   default: relEsmFile,
						// },
						// require: {
						//   types: relDtsFile,
						//   default: relCjsFile,
						// },
					};

					if (exportPath === ".") {
						pkgJson.main = relCjsFile;
						pkgJson.module = relEsmFile;
						pkgJson.types = relDtsFile;
					}
					for (const sd of sourceDialects) {
						newExports[exportPath] = {
							[sd]: sourcePath,
							...newExports[exportPath],
						};
					}
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
		console.log(
			"   " + JSON.stringify(newExports, null, 2).split("\n").join("\n   "),
		);

		// // run `@arethetypeswrong/cli --pack .` to check types
		// console.log("🔍 Checking types with @arethetypeswrong/cli...");
		// const { execSync } = await import("node:child_process");
		// execSync(`npx @arethetypeswrong/cli --pack ${pkgJsonDir}`, {
		// 	stdio: "inherit",
		// 	cwd: pkgJsonDir,
		// });
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
