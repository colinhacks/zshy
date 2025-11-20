import * as fs from "node:fs";
import * as path from "node:path";
import parseArgs from "arg";
import glob from "fast-glob";
import { table } from "table";
import * as ts from "typescript";
import { type BuildContext, compileProject } from "./compile.js";
import {
  detectConfigIndention,
  findConfigPath,
  formatForLog,
  isSourceFile,
  isTestFile,
  log,
  readTsconfig,
  relativePosix,
  removeExtension,
  setSilent,
  toPosix,
} from "./utils.js";

interface RawConfig {
  exports?: Record<string, string>;
  bin?: Record<string, string> | string | null;
  cjs?: boolean | null;
  conditions?: Record<string, "esm" | "cjs" | "src">;
  tsconfig?: string; // optional path to tsconfig.json file
  noEdit?: boolean;
}

interface NormalizedConfig {
  exports: Record<string, string>;
  bin: Record<string, string> | string | null;
  conditions: Record<string, "esm" | "cjs" | "src">;
  cjs: boolean;
  tsconfig: string;
  noEdit: boolean;
}

export async function main(): Promise<void> {
  log.prefix = "»  ";

  ///////////////////////////////////
  ///    parse command line args  ///
  ///////////////////////////////////

  // Parse command line arguments using arg library
  let args;
  try {
    args = parseArgs({
      "--help": Boolean,
      "--verbose": Boolean,
      "--silent": Boolean,
      "--project": String,
      "--dry-run": Boolean,
      "--fail-threshold": String,
      // "--attw": Boolean,

      // Aliases
      "-h": "--help",
      "-p": "--project",
    });
  } catch (error) {
    if (error instanceof Error) {
      log.error(`❌ ${error.message}`);
    }
    console.error(`Use --help for usage information`);
    process.exit(1);
  }

  // Handle help flag
  if (args["--help"]) {
    console.log(`
Usage: zshy [options]

Options:
  -h, --help                        Show this help message
  -p, --project <path>              Path to tsconfig.json file
      --verbose                     Enable verbose output
      --silent                      Suppress all output
      --dry-run                     Don't write any files, just log what would be done
      --fail-threshold <threshold>  When to exit with non-zero error code
                                      "error" (default)
                                      "warn"
                                      "never"

Examples:
  zshy                                    # Run build
  zshy --project ./tsconfig.build.json    # Use specific tsconfig file (defaults to tsconfig.json)
  zshy --verbose                          # Enable verbose logging
  zshy --silent                           # Suppress all output
  zshy --dry-run                          # Preview changes without writing files
		`);
    process.exit(0);
  }

  const userAgent = process.env.npm_config_user_agent;
  let pmExec: string;

  if (userAgent?.startsWith("pnpm")) {
    pmExec = "pnpm exec";
  } else if (userAgent?.startsWith("yarn")) {
    pmExec = "yarn exec";
  } else {
    pmExec = "npx";
  }

  // Validate that --verbose and --silent are not both passed
  if (args["--verbose"] && args["--silent"]) {
    log.error("❌ Cannot use both --verbose and --silent flags together");
    process.exit(1);
  }

  // Set silent mode if --silent flag is passed
  const isSilent = !!args["--silent"];
  const isVerbose = !!args["--verbose"];
  setSilent(isSilent);

  if (!isSilent) {
    const originalPrefix = log.prefix;
    log.prefix = undefined;
    log.info(`   ╔═══════════════════════════════════════════════╗`);
    log.info(`   ║ zshy » the bundler-free TypeScript build tool ║`);
    log.info(`   ╚═══════════════════════════════════════════════╝`);
    log.prefix = originalPrefix;
    log.info("Starting build...");
  }

  const isDryRun = !!args["--dry-run"];
  const failThreshold = args["--fail-threshold"] || "error"; // Default to 'error'

  const isCjsInterop = true; // Enable CJS interop for testing

  // Validate that the threshold value is one of the allowed values
  if (failThreshold !== "never" && failThreshold !== "warn" && failThreshold !== "error") {
    log.error(
      `❌ Invalid value for --fail-threshold: "${failThreshold}". Valid values are "never", "warn", or "error"`
    );
    process.exit(1);
  }

  const isAttw = false; // args["--attw"];

  if (isVerbose) {
    log.info("Verbose mode enabled");
    log.info(`Detected package manager: ${pmExec}`);
  }

  if (isDryRun) {
    log.info("Dry run mode enabled. No files will be written or modified.");
  }

  // Display message about fail threshold setting
  if (isVerbose) {
    if (failThreshold === "never") {
      log.info("Build will always succeed regardless of errors or warnings");
    } else if (failThreshold === "warn") {
      log.warn("Build will fail on warnings or errors");
    } else {
      log.info("Build will fail only on errors (default)");
    }
  }
  ///////////////////////////////////
  ///    find and read pkg json   ///
  ///////////////////////////////////

  // Find package.json by scanning up the file system
  const packageJsonPath = findConfigPath("package.json");

  // read package.json and extract the "zshy" exports config
  const pkgJsonRaw = fs.readFileSync(packageJsonPath, "utf-8");
  // console.log("📦 Extracting entry points from package.json exports...");
  const pkgJson = JSON.parse(pkgJsonRaw);

  // Detect indentation from package.json to preserve it.
  const pkgJsonIndent = detectConfigIndention(pkgJsonRaw);

  const pkgJsonDir = path.dirname(packageJsonPath);
  const pkgJsonRelPath = relativePosix(pkgJsonDir, packageJsonPath);

  // print project root
  if (!isSilent) {
    log.info(`Detected project root: ${pkgJsonDir}`);
    log.info(`Reading package.json from ./${pkgJsonRelPath}`);
  }

  /////////////////////////////////
  ///    parse zshy config      ///
  /////////////////////////////////

  // const pkgJson = JSON.parse(fs.readFileSync("./package.json", "utf-8"));
  const CONFIG_KEY = "zshy";

  let rawConfig!: RawConfig;

  if (!pkgJson[CONFIG_KEY]) {
    log.error(`❌ No "${CONFIG_KEY}" key found in package.json`);
    process.exit(1);
  }

  if (typeof pkgJson[CONFIG_KEY] === "string") {
    rawConfig = {
      exports: { ".": pkgJson[CONFIG_KEY] },
    };
  } else if (typeof pkgJson[CONFIG_KEY] === "object") {
    rawConfig = { ...pkgJson[CONFIG_KEY] };

    if (typeof rawConfig.exports === "string") {
      rawConfig.exports = { ".": rawConfig.exports };
    } else if (typeof rawConfig.exports === "undefined") {
      log.error(`❌ Missing "exports" key in package.json#/${CONFIG_KEY}`);
      process.exit(1);
    } else if (typeof rawConfig.exports !== "object") {
      log.error(`❌ Invalid "exports" key in package.json#/${CONFIG_KEY}`);
      process.exit(1);
    }

    // Validate bin field if present
    if (rawConfig.bin !== undefined) {
      if (typeof rawConfig.bin === "string") {
        // Keep string format - we'll handle this in entry point extraction
      } else if (typeof rawConfig.bin === "object" && rawConfig.bin !== null) {
        // Object format is valid
      } else {
        log.error(`❌ Invalid "bin" key in package.json#/${CONFIG_KEY}, expected string or object`);
        process.exit(1);
      }
    }

    // Validate conditions field if present
    if (rawConfig.conditions !== undefined) {
      if (typeof rawConfig.conditions === "object" && rawConfig.conditions !== null) {
        // const { import: importCondition, require: requireCondition, ...rest } = config.conditions;
        for (const [condition, value] of Object.entries(rawConfig.conditions)) {
          if (value !== "esm" && value !== "cjs" && value !== "src") {
            log.error(
              `❌ Invalid condition value "${value}" for "${condition}" in package.json#/${CONFIG_KEY}/conditions. Valid values are "esm", "cjs", "src", or null`
            );
            process.exit(1);
          }
        }
      } else {
        log.error(`❌ Invalid "conditions" key in package.json#/${CONFIG_KEY}, expected object`);
        process.exit(1);
      }
    }
  } else if (typeof pkgJson[CONFIG_KEY] === "undefined") {
    log.error(`❌ Missing "${CONFIG_KEY}" key in package.json`);
    process.exit(1);
  } else {
    log.error(`❌ Invalid "${CONFIG_KEY}" key in package.json, expected string or object`);
    process.exit(1);
  }

  if (isVerbose) {
    log.info(`Parsed zshy config: ${formatForLog(rawConfig)}`);
  }

  // Check for deprecated sourceDialects
  if ("sourceDialects" in rawConfig) {
    log.error(
      '❌ The "sourceDialects" option is no longer supported. Use "conditions" instead to configure custom export conditions.'
    );
    process.exit(1);
  }

  const config = { ...rawConfig } as NormalizedConfig;

  // Normalize cjs property
  if (config.cjs === undefined) {
    config.cjs = true; // Default to true if not specified
  }
  config.noEdit ??= false;

  // Validate that if cjs is disabled, no conditions are set to "cjs"
  if (config.cjs === false && config.conditions) {
    const cjsConditions = Object.entries(config.conditions).filter(([_, value]) => value === "cjs");
    if (cjsConditions.length > 0) {
      const conditionNames = cjsConditions.map(([name]) => name).join(", ");
      log.error(
        `❌ CJS is disabled (cjs: false) but the following conditions are set to "cjs": ${conditionNames}. Either enable CJS or change these conditions.`
      );
      process.exit(1);
    }
  }

  // Validate that if cjs is disabled, package.json type must be "module"
  if (config.cjs === false && pkgJson.type !== "module") {
    log.error(
      `❌ CJS is disabled (cjs: false) but package.json#/type is not set to "module". When disabling CommonJS builds, you must set "type": "module" in your package.json.`
    );
    process.exit(1);
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
        log.error(`--project must point to a tsconfig.json file, not a directory: ${resolvedProjectPath}`);
        process.exit(1);
      } else {
        // Use the file directly
        tsconfigPath = resolvedProjectPath;
      }
    } else {
      log.error(`tsconfig.json file not found: ${resolvedProjectPath}`);
      process.exit(1);
    }
  } else if (config.tsconfig) {
    // Fallback to package.json config
    const resolvedProjectPath = path.resolve(pkgJsonDir, config.tsconfig);

    if (fs.existsSync(resolvedProjectPath)) {
      if (fs.statSync(resolvedProjectPath).isDirectory()) {
        log.error(`zshy.tsconfig must point to a tsconfig.json file, not a directory: ${resolvedProjectPath}`);
        process.exit(1);
      } else {
        // Use the file directly
        tsconfigPath = resolvedProjectPath;
      }
    } else {
      log.error(`Tsconfig file not found: ${resolvedProjectPath}`);
      process.exit(1);
    }
  } else {
    // Default to tsconfig.json in the package.json directory
    tsconfigPath = path.join(pkgJsonDir, "tsconfig.json");
  }

  const _parsedConfig = readTsconfig(tsconfigPath);
  if (!fs.existsSync(tsconfigPath)) {
    // Check if tsconfig.json exists
    log.error(`❌ tsconfig.json not found at ${toPosix(path.resolve(tsconfigPath))}`);
    process.exit(1);
  }
  if (!isSilent) {
    log.info(`Reading tsconfig from ./${relativePosix(pkgJsonDir, tsconfigPath)}`);
  }

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
  const relOutDir = relativePosix(pkgJsonDir, outDir);
  const declarationDir = path.resolve(pkgJsonDir, _parsedConfig?.declarationDir || relOutDir);
  const relDeclarationDir = relativePosix(pkgJsonDir, declarationDir);

  const tsconfigJson: ts.CompilerOptions = {
    ..._parsedConfig,
    outDir,
    target: _parsedConfig.target ?? ts.ScriptTarget.ES2020, // ensure compatible target for CommonJS
    skipLibCheck: true, // skip library checks to reduce errors
    declaration: true,
    esModuleInterop: true,
    noEmit: false,
    emitDeclarationOnly: false,
    rewriteRelativeImportExtensions: true,
    verbatimModuleSyntax: false,
    composite: false,
  };

  if (relOutDir === "") {
    if (!pkgJson.files) {
      log.info(
        'You\'re building your code to the project root. This means your compiled files will be generated alongside your source files.\n   ➜ Setting "files" in package.json to exclude TypeScript source from the published package.'
      );
      pkgJson.files = ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.d.ts", "**/*.d.mts", "**/*.d.cts"];
    } else {
      log.info(
        `You\'re building your code to the project root. This means your compiled files will be generated alongside your source files.
   Ensure that your "files" in package.json does not include TypeScript source files, or your users may experience .d.ts resolution issues in some environments:
     "files": ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.d.ts", "**/*.d.mts", "**/*.d.cts"]`
      );
    }
  } else if (!pkgJson.files) {
    log.warn(`The "files" key is missing in package.json. Setting to "${relOutDir}".`);
    pkgJson.files = [relOutDir];
    if (relOutDir !== relDeclarationDir) {
      pkgJson.files.push(relDeclarationDir);
    }
  }

  /////////////////////////////////
  ///   extract entry points    ///
  /////////////////////////////////

  // Extract entry points from zshy exports config
  if (!isSilent) {
    log.info("Determining entrypoints...");
  }
  const entryPoints: string[] = [];
  const assetEntrypoints: Array<{ exportPath: string; sourcePath: string }> = [];

  const rows: string[][] = [["Subpath", "Entrypoint"]];

  for (const [exportPath, sourcePath] of Object.entries(config.exports ?? {})) {
    if (exportPath.includes("package.json")) continue;
    let cleanExportPath!: string;
    if (exportPath === ".") {
      cleanExportPath = pkgJson.name;
    } else if (exportPath.startsWith("./")) {
      cleanExportPath = pkgJson.name + "/" + exportPath.slice(2);
    } else {
      log.warn(`Invalid subpath export "${exportPath}" — should start with "./"`);
      process.exit(1);
    }
    if (typeof sourcePath === "string") {
      if (sourcePath.includes("*")) {
        if (!sourcePath.endsWith("/*") && !sourcePath.endsWith("/**/*")) {
          log.error(`❌ Wildcard paths should end with /* or /**/* (for deep globs): ${sourcePath}`);
          process.exit(1);
        }

        let pattern: string;

        if (sourcePath.endsWith("/**/*")) {
          // Handle deep glob patterns like "./src/**/*"
          pattern = sourcePath.slice(0, -5) + "/**/*.{ts,tsx,mts,cts}";
        } else {
          // Handle shallow glob patterns like "./src/plugins/*"
          pattern = sourcePath.slice(0, -2) + "/*.{ts,tsx,mts,cts}";
        }

        if (isVerbose) {
          log.info(`Matching glob: ${pattern}`);
        }
        const wildcardFiles = await glob(pattern, {
          ignore: ["**/*.d.ts", "**/*.d.mts", "**/*.d.cts"],
          cwd: pkgJsonDir,
        });
        // Filter out test files (__tests__ directories, .test.*, .spec.*)
        const filteredFiles = wildcardFiles.filter((file) => !isTestFile(file));
        entryPoints.push(...filteredFiles);

        rows.push([`"${cleanExportPath}"`, `${sourcePath} (${filteredFiles.length} matches)`]);
      } else if (isSourceFile(sourcePath)) {
        // Skip test files even if explicitly specified
        if (isTestFile(sourcePath)) {
          log.warn(`Skipping test file: ${sourcePath}`);
          continue;
        }
        entryPoints.push(sourcePath);

        rows.push([`"${cleanExportPath}"`, sourcePath]);
      } else {
        // Any non-compilable file should be treated as an asset
        assetEntrypoints.push({ exportPath, sourcePath });
        rows.push([`"${cleanExportPath}"`, `${sourcePath}`]);
      }
    }
  }

  // Extract bin entry points from zshy bin config
  if (config.bin) {
    if (typeof config.bin === "string") {
      // Single bin entry
      if (isSourceFile(config.bin)) {
        if (isTestFile(config.bin)) {
          log.warn(`Skipping test file in bin: ${config.bin}`);
        } else {
          entryPoints.push(config.bin);
          rows.push([`bin:${pkgJson.name}`, config.bin]);
        }
      }
    } else {
      // Multiple bin entries
      for (const [binName, sourcePath] of Object.entries(config.bin)) {
        if (typeof sourcePath === "string" && isSourceFile(sourcePath)) {
          if (isTestFile(sourcePath)) {
            log.warn(`Skipping test file in bin: ${sourcePath}`);
          } else {
            entryPoints.push(sourcePath);
            rows.push([`bin:${binName}`, sourcePath]);
          }
        }
      }
    }
  }

  if (!isSilent) {
    const originalPrefix = log.prefix;
    log.prefix = undefined;
    log.info(
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
          .trim()
    );
    log.prefix = originalPrefix;
  }

  // disallow .mts and .cts files
  // if (entryPoints.some((ep) => ep.endsWith(".mts") || ep.endsWith(".cts"))) {
  //   emojiLog(
  //     "❌",
  //     "Source files with .mts or .cts extensions are not supported. Please use regular .ts files.",
  //     "error"
  //   );
  //   process.exit(1);
  // }
  if (entryPoints.length === 0) {
    log.error("❌ No entry points found matching the specified patterns in package.json#/zshy exports or bin");
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
              while (i < entryParts.length && i < commonParts.length && entryParts[i] === commonParts[i]) {
                i++;
              }

              return commonParts.slice(0, i).join(path.sep) || path.sep;
            },
            path.dirname(path.resolve(entryPoints[0]!))
          )
        : process.cwd();
  }

  const relRootDir = relativePosix(pkgJsonDir, rootDir);

  //////////////////////////////////
  ///   display resolved paths   ///
  //////////////////////////////////
  if (!isSilent) {
    log.info("Resolved build paths:");
  }
  const pathRows: string[][] = [["Location", "Resolved path"]];

  pathRows.push(["rootDir", relRootDir ? `./${relRootDir}` : "."]);
  pathRows.push(["outDir", relOutDir ? `./${relOutDir}` : "."]);

  if (relDeclarationDir !== relOutDir) {
    pathRows.push(["declarationDir", relDeclarationDir ? `./${relDeclarationDir}` : "."]);
  }

  if (!isSilent) {
    const originalPrefix = log.prefix;
    log.prefix = undefined;
    log.info(
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
          .trim()
    );
    log.prefix = originalPrefix;
  }

  const isTypeModule = pkgJson.type === "module";
  if (!isSilent) {
    if (isTypeModule) {
      log.info(`Package is an ES module (package.json#/type is "module")`);
    } else {
      log.info(
        `Package is a CommonJS module (${pkgJson.type === "commonjs" ? 'package.json#/type is "commonjs"' : 'package.json#/type not set to "module"'})`
      );
    }
  }

  //////////////////////////////////////////////
  ///   clean up outDir and declarationDir   ///
  //////////////////////////////////////////////
  const prefix = isDryRun ? "[dryrun] " : "";
  if (relRootDir.startsWith(relOutDir)) {
    if (!isSilent) {
      log.info(`${prefix}Skipping cleanup of outDir as it contains source files`);
    }
  } else {
    // source files are in the outDir, so skip cleanup
    // clean up outDir and declarationDir
    if (!isSilent) {
      log.info(`${prefix}Cleaning up outDir...`);
    }
    if (!isDryRun) {
      fs.rmSync(outDir, { recursive: true, force: true });

      // // print success message in verbose mode
      if (isVerbose) {
        if (fs.existsSync(outDir)) {
          log.error(`❌ Failed to clean up outDir: ${relOutDir}. Directory still exists.`);
        }
      }
    }
  }
  if (relDeclarationDir !== relOutDir) {
    // already done
  } else if (relRootDir.startsWith(relDeclarationDir)) {
    if (!isSilent) {
      log.info(`${prefix}Skipping cleanup of declarationDir as it contains source files`);
    }
  } else {
    if (!isSilent) {
      log.info(`${prefix}Cleaning up declarationDir...`);
    }
    if (!isDryRun) {
      fs.rmSync(declarationDir, { recursive: true, force: true });
      // // print success message in verbose mode
      if (isVerbose) {
        if (fs.existsSync(declarationDir)) {
          log.error(`❌ Failed to clean up declarationDir: ${relDeclarationDir}. Directory still exists.`);
        }
      }
    }
  }

  ///////////////////////////////
  ///       compile tsc        ///
  ///////////////////////////////

  const uniqueEntryPoints = [...new Set(entryPoints)];
  // try {
  if (isVerbose) {
    log.info(`Resolved entrypoints: ${formatForLog(uniqueEntryPoints)}`);
    log.info(
      `Resolved compilerOptions: ${formatForLog({
        ...tsconfigJson,
        module: ts.ModuleKind[tsconfigJson.module!],
        moduleResolution: ts.ModuleResolutionKind[tsconfigJson.moduleResolution!],
        target: ts.ScriptTarget[tsconfigJson.target!],
      })}`
    );
  }

  // Create a build context to track written files, copied assets, and compilation errors/warnings
  const buildContext: BuildContext = {
    writtenFiles: new Set<string>(),
    copiedAssets: new Set<string>(),
    errorCount: 0,
    warningCount: 0,
  };

  // Check if CJS should be skipped
  const skipCjs = config.cjs === false;

  // CJS
  if (!skipCjs) {
    if (!isSilent) {
      log.info(`Building CJS...${isTypeModule ? ` (rewriting .ts -> .cjs/.d.cts)` : ``}`);
    }
    await compileProject(
      {
        configPath: tsconfigPath,
        ext: isTypeModule ? "cjs" : "js",
        format: "cjs",
        verbose: isVerbose,
        dryRun: isDryRun,
        pkgJsonDir,
        rootDir,
        cjsInterop: isCjsInterop,
        compilerOptions: {
          ...tsconfigJson,
          module: ts.ModuleKind.CommonJS,
          moduleResolution: ts.ModuleResolutionKind.Node10,
          outDir,
        },
      },
      uniqueEntryPoints,
      buildContext
    );
  } else {
    if (!isSilent) {
      log.info("Skipping CJS build (cjs: false)");
    }
  }

  // ESM
  if (!isSilent) {
    log.info(`Building ESM...${isTypeModule ? `` : ` (rewriting .ts -> .mjs/.d.mts)`}`);
  }
  await compileProject(
    {
      configPath: tsconfigPath,
      ext: isTypeModule ? "js" : "mjs",
      format: "esm",
      verbose: isVerbose,
      dryRun: isDryRun,
      pkgJsonDir,
      rootDir,
      cjsInterop: isCjsInterop,
      compilerOptions: {
        ...tsconfigJson,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        outDir,
      },
    },
    uniqueEntryPoints,
    buildContext
  );

  ///////////////////////////////////
  ///      copy asset entrypoints  ///
  ///////////////////////////////////

  // Copy asset entrypoints to output directory
  if (assetEntrypoints.length > 0) {
    if (!isSilent) {
      log.info(`${prefix}Copying ${assetEntrypoints.length} asset${assetEntrypoints.length === 1 ? "" : "s"}...`);
    }

    for (const { sourcePath } of assetEntrypoints) {
      const sourceFile = path.resolve(pkgJsonDir, sourcePath);
      const relativePath = path.relative(rootDir, path.resolve(pkgJsonDir, sourcePath));
      const destFile = path.resolve(outDir, relativePath);
      const destDir = path.dirname(destFile);

      if (!fs.existsSync(sourceFile)) {
        log.warn(`Asset not found: ${sourcePath}`);
        continue;
      }

      if (!isDryRun) {
        fs.mkdirSync(destDir, { recursive: true });
        fs.copyFileSync(sourceFile, destFile);
      }

      // Track the copied file
      buildContext.copiedAssets.add(toPosix(path.relative(pkgJsonDir, destFile)));

      if (isVerbose) {
        const relativeSource = toPosix(path.relative(pkgJsonDir, sourceFile));
        const relativeDest = toPosix(path.relative(pkgJsonDir, destFile));
        log.info(`${isDryRun ? "[dryrun] " : ""}Copied asset: ./${relativeSource} → ./${relativeDest}`);
      }
    }
  }

  ///////////////////////////////////
  ///      display written files  ///
  ///////////////////////////////////

  // Display files that were written or would be written (only in verbose mode)
  if (isVerbose && buildContext.writtenFiles.size > 0) {
    log.info(`${prefix}Writing files (${buildContext.writtenFiles.size} total)...`);

    // Sort files by relative path for consistent display
    const sortedFiles = [...buildContext.writtenFiles]
      .map((file) => relativePosix(pkgJsonDir, file))
      .sort()
      .map((relPath) => (relPath.startsWith(".") ? relPath : `./${relPath}`));

    // Temporarily disable prefix for individual file listings
    const originalPrefix = log.prefix;
    log.prefix = undefined;
    sortedFiles.forEach((file) => {
      log.info(`     ${file}`);
    });
    log.prefix = originalPrefix;
  }

  ///////////////////////////////
  ///   generate exports      ///
  ///////////////////////////////

  // generate package.json exports
  if (config.noEdit) {
    if (!isSilent) {
      log.info("[noedit] Skipping modification of package.json");
    }
  } else {
    // Generate exports based on zshy config
    if (!isSilent) {
      log.info(`${prefix}Updating package.json...`);
    }
    const newExports: Record<string, any> = {};

    if (config.exports) {
      for (const [exportPath, sourcePath] of Object.entries(config.exports)) {
        if (exportPath.includes("package.json")) {
          newExports[exportPath] = sourcePath;
          continue;
        }
        const absSourcePath = path.resolve(pkgJsonDir, sourcePath);
        const relSourcePath = path.relative(rootDir, absSourcePath);
        const absJsPath = path.resolve(outDir, relSourcePath);
        const absDtsPath = path.resolve(declarationDir, relSourcePath);
        let relJsPath = "./" + relativePosix(pkgJsonDir, absJsPath);
        let relDtsPath = "./" + relativePosix(pkgJsonDir, absDtsPath);

        if (typeof sourcePath === "string") {
          if (sourcePath.endsWith("/*") || sourcePath.endsWith("/**/*")) {
            // Handle wildcard exports
            const finalExportPath = exportPath;

            if (finalExportPath.includes("**")) {
              log.error(`❌ Export keys cannot contain "**": ${finalExportPath}`);
              process.exit(1);
            }

            // Convert deep glob patterns to simple wildcard patterns in the final export
            if (sourcePath.endsWith("/**/*")) {
              // Also convert the output paths from /**/* to /*
              if (relJsPath.endsWith("/**/*")) {
                relJsPath = relJsPath.slice(0, -5) + "/*";
              }
              if (relDtsPath.endsWith("/**/*")) {
                relDtsPath = relDtsPath.slice(0, -5) + "/*";
              }
            }

            // Build exports object with proper condition ordering
            const exportObj: Record<string, string> = {};

            // Add custom conditions first in their original order
            if (config.conditions) {
              for (const [condition, value] of Object.entries(config.conditions)) {
                if (value === "src") {
                  exportObj[condition] = sourcePath;
                } else if (value === "esm") {
                  exportObj[condition] = relJsPath;
                } else if (value === "cjs") {
                  exportObj[condition] = relJsPath;
                }
              }
            }

            // Add standard conditions
            exportObj.types = relDtsPath;
            if (skipCjs) {
              // ESM-only: use default condition instead of import
              exportObj.default = relJsPath;
            } else {
              // Dual CJS/ESM: use import and require
              exportObj.import = relJsPath;
              exportObj.require = relJsPath;
            }

            newExports[finalExportPath] = exportObj;
          } else if (isSourceFile(sourcePath)) {
            const esmPath = removeExtension(relJsPath) + (isTypeModule ? `.js` : `.mjs`);
            const cjsPath = removeExtension(relJsPath) + (isTypeModule ? `.cjs` : `.js`);
            // Use ESM type declarations when CJS is skipped, otherwise use CJS declarations
            const dtsExt = skipCjs ? (isTypeModule ? ".d.ts" : ".d.mts") : isTypeModule ? ".d.cts" : ".d.ts";
            const dtsPath = removeExtension(relDtsPath) + dtsExt;

            // Build exports object with proper condition ordering
            const exportObj: Record<string, string> = {};

            // Add custom conditions first in their original order
            if (config.conditions) {
              for (const [condition, value] of Object.entries(config.conditions)) {
                if (value === "src") {
                  exportObj[condition] = sourcePath;
                } else if (value === "esm") {
                  exportObj[condition] = esmPath;
                } else if (value === "cjs") {
                  exportObj[condition] = cjsPath;
                }
              }
            }

            // Add standard conditions
            exportObj.types = dtsPath;
            if (skipCjs) {
              // ESM-only: use default condition instead of import
              exportObj.default = esmPath;
            } else {
              // Dual CJS/ESM: use import and require
              exportObj.import = esmPath;
              exportObj.require = cjsPath;
            }

            newExports[exportPath] = exportObj;

            if (exportPath === ".") {
              if (!skipCjs) {
                pkgJson.main = cjsPath;
                pkgJson.module = esmPath;
                pkgJson.types = dtsPath;
              } else {
                // Only set module and types, not main
                pkgJson.module = esmPath;
                pkgJson.types = dtsPath;
              }
              if (isVerbose) {
                log.info(`Setting "main": ${formatForLog(cjsPath)}`);
                log.info(`Setting "module": ${formatForLog(esmPath)}`);
                log.info(`Setting "types": ${formatForLog(dtsPath)}`);
              }
            }
          }
        }
      }

      // Handle asset entrypoints (only those that don't already have exports from TypeScript compilation)
      for (const { exportPath, sourcePath } of assetEntrypoints) {
        // Skip if this export path was already handled by TypeScript compilation
        if (newExports[exportPath]) {
          continue;
        }

        const absSourcePath = path.resolve(pkgJsonDir, sourcePath);
        const relSourcePath = path.relative(rootDir, absSourcePath);
        const absAssetPath = path.resolve(outDir, relSourcePath);
        const relAssetPath = "./" + relativePosix(pkgJsonDir, absAssetPath);

        // Assets are not source code - they just get copied and referenced with a simple path
        newExports[exportPath] = relAssetPath;

        // Handle root export special fields (only if no TypeScript root export exists)
        if (exportPath === ".") {
          if (!skipCjs) {
            pkgJson.main = relAssetPath;
            pkgJson.module = relAssetPath;
            pkgJson.types = relAssetPath;
          } else {
            pkgJson.module = relAssetPath;
            pkgJson.types = relAssetPath;
          }
          if (isVerbose) {
            log.info(`Setting "main": ${formatForLog(relAssetPath)}`);
            log.info(`Setting "module": ${formatForLog(relAssetPath)}`);
            log.info(`Setting "types": ${formatForLog(relAssetPath)}`);
          }
        }
      }

      pkgJson.exports = newExports;
      if (isVerbose) {
        log.info(`Setting "exports": ${formatForLog(newExports)}`);
      }
    }

    ///////////////////////////////
    ///      generate bin        ///
    ///////////////////////////////

    // Generate bin field based on zshy bin config
    if (config.bin) {
      const newBin: Record<string, string> = {};

      // Convert config.bin to object format for processing
      const binEntries = typeof config.bin === "string" ? [[pkgJson.name, config.bin]] : Object.entries(config.bin);

      for (const [binName, sourcePath] of binEntries) {
        if (typeof sourcePath === "string" && isSourceFile(sourcePath)) {
          const absSourcePath = path.resolve(pkgJsonDir, sourcePath);
          const relSourcePath = path.relative(rootDir, absSourcePath);
          const absJsPath = path.resolve(outDir, relSourcePath);
          const relJsPath = "./" + relativePosix(pkgJsonDir, absJsPath);

          // Use ESM files for bin when CJS is skipped, otherwise use CJS
          const binExt = skipCjs ? (isTypeModule ? ".js" : ".mjs") : isTypeModule ? ".cjs" : ".js";
          const binPath = removeExtension(relJsPath) + binExt;
          newBin[binName] = binPath;
        }
      }

      // If original config.bin was a string, output as string
      if (typeof config.bin === "string") {
        pkgJson.bin = Object.values(newBin)[0];
      } else {
        // Output as object
        pkgJson.bin = newBin;
      }

      if (isVerbose) {
        log.info(`Setting "bin": ${formatForLog(pkgJson.bin)}`);
      }
    }

    if (isDryRun) {
      ///////////////////////////////
      ///     write pkg json      ///
      ///////////////////////////////
      log.info("[dryrun] Skipping package.json modification");
    } else {
      fs.writeFileSync(packageJsonPath, JSON.stringify(pkgJson, null, pkgJsonIndent) + "\n");
    }
  }

  if (isAttw) {
    // run `@arethetypeswrong/cli --pack .` to check types

    if (!isSilent) {
      log.info("Checking types with @arethetypeswrong/cli...");
    }
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");

    const execFileAsync = promisify(execFile);
    const [cmd, ...args] = `${pmExec} @arethetypeswrong/cli --pack ${pkgJsonDir} --format table-flipped`.split(" ");
    console.dir([cmd, ...args], { depth: null });

    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    try {
      const result = await execFileAsync(cmd!, args, {
        cwd: pkgJsonDir,
        encoding: "utf-8",
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error: any) {
      stdout = error.stdout || "";
      stderr = error.stderr || "";
      exitCode = error.code || 1;
    }

    const output = stdout || stderr;
    if (output) {
      const indentedOutput = output
        .split("\n")
        .map((line: string) => `   ${line}`)
        .join("\n");

      if (exitCode === 0) {
        log.info(indentedOutput);
      } else {
        log.error(indentedOutput);
        log.warn("ATTW found issues, but the build was not affected.");
      }
    }
  }

  // Report total compilation results
  if (buildContext.errorCount > 0 || buildContext.warningCount > 0) {
    log.info(
      `Compilation finished with ${buildContext.errorCount} error${buildContext.errorCount === 1 ? "" : "s"} and ${buildContext.warningCount} warning${buildContext.warningCount === 1 ? "" : "s"}`
    );

    // Apply threshold rules for exit code
    if (failThreshold !== "never" && buildContext.errorCount > 0) {
      // Both 'warn' and 'error' thresholds cause failure on errors
      log.error("❌ Build completed with errors");
      process.exit(1);
    } else if (failThreshold === "warn" && buildContext.warningCount > 0) {
      // Only 'warn' threshold causes failure on warnings
      log.warn(`Build completed with warnings (exiting with error due to --fail-threshold=warn)`);
      process.exit(1);
    } else if (buildContext.errorCount > 0) {
      // If we got here with errors, we're in 'never' mode
      log.warn(`Build completed with errors (continuing due to --fail-threshold=never)`);
    } else {
      // Just warnings and not failing on them
      log.info(`Build complete with warnings`);
    }
  } else {
    if (!isSilent) {
      log.info("Build complete! ✅");
    }
  }
}
