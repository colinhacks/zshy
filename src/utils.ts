import * as path from "node:path";
import * as ts from "typescript";

export function formatForLog(data: unknown) {
  return JSON.stringify(data, null, 2).split("\n").join("\n   ");
}

export function emojiLog(_emoji: string, content: string, level: "log" | "warn" | "error" = "log") {
  console[level]("→  " + content);
}

export function isSourceFile(filePath: string): boolean {
  return (
    filePath.endsWith(".ts") || filePath.endsWith(".mts") || filePath.endsWith(".cts") || filePath.endsWith(".tsx")
  );
}

export function removeExtension(filePath: string): string {
  return filePath.split(".").slice(0, -1).join(".") || filePath;
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

export const jsExtensions: Set<string> = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx"]);

export function isAssetFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === "") return false;
  return !jsExtensions.has(ext);
}
