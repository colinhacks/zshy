import * as ts from "typescript";
import { type BuildContext, compileProject, type ProjectOptions } from "./compile.js";
import { readTsconfig } from "./utils.js";

// TypeScript 7 publishes a new compiler API under the old package name, and the classic one is gone from it: under 7.x,
// `import * as ts from "typescript"` yields nothing but `version`. So the installed version decides which engine builds.
export type EngineKind = "classic" | "ts7";

export interface Engine {
  kind: EngineKind;
  version: string;
  // typed as the classic enums, since TypeScript 7 keeps the classic value of every member zshy uses
  ModuleKind: typeof ts.ModuleKind;
  ModuleResolutionKind: typeof ts.ModuleResolutionKind;
  ScriptTarget: typeof ts.ScriptTarget;
  readTsconfig(tsconfigPath: string): ts.CompilerOptions;
  compileProject(config: ProjectOptions, entryPoints: string[], ctx: BuildContext): Promise<void>;
  close(): void;
}

// 7.0 shipped the new API only as a preview under `typescript/unstable/*`; 7.1 is the first release with the stable entry points
export function engineKindFor(version: string): EngineKind | undefined {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (major < 7) return "classic";
  if (major === 7 && minor < 1) return undefined;
  return "ts7";
}

export async function loadEngine(): Promise<Engine> {
  const kind = engineKindFor(ts.version);

  if (kind === undefined) {
    throw new Error(
      `TypeScript ${ts.version} is not supported: TypeScript 7.0 has no stable compiler API. Install typescript@^7.1, or typescript@^6 for the classic API.`
    );
  }

  if (kind === "classic") {
    return {
      kind,
      version: ts.version,
      ModuleKind: ts.ModuleKind,
      ModuleResolutionKind: ts.ModuleResolutionKind,
      ScriptTarget: ts.ScriptTarget,
      readTsconfig,
      compileProject,
      close() {},
    };
  }

  // loaded only here: `typescript/sync` does not exist before 7.1, so importing it any earlier would break every classic build
  let ts7: typeof import("./compile-ts7.js");
  try {
    ts7 = await import("./compile-ts7.js");
  } catch (error) {
    throw new Error(
      `TypeScript ${ts.version} does not provide the typescript/sync API zshy builds with: ${error instanceof Error ? error.message : error}`
    );
  }
  return ts7.createTs7Engine(ts.version);
}
