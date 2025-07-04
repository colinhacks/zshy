import * as fs from "node:fs";
import * as path from "node:path/posix";
import parseArgs from "arg";
import { globby } from "globby";
import { table } from "table";
import * as ts from "typescript";
import { type BuildContext, compileProject } from "./compile";
import { emojiLog, formatForLog, isSourceFile, readTsconfig, removeExtension } from "./utils";

export async function main(): Promise<void> {
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
      "--dry-run": Boolean,
      "--fail-threshold": String,
      // "--attw": Boolean,

      // Aliases
      "-h": "--help",
      "-p": "--project",
    });
  } catch (error) {
    if (error instanceof Error) {
      emojiLog("❌", error.message, "error");
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
      --dry-run                     Don't write any files, just log what would be done
      --fail-threshold <threshold>  When to exit with non-zero error code
                                      "error" (default)
                                      "warn"
                                      "never"

Examples:
  zshy                                    # Run build
  zshy --project ./tsconfig.build.json    # Use specific tsconfig file (defaults to tsconfig.json)
  zshy --verbose                          # Enable verbose logging
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

  emojiLog("💎", "Starting build... 🐒");

  const isVerbose = !!args["--verbose"];
  const isDryRun = !!args["--dry-run"];
  const failThreshold = args["--fail-threshold"] || "error"; // Default to 'error'
  const dryRunPrefix = isDryRun ? "[dryrun] " : "";

  // Validate that the threshold value is one of the allowed values
  if (failThreshold !== "never" && failThreshold !== "warn" && failThreshold !== "error") {
    emojiLog(
      "❌",
      `Invalid value for --fail-threshold: "${failThreshold}". Valid values are "never", "warn", or "error"`,
      "error"
    );
    process.exit(1);
  }

  const isAttw = false; // args["--attw"];

  if (isVerbose) {
    emojiLog("ℹ️", "Verbose mode enabled");
    emojiLog("📦", `Detected package manager: ${pmExec}`);
  }

  if (isDryRun) {
    emojiLog("🔍", "Dry run mode enabled. No files will be written or modified.");
  }

  // Display message about fail threshold setting
  if (failThreshold === "never") {
    emojiLog("ℹ️", "Build will always succeed regardless of errors or warnings");
  } else if (failThreshold === "warn") {
    emojiLog("⚠️", "Build will fail on warnings or errors");
  } else {
    emojiLog("ℹ️", "Build will fail only on errors (default)");
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
    emojiLog("❌", "package.json not found in current directory or any parent directories", "error");
    process.exit(1);
  }

  // read package.json and extract the "zshy" exports config
  // console.log("📦 Extracting entry points from package.json exports...");
  const pkgJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  const pkgJsonDir = path.dirname(packageJsonPath);

  // print project root
  emojiLog("⚙️", `Detected project root: ${pkgJsonDir}`);
  emojiLog("📦", `Reading package.json from ./${path.relative(pkgJsonDir, packageJsonPath)}`);

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
    emojiLog("❌", `No "${CONFIG_KEY}" key found in package.json`, "error");
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
      emojiLog("❌", `Missing "exports" key in package.json#/${CONFIG_KEY}`, "error");
      process.exit(1);
    } else if (typeof config.exports !== "object") {
      emojiLog("❌", `Invalid "exports" key in package.json#/${CONFIG_KEY}`, "error");
      process.exit(1);
    }

    // Validate bin field if present
    if (config.bin !== undefined) {
      if (typeof config.bin === "string") {
        // Keep string format - we'll handle this in entry point extraction
      } else if (typeof config.bin === "object" && config.bin !== null) {
        // Object format is valid
      } else {
        emojiLog("❌", `Invalid "bin" key in package.json#/${CONFIG_KEY}, expected string or object`, "error");
        process.exit(1);
      }
    }
    // {
    // 	exports: { ".": pkgJson[CONFIG_KEY].exports },
    // };
  } else if (typeof pkgJson[CONFIG_KEY] === "undefined") {
    emojiLog("❌", `Missing "${CONFIG_KEY}" key in package.json`, "error");
    process.exit(1);
  } else {
    emojiLog("❌", `Invalid "${CONFIG_KEY}" key in package.json, expected string or object`, "error");
    process.exit(1);
  }

  if (isVerbose) {
    emojiLog("🔧", `Parsed zshy config: ${formatForLog(config)}`);
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
        emojiLog(
          "❌",
          `--project must point to a tsconfig.json file, not a directory: ${resolvedProjectPath}`,
          "error"
        );
        process.exit(1);
      } else {
        // Use the file directly
        tsconfigPath = resolvedProjectPath;
      }
    } else {
      emojiLog("❌", `tsconfig.json file not found: ${resolvedProjectPath}`, "error");
      process.exit(1);
    }
  } else if (config.tsconfig) {
    // Fallback to package.json config
    const resolvedProjectPath = path.resolve(pkgJsonDir, config.tsconfig);

    if (fs.existsSync(resolvedProjectPath)) {
      if (fs.statSync(resolvedProjectPath).isDirectory()) {
        emojiLog(
          "❌",
          `zshy.tsconfig must point to a tsconfig.json file, not a directory: ${resolvedProjectPath}`,
          "error"
        );
        process.exit(1);
      } else {
        // Use the file directly
        tsconfigPath = resolvedProjectPath;
      }
    } else {
      emojiLog("❌", `Tsconfig file not found: ${resolvedProjectPath}`, "error");
      process.exit(1);
    }
  } else {
    // Default to tsconfig.json in the package.json directory
    tsconfigPath = path.join(pkgJsonDir, "tsconfig.json");
  }

  const _parsedConfig = readTsconfig(tsconfigPath);
  if (!fs.existsSync(tsconfigPath)) {
    // Check if tsconfig.json exists
    emojiLog("❌", `tsconfig.json not found at ${path.resolve(tsconfigPath)}`, "error");
    process.exit(1);
  }
  emojiLog("📁", `Reading tsconfig from ./${path.relative(pkgJsonDir, tsconfigPath)}`);

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
  const declarationDir = path.resolve(pkgJsonDir, _parsedConfig?.declarationDir || relOutDir);
  const relDeclarationDir = path.relative(pkgJsonDir, declarationDir);

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
      emojiLog(
        "⚠️",
        'You\'re building your code to the project root. This means your compiled files will be generated alongside your source files.\n   ➜ Setting "files" in package.json to exclude TypeScript source from the published package.'
      );
      pkgJson.files = ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.d.ts", "**/*.d.mts", "**/*.d.cts"];
    } else {
      emojiLog(
        `⚠️`,
        `You\'re building your code to the project root. This means your compiled files will be generated alongside your source files.
   Ensure that your "files" in package.json excludes TypeScript source files, or your users may experience .d.ts resolution issues in some environments:
     "files": ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.d.ts", "**/*.d.mts", "**/*.d.cts"]`
      );
    }
  } else {
    if (!pkgJson.files) {
      emojiLog("⚠️", `The "files" key is missing in package.json. Setting to "${relOutDir}".`);
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
  emojiLog("➡️", "Determining entrypoints...");
  const entryPoints: string[] = [];

  const rows: string[][] = [["Subpath", "Entrypoint"]];
  for (const [exportPath, sourcePath] of Object.entries(config.exports)) {
    if (exportPath.includes("package.json")) continue;
    let cleanExportPath!: string;
    if (exportPath === ".") {
      cleanExportPath = pkgJson.name;
    } else if (exportPath.startsWith("./")) {
      cleanExportPath = pkgJson.name + "/" + exportPath.slice(2);
    } else {
      emojiLog("⚠️", `Invalid subpath export "${exportPath}" — should start with "./"`, "warn");
      process.exit(1);
    }
    if (typeof sourcePath === "string") {
      if (sourcePath.includes("*")) {
        if (!sourcePath.endsWith("/*")) {
          emojiLog("❌", `Wildcard paths should not contain file extensions: ${sourcePath}`, "error");
          process.exit(1);
        }
        const pattern = sourcePath.slice(0, -2) + "/*.{ts,tsx,mts,cts}";
        const wildcardFiles = await globby([pattern], {
          ignore: ["**/*.d.ts", "**/*.d.mts", "**/*.d.cts"],
          cwd: pkgJsonDir,
          deep: 1,
        });
        entryPoints.push(...wildcardFiles);

        rows.push([`"${cleanExportPath}"`, `${sourcePath} (${wildcardFiles.length} matches)`]);
      } else if (isSourceFile(sourcePath)) {
        entryPoints.push(sourcePath);

        rows.push([`"${cleanExportPath}"`, sourcePath]);
      }
    }
  }

  // Extract bin entry points from zshy bin config
  if (config.bin) {
    if (typeof config.bin === "string") {
      // Single bin entry
      if (isSourceFile(config.bin)) {
        entryPoints.push(config.bin);
        rows.push([`bin:${pkgJson.name}`, config.bin]);
      }
    } else {
      // Multiple bin entries
      for (const [binName, sourcePath] of Object.entries(config.bin as Record<string, string>)) {
        if (typeof sourcePath === "string" && isSourceFile(sourcePath)) {
          entryPoints.push(sourcePath);
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
        .trim()
  );

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
    emojiLog("❌", "No entry points found matching the specified patterns in package.json#/zshy exports", "error");
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

  const relRootDir = path.relative(pkgJsonDir, rootDir);

  //////////////////////////////////
  ///   display resolved paths   ///
  //////////////////////////////////
  emojiLog("🔧", "Resolved build paths:");
  const pathRows: string[][] = [["Location", "Resolved path"]];

  pathRows.push(["rootDir", relRootDir ? `./${relRootDir}` : "."]);
  pathRows.push(["outDir", relOutDir ? `./${relOutDir}` : "."]);

  if (relDeclarationDir !== relOutDir) {
    pathRows.push(["declarationDir", relDeclarationDir ? `./${relDeclarationDir}` : "."]);
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
        .trim()
  );

  const isTypeModule = pkgJson.type === "module";
  if (isTypeModule) {
    emojiLog("🟨", `Package is an ES module (package.json#/type is "module")`);
  } else {
    emojiLog(
      "🐢",
      `Package is a CommonJS module (${pkgJson.type === "commonjs" ? 'package.json#/type is "commonjs"' : 'package.json#/type not set to "module"'})`
    );
  }

  //////////////////////////////////////////////
  ///   clean up outDir and declarationDir   ///
  //////////////////////////////////////////////
  console.log({ relOutDir, relRootDir, relDeclarationDir });
  if (relRootDir.startsWith(relOutDir)) {
    emojiLog("🗑️", `${dryRunPrefix}Skipping cleanup of outDir as it contains source files`);
  } else {
    // source files are in the outDir, so skip cleanup
    // clean up outDir and declarationDir
    emojiLog("🗑️", `${dryRunPrefix}Cleaning up outDir...`);
    if (!isDryRun) {
      fs.rmSync(outDir, { recursive: true, force: true });

      // // print success mesage in verbose mode
      if (isVerbose) {
        if (fs.existsSync(outDir)) {
          emojiLog("❌", `Failed to clean up outDir: ${relOutDir}. Directory still exists.`, "error");
        }
      }
    }
  }
  if (relDeclarationDir !== relOutDir) {
    // already done
  } else if (relRootDir.startsWith(relDeclarationDir)) {
    emojiLog("🗑️", `${dryRunPrefix}Skipping cleanup of declarationDir as it contains source files`);
  } else {
    emojiLog("🗑️", `${dryRunPrefix}Cleaning up declarationDir...`);
    if (!isDryRun) {
      fs.rmSync(declarationDir, { recursive: true, force: true });
      // // print success mesage in verbose mode
      if (isVerbose) {
        if (fs.existsSync(declarationDir)) {
          emojiLog("❌", `Failed to clean up declarationDir: ${relDeclarationDir}. Directory still exists.`, "error");
        }
      }
    }
  }

  ///////////////////////////////
  ///       compile tsc        ///
  ///////////////////////////////

  const uniqueEntryPoints = [...new Set(entryPoints)];
  try {
    if (isVerbose) {
      emojiLog("→", `Resolved entrypoints: ${formatForLog(uniqueEntryPoints)}`);
      emojiLog(
        "→",
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

    // CJS
    emojiLog("🧱", `Building CJS...${isTypeModule ? ` (rewriting .ts -> .cjs/.d.cts)` : ``}`);
    await compileProject(
      {
        configPath: tsconfigPath,
        mode: isTypeModule ? "cts" : "ts",
        verbose: isVerbose,
        dryRun: isDryRun,
        pkgJsonDir,
        rootDir,
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

    // ESM
    emojiLog("🧱", `Building ESM...${isTypeModule ? `` : ` (rewriting .ts -> .mjs/.d.mts)`}`);
    await compileProject(
      {
        configPath: tsconfigPath,
        mode: isTypeModule ? "ts" : "mts",
        verbose: isVerbose,
        dryRun: isDryRun,
        pkgJsonDir,
        rootDir,
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
    ///      display written files  ///
    ///////////////////////////////////

    // Display files that were written or would be written (only in verbose mode)
    if (isVerbose && buildContext.writtenFiles.size > 0) {
      emojiLog("📜", `${dryRunPrefix}Writing files (${buildContext.writtenFiles.size} total)...`);

      // Sort files by relative path for consistent display
      const sortedFiles = [...buildContext.writtenFiles]
        .map((file) => path.relative(pkgJsonDir, file))
        .sort()
        .map((relPath) => (relPath.startsWith(".") ? relPath : `./${relPath}`));

      sortedFiles.forEach((file) => {
        console.log(`     ${file}`);
      });
    }

    ///////////////////////////////
    ///   generate exports      ///
    ///////////////////////////////

    // generate package.json exports
    emojiLog("📦", `${dryRunPrefix}Updating package.json#/exports...`);

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
          const esmPath = removeExtension(relJsPath) + (isTypeModule ? `.js` : `.mjs`);
          const cjsPath = removeExtension(relJsPath) + (isTypeModule ? `.cjs` : `.js`);
          const dtsPath = removeExtension(relDtsPath) + (isTypeModule ? `.d.cts` : `.d.ts`); // ./

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
          emojiLog("❌", `Invalid entrypoint: ${sourcePath}`, "error");
          process.exit();
        }
      }
    }

    if (isVerbose) {
      emojiLog("🔧", `Generated "exports": ${formatForLog(newExports)}`);
    }

    ///////////////////////////////
    ///      generate bin        ///
    ///////////////////////////////

    // Generate bin field based on zshy bin config
    if (config.bin) {
      emojiLog("📦", `${dryRunPrefix}Updating package.json#/bin...`);
      const newBin: Record<string, string> = {};

      // Convert config.bin to object format for processing
      const binEntries = typeof config.bin === "string" ? [[pkgJson.name, config.bin]] : Object.entries(config.bin);

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
      } else {
        // Output as object
        pkgJson.bin = newBin;
      }

      if (isVerbose) {
        emojiLog("🔧", `Generated "bin": ${formatForLog(pkgJson.bin)}`);
      }
    }

    ///////////////////////////////
    ///     write pkg json      ///
    ///////////////////////////////

    // Update package.json with new exports
    pkgJson.exports = newExports;

    if (isDryRun) {
      emojiLog("📦", "[dryrun] Skipping package.json modification");
    } else {
      fs.writeFileSync(packageJsonPath, JSON.stringify(pkgJson, null, 2) + "\n");
    }

    if (isAttw) {
      // run `@arethetypeswrong/cli --pack .` to check types

      emojiLog("🔍", "Checking types with @arethetypeswrong/cli...");
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
          console.log(indentedOutput);
        } else {
          console.error(indentedOutput);
          emojiLog("⚠️", "ATTW found issues, but the build was not affected.", "warn");
        }
      }
    }

    // Report total compilation results
    if (buildContext.errorCount > 0 || buildContext.warningCount > 0) {
      emojiLog(
        "📊",
        `Compilation finished with ${buildContext.errorCount} error(s) and ${buildContext.warningCount} warning(s)`
      );

      // Apply threshold rules for exit code
      if (failThreshold !== "never" && buildContext.errorCount > 0) {
        // Both 'warn' and 'error' thresholds cause failure on errors
        emojiLog("❌", `Build completed with errors`, "error");
        process.exit(1);
      } else if (failThreshold === "warn" && buildContext.warningCount > 0) {
        // Only 'warn' threshold causes failure on warnings
        emojiLog("⚠️", `Build completed with warnings (exiting with error due to --fail-threshold=warn)`, "warn");
        process.exit(1);
      } else if (buildContext.errorCount > 0) {
        // If we got here with errors, we're in 'never' mode
        emojiLog("⚠️", `Build completed with errors (continuing due to --fail-threshold=never)`, "warn");
      } else {
        // Just warnings and not failing on them
        emojiLog("🎉", `Build complete with warnings`);
      }
    } else {
      emojiLog("🎉", "Build complete! ✅");
    }
  } catch (error) {
    emojiLog("❌", `Build failed: ${error}`, "error");
    process.exit(1);
  }
}
