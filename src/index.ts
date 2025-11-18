#!/usr/bin/env node

import { main } from "./main.js";
import { log } from "./utils.js";

// Run the script
main().catch((error) => {
  log.error(`Build failed: ${error}`);
  process.exit(1);
});
