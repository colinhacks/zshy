import * as fs from "node:fs";
import * as path from "node:path";

export function formatForLog(data: unknown) {
  return JSON.stringify(data, null, 2).split("\n").join("\n   ");
}

// Global logging state
let isSilent = false;

export function setSilent(silent: boolean) {
  isSilent = silent;
}

export const log = {
  prefix: undefined as string | undefined,

  info: function (message: string) {
    if (!isSilent) {
      console.log((this.prefix || "") + message);
    }
  },

  error: function (message: string) {
    if (!isSilent) {
      console.error((this.prefix || "") + message);
    }
  },

  warn: function (message: string) {
    if (!isSilent) {
      console.warn((this.prefix || "") + message);
    }
  },
};

export function isSourceFile(filePath: string): boolean {
  // Declaration files are not source files
  if (filePath.endsWith(".d.ts") || filePath.endsWith(".d.mts") || filePath.endsWith(".d.cts")) {
    return false;
  }

  // TypeScript source files
  return (
    filePath.endsWith(".ts") || filePath.endsWith(".mts") || filePath.endsWith(".cts") || filePath.endsWith(".tsx")
  );
}

export function removeExtension(filePath: string): string {
  return filePath.split(".").slice(0, -1).join(".") || filePath;
}

/**
 * zshy builds with the compiler API that TypeScript 7.1 introduced (`typescript/sync`). TypeScript 7.0 shipped it only
 * as a preview under `typescript/unstable/*`, and earlier releases have the classic API instead.
 */
export function supportsTypeScript(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  return major > 7 || (major === 7 && minor >= 1);
}

export const jsExtensions: Set<string> = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx"]);

export function isAssetFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === "") return false;
  return !jsExtensions.has(ext);
}

export const toPosix = (p: string): string => p.replaceAll(path.sep, path.posix.sep);

export const relativePosix = (from: string, to: string): string => {
  const relativePath = path.relative(from, to);
  return toPosix(relativePath);
};

export function isTestFile(filePath: string): boolean {
  const posixPath = toPosix(filePath);

  // Exclude files in __tests__ directories
  if (posixPath.includes("/__tests__/") || posixPath.includes("\\__tests__\\")) {
    return true;
  }

  // Exclude files matching .test.{ext} or .spec.{ext} pattern
  const testPattern = /\.(test|spec)\.(ts|tsx|mts|cts)$/;
  if (testPattern.test(filePath)) {
    return true;
  }

  return false;
}

export function findConfigPath(fileName: string): string | null {
  let resultPath = `./${fileName}`;
  let currentDir = process.cwd();

  while (currentDir !== path.dirname(currentDir)) {
    const candidatePath = path.join(currentDir, fileName);
    if (fs.existsSync(candidatePath)) {
      resultPath = candidatePath;
      break;
    }
    currentDir = path.dirname(currentDir);
  }

  return fs.existsSync(resultPath) ? resultPath : null;
}

export function detectConfigIndentation(fileContents: string): string | number {
  let indent: string | number = 2; // Default to 2 spaces
  const indentMatch = fileContents.match(/^([ \t]+)/m);

  if (indentMatch?.[1]) {
    indent = indentMatch[1];
  } else if (!fileContents.includes("\n")) {
    indent = 0; // minified
  }

  return indent;
}
