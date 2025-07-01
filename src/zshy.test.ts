import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

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
			// Run zshy using tsx with --project flag in verbose mode
			const result = execSync(
				`tsx src/index.ts --project ./${tsconfigFile} --verbose`,
				{
					encoding: "utf-8",
					stdio: "pipe",
					timeout: 25000,
				},
			);
			stdout = result;
		} catch (error: any) {
			stderr = error.stderr || "";
			stdout = error.stdout || "";
			exitCode = error.status || 1;
		}

		return {
			exitCode,
			stdout: normalizeOutput(stdout),
			stderr: normalizeOutput(stderr),
		};
	};

	it("should work with basic.test.tsconfig.json", () => {
		const snapshot = runZshyWithTsconfig("basic.test.tsconfig.json");
		expect(snapshot).toMatchSnapshot();
	});

	it("should work with separate-declarations.test.tsconfig.json", () => {
		const snapshot = runZshyWithTsconfig(
			"separate-declarations.test.tsconfig.json",
		);
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
			.replace(/\/Users\/[^/]+\/[^/\s]+\/projects\/zshy/g, "<project-root>")
			// Normalize any absolute paths
			.replace(/\/[^\s]+\/zshy/g, "<project-root>")
			// Normalize timestamps and timing info
			.replace(/\d+ms/g, "<time>")
			// Normalize any specific file counts that might vary
			.replace(/\(\d+ matches\)/g, "(<count> matches)")
			// Remove any ANSI color codes
			.replace(/\u001b\[[0-9;]*m/g, "")
			// Normalize line endings
			.replace(/\r\n/g, "\n")
			// Trim trailing whitespace
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			.trim()
	);
}
