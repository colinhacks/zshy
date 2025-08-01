/**
 * Main entry point for the test library
 */
import "./assets/styles.css";
import appConfig from "./assets/config.json";
import hello from "./hello.js";
import * as utilsC from "./utils.js";
import * as utilsA from "./utils.js";
import * as utilsB from "./utils.js";
export * from "./utils.js";
export * as utilsA from "./utils.js";
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
export const createConfig = (name, version) => {
    return { name, version };
};
export const defaultConfig = {
    name: "test-library",
    version: "1.0.0",
};
// Export the imported JSON config
export { appConfig };
// Re-export utilities
export * from "./utils.js";
//# sourceMappingURL=index.js.map