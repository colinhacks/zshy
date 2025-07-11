#!/usr/bin/env node

import { main } from "./main.js";
import { emojiLog } from "./utils.js";

// Run the script
main().catch((error) => {
  emojiLog("❌", `Build failed: ${error}`, "error");
  process.exit(1);
});
