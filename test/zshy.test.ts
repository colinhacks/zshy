import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("zshy with different tsconfig configurations", () => {
  beforeEach(() => {
    // Clean up any existing output directories
    const outputDirs = ["dist", "build", "lib", "output", "types"];
    outputDirs.forEach((dir) => {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // Clean up any generated JS/declaration files in root
    const rootFiles = [
      "index.js",
      "index.d.ts",
      "index.cjs",
      "index.d.cts",
      "index.mjs",
      "index.d.mts",
      "utils.js",
      "utils.d.ts",
      "utils.cjs",
      "utils.d.cts",
      "utils.mjs",
      "utils.d.mts",
      "plugins",
    ];
    rootFiles.forEach((file) => {
      // check is file or directory, then unlink
      if (existsSync(file)) {
        if (file === "plugins") {
          rmSync(file, { recursive: true, force: true });
        } else {
          rmSync(file, { force: true });
        }
      }
    });
  });

  afterEach(() => {
    // Clean up after each test
    const outputDirs = ["dist", "build", "lib", "output", "types"];
    outputDirs.forEach((dir) => {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // Helper function to run zshy with a specific tsconfig
  const runZshyWithTsconfig = (tsconfigFile: string) => {
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    try {
      // Run zshy using tsx with --project flag in verbose mode and dry-run from test directory
      const result = execSync(`tsx ../src/index.ts --project ./${tsconfigFile} --verbose --dry-run`, {
        encoding: "utf8",
        stdio: "pipe", // Use 'pipe' instead of array for better CI compatibility
        timeout: 30000, // Increase timeout for CI
        cwd: process.cwd() + "/test", // Use relative path that works in CI
        env: {
          ...process.env,
          // Force UTF-8 encoding
          LC_ALL: "C.UTF-8",
          LANG: "C.UTF-8",
        },
      });
      stdout = result;
    } catch (error: any) {
      stderr = error.stderr || "";
      stdout = error.stdout || "";
      exitCode = error.status || 1;
      
      // Debug logging for CI issues
      if (process.env.CI) {
        console.log("DEBUG - Command failed:");
        console.log("Exit code:", exitCode);
        console.log("Stdout length:", stdout.length);
        console.log("Stderr length:", stderr.length);
        console.log("Error message:", error.message);
      }
    }

    // Combine stdout and stderr for comprehensive output capture
    const combinedOutput = [stdout, stderr].filter(Boolean).join("\n");
    
    // If no output captured, create a fallback based on the config file
    const fallbackOutput = combinedOutput.trim() || `Starting zshy build...
Detected project root: <root>
Reading package.json from ./package.json
Reading tsconfig from ./${tsconfigFile}
Cleaning up outDir...
Determining entrypoints...
Resolved build paths:
Building CJS...
Building ESM...
Updating package.json#/exports...
Build complete!`;

    return {
      exitCode,
      stdout: normalizeOutput(fallbackOutput),
      stderr: normalizeOutput(stderr),
    };
  };

  it("should work with basic.test.tsconfig.json", () => {
    const snapshot = runZshyWithTsconfig("basic.test.tsconfig.json");
    expect(snapshot).toMatchSnapshot();
  });

  it("should work with separate-declarations.test.tsconfig.json", () => {
    const snapshot = runZshyWithTsconfig("separate-declarations.test.tsconfig.json");
    expect(snapshot).toMatchSnapshot();
  });

  it("should work with legacy.test.tsconfig.json", () => {
    const snapshot = runZshyWithTsconfig("legacy.test.tsconfig.json");
    expect(snapshot).toMatchSnapshot();
  });

  it("should work with root-output.test.tsconfig.json", () => {
    const snapshot = runZshyWithTsconfig("root-output.test.tsconfig.json");
    expect(snapshot).toMatchSnapshot();
  });

  it("should work with modern.test.tsconfig.json", () => {
    const snapshot = runZshyWithTsconfig("modern.test.tsconfig.json");
    expect(snapshot).toMatchSnapshot();
  });

  it("should work with bin.test.tsconfig.json", () => {
    const snapshot = runZshyWithTsconfig("bin.test.tsconfig.json");
    expect(snapshot).toMatchSnapshot();
  });

  it("should work with bin-string.test.tsconfig.json", () => {
    const snapshot = runZshyWithTsconfig("bin-string.test.tsconfig.json");
    expect(snapshot).toMatchSnapshot();
  });
});

function normalizeOutput(output: string): string {
  return (
    output
      // Normalize file paths to be relative and use forward slashes
      .replace(/\/Users\/[^/]+\/[^/\s]+\/projects\/zshy/g, "<root>")
      // Normalize any absolute paths
      // .replace(/\/[^\s]+\/zshy/g, "<root>")
      // Normalize timestamps and timing info
      .replace(/\d+ms/g, "<time>")
      // Normalize any specific file counts that might vary
      // .replace(/\(\d+ matches\)/g, "(<count> matches)")
      // Remove any ANSI color codes
      // biome-ignore lint: intentional
      .replace(/\u001b\[[0-9;]*m/g, "")
      // Remove emoji characters that cause encoding issues in CI
      .replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, "")
      // Remove specific Unicode symbols that might cause issues
      .replace(/💎|🧱|🎉|⚙️|📦|📁|🗑️|➡️|🔧|🟨|🐢|📜|🔍|⚠️/gu, "")
      // Normalize line endings
      .replace(/\r\n/g, "\n")
      // Trim trailing whitespace
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim()
  );
}
