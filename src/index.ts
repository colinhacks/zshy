#!/usr/bin/env node

import { main } from "./main";
import { emojiLog } from "./utils";

// Run the script
main().catch((error) => {
  emojiLog("❌", `Build failed: ${error}`, "error");
  process.exit(1);
});
