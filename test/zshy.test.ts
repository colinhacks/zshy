import { spawnSync } from "node:child_process";
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
      "index.d.ts.map",
      "index.cjs",
      "index.d.cts",
      "index.d.cts.map",
      "index.mjs",
      "index.d.mts",
      "index.d.mts.map",
      "utils.js",
      "utils.d.ts",
      "utils.d.ts.map",
      "utils.cjs",
      "utils.d.cts",
      "utils.d.cts.map",
      "utils.mjs",
      "utils.d.mts",
      "utils.d.mts.map",
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
  const runZshyWithTsconfig = (tsconfigFile: string, opts: { dryRun: boolean } = { dryRun: false }) => {
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    try {
      // Run zshy using tsx with --project flag in verbose mode and dry-run from test directory
      const args = ["../src/index.ts", "--project", `./${tsconfigFile}`, "--verbose"];
      if (opts.dryRun) {
        args.push("--dry-run");
      }
      const result = spawnSync("tsx", args, {
        encoding: "utf8",
        timeout: 30000, // Increase timeout for CI
        cwd: process.cwd() + "/test", // Use relative path that works in CI
        env: {
          ...process.env,
          // Force UTF-8 encoding
          LC_ALL: "C.UTF-8",
          LANG: "C.UTF-8",
        },
      });

      stdout = result.stdout || "";
      stderr = result.stderr || "";
      exitCode = result.status || 0;

      // Handle spawn errors
      if (result.error) {
        stderr = result.error.message;
        exitCode = 1;
      }
    } catch (error: any) {
      stderr = error.message || "";
      exitCode = 1;
    }

    // Combine stdout and stderr for comprehensive output capture
    const combinedOutput = [stdout, stderr].filter(Boolean).join("\n");

    // Debug logging for CI issues
    if (process.env.CI && !combinedOutput.trim()) {
      console.log("DEBUG - No output captured:");
      console.log("Exit code:", exitCode);
      console.log("Stdout length:", stdout.length);
      console.log("Stderr length:", stderr.length);
      console.log("Combined output length:", combinedOutput.length);
      console.log("Working directory:", process.cwd());
    }

    return {
      exitCode,
      stdout: normalizeOutput(combinedOutput),
      stderr: normalizeOutput(stderr),
    };
  };

  it("should work with basic.test.tsconfig.json", () => {
    // only run this one with dryRun: false
    // results are tracked in git
    const snapshot = runZshyWithTsconfig("tsconfig.basic.json", { dryRun: false });

    // Check that assets are being detected and copied
    expect(snapshot.stdout).toContain("Found 5 asset import(s), copying to output directory...");
    expect(snapshot.stdout).toContain("Copied asset: ./src/assets/styles.css");
    expect(snapshot.stdout).toContain("Copied asset: ./src/assets/config.json");
    expect(snapshot.stdout).toContain("Copied asset: ./src/assets/README.md");
    expect(snapshot.stdout).toContain("Copied asset: ./src/plugins/plugin-a.css");
    expect(snapshot.stdout).toContain("Copied asset: ./src/plugins/plugin-b.css");

    expect(snapshot).toMatchSnapshot();
  });

  it("should work with tsconfig.custom-paths.json", () => {
    const snapshot = runZshyWithTsconfig("tsconfig.custom-paths.json", { dryRun: true });
    expect(snapshot).toMatchSnapshot();
  });

  it("should work with tsconfig.flat.json", () => {
    const snapshot = runZshyWithTsconfig("tsconfig.flat.json", { dryRun: true });
    expect(snapshot).toMatchSnapshot();
  });
});

function normalizeOutput(output: string): string {
  return (
    output
      // Normalize file paths to be relative and use forward slashes
      .replace(/\/Users\/[^/]+\/[^/\s]+\/projects\/zshy/g, "<root>")
      // Normalize any absolute paths
      .replace(/\/[^\s]+\/zshy/g, "<root>")
      // Normalize timestamps and timing info
      .replace(/\d+ms/g, "<time>")
      // Normalize any specific file counts that might vary
      // .replace(/\(\d+ matches\)/g, "(<count> matches)")
      .replace(/Detected package manager: [^\n]+/g, "Detected package manager: <pm>")
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
