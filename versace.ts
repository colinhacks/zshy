#!/usr/bin/env tsx

import arg from "arg";
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import semver from "semver";

const VERSION_FILE = "VERSION.txt";
const PACKAGE_JSON = "package.json";

interface PackageJson {
  name?: string;
  version: string;
  [key: string]: any;
}

function readVersionFile(): string {
  if (!existsSync(VERSION_FILE)) {
    throw new Error(`${VERSION_FILE} not found`);
  }

  const version = readFileSync(VERSION_FILE, "utf-8").trim();
  if (!version) {
    throw new Error(`${VERSION_FILE} is empty`);
  }

  return version;
}

function validateVersion(version: string): void {
  const versionRegex = /^\d+\.\d+\.\d+$/;
  if (!versionRegex.test(version)) {
    throw new Error(`Invalid version format: ${version}. Expected format: x.y.z`);
  }
}

function readPackageJson(): PackageJson {
  if (!existsSync(PACKAGE_JSON)) {
    throw new Error(`${PACKAGE_JSON} not found`);
  }

  const content = readFileSync(PACKAGE_JSON, "utf-8");
  return JSON.parse(content);
}

function writePackageJson(packageJson: PackageJson): void {
  const content = JSON.stringify(packageJson, null, 2) + "\n";
  writeFileSync(PACKAGE_JSON, content);
}

function generatePreReleaseVersion(baseVersion: string, tag: string, bumpType: "patch" | "minor" | "major"): string {
  // First bump the base version
  const bumpedVersion = semver.inc(baseVersion, bumpType);
  if (!bumpedVersion) {
    throw new Error(`Failed to bump version ${baseVersion} with ${bumpType}`);
  }

  // Then add the prerelease tag with timestamp
  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "");

  return `${bumpedVersion}-${tag}.${timestamp}`;
}

function updatePackageVersion(newVersion: string): void {
  const packageJson = readPackageJson();
  const oldVersion = packageJson.version;

  console.log(`Updating version from ${oldVersion} to ${newVersion}`);

  packageJson.version = newVersion;
  writePackageJson(packageJson);
}

function restorePackageVersion(): void {
  const packageJson = readPackageJson();
  packageJson.version = "0.0.0";
  writePackageJson(packageJson);
  console.log("Restored package.json version to 0.0.0");
}

function isLiveOnNpm(name: string, version: string): boolean {
  try {
    const out = execSync(`npm view ${name}@${version} version`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() === version;
  } catch {
    // A version that does not exist makes `npm view` exit non-zero.
    return false;
  }
}

// npm's refusal when the version is already sitting in the staged queue. The exact wording is
// unverified against a real refusal, so the match is loose; anything it misses stays fatal.
const ALREADY_STAGED = /already (been )?staged|staged version|E409|EPUBLISHCONFLICT|previously published/i;

// `npm stage publish` puts the version in npm's staged queue instead of publishing it. The
// trusted publisher on zshy is stage-only, so CI cannot publish: a maintainer approves each
// staged version with 2FA (`npm stage approve <id>` / `pnpm stage approve`), and until then the
// version is reserved but not installable. Needs npm >= 11.15.
//
// Idempotent, so a re-run after an approval is safe: a live version is skipped, and a version
// already in the queue makes npm refuse, which is success here — the approval decides the rest.
function runNpmStagePublish(name: string, version: string, tag: string, additionalFlags: string[] = []): void {
  if (isLiveOnNpm(name, version)) {
    console.log(`✅ ${name}@${version} is already live on npm — nothing to stage`);
    return;
  }

  const flagsStr = additionalFlags.length > 0 ? ` ${additionalFlags.join(" ")}` : "";
  const command = `npm stage publish --tag ${tag}${flagsStr}`;
  console.log(`Running ${command}...`);

  try {
    process.stdout.write(execSync(command, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }));
    console.log(`✅ Staged ${name}@${version} with tag ${tag} — awaiting a maintainer's 2FA approval`);
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
    process.stdout.write(output);

    if (ALREADY_STAGED.test(output)) {
      console.log(`✅ ${name}@${version} is already staged — awaiting a maintainer's 2FA approval`);
      return;
    }

    console.error("❌ npm stage publish failed");
    throw error;
  }
}

function main(): void {
  try {
    // Parse known flags and collect remaining arguments
    const args = arg(
      {
        "--latest": Boolean,
        "--alpha": Boolean,
        "--beta": Boolean,
        "--canary": Boolean,
        "--patch": Boolean,
        "--minor": Boolean,
        "--major": Boolean,
      },
      {
        permissive: true, // Allow unknown flags to pass through
      }
    );

    // Handle version command
    if (args._?.[0] === "version") {
      const version = readVersionFile();
      console.log(version);
      process.exit(0);
    }

    // Check that exactly one tag is specified
    const tagOptions = ["--latest", "--alpha", "--beta", "--canary"] as const;
    const selectedTags = tagOptions.filter((tag) => args[tag]);

    if (selectedTags.length === 0) {
      console.error("❌ You must specify exactly one release tag: --latest, --alpha, --beta, or --canary");
      process.exit(1);
    }

    if (selectedTags.length > 1) {
      console.error("❌ You can only specify one release tag at a time");
      process.exit(1);
    }

    const selectedTag = selectedTags[0]!.replace("--", "");

    // Handle version bump flags
    const bumpOptions = ["--patch", "--minor", "--major"] as const;
    const selectedBumps = bumpOptions.filter((bump) => args[bump]);

    if (selectedTag === "latest" && selectedBumps.length > 0) {
      console.error("❌ Version bump flags (--patch, --minor, --major) are not allowed with --latest");
      process.exit(1);
    }

    if (selectedBumps.length > 1) {
      console.error("❌ You can only specify one version bump at a time: --patch, --minor, or --major");
      process.exit(1);
    }

    // Default to patch for pre-release tags
    const bumpType =
      selectedBumps.length > 0 ? (selectedBumps[0]!.replace("--", "") as "patch" | "minor" | "major") : "patch";

    // Collect any additional flags to pass through to npm publish
    const additionalFlags = args._ || [];

    // Read and validate version
    const baseVersion = readVersionFile();
    validateVersion(baseVersion);

    // Generate final version based on tag
    const finalVersion =
      selectedTag === "latest" ? baseVersion : generatePreReleaseVersion(baseVersion, selectedTag, bumpType);

    console.log(`📦 Preparing to stage version ${finalVersion} with tag ${selectedTag}`);
    if (selectedTag !== "latest") {
      console.log(`Version bump: ${bumpType} (${baseVersion} → ${finalVersion})`);
    }
    if (additionalFlags.length > 0) {
      console.log(`Additional flags: ${additionalFlags.join(" ")}`);
    }

    const name = readPackageJson().name ?? "zshy";

    try {
      // Update package.json
      updatePackageVersion(finalVersion);

      // Stage, rather than publish — see runNpmStagePublish.
      runNpmStagePublish(name, finalVersion, selectedTag, additionalFlags);
    } finally {
      // Always restore the original version
      restorePackageVersion();
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ARG_UNKNOWN_OPTION") {
      console.error(
        "❌ Unknown option detected. All flags except --latest, --alpha, --beta, --canary, --patch, --minor, --major will be passed to npm stage publish"
      );
    } else {
      console.error("❌ Error:", (error as Error).message);
    }
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
