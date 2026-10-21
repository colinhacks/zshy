#!/usr/bin/env node

import * as ts from "typescript";
import { log, supportsTypeScript } from "./utils.js";

// Checked before main.js loads, because loading it imports `typescript/sync`, which an older TypeScript does not have.
if (!supportsTypeScript(ts.version ?? "")) {
  log.error(
    `❌ zshy requires TypeScript 7.1 or later, but TypeScript ${ts.version} is installed. Upgrade TypeScript, or use zshy 0.8 to build with TypeScript 5 or 6.`
  );
  process.exit(1);
}

// Run the script
import("./main.js")
  .then(({ main }) => main())
  .catch((error) => {
    log.error(`Build failed: ${error}`);
    process.exit(1);
  });
