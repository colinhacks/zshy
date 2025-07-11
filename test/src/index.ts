/**
 * Main entry point for the test library
 */
import "./assets/styles.css";
import appConfig from "./assets/config.json";
import hello from "./hello";
import * as utilsC from "./utils";
import * as utilsA from "./utils.js";
import * as utilsB from "./utils.ts";

export * from "./utils";
export * as utilsA from "./utils";

// code
console.log("🚀 Hello from zshy test fixture!");

// test default export
hello();

// test import.meta shims for CJS builds
console.log(import.meta.url);
console.log(import.meta.dirname);
console.log(import.meta.filename);

utilsA.delay(5);
utilsB.delay(5);
utilsC.delay(5);

export interface Config {
  name: string;
  version: string;
}

export const createConfig = (name: string, version: string): Config => {
  return { name, version };
};

export const defaultConfig: Config = {
  name: "test-library",
  version: "1.0.0",
};

// Export the imported JSON config
export { appConfig };

// Re-export utilities
export * from "./utils.js";
