/**
 * Main entry point for the test library
 */
import "./assets/styles.css";
import appConfig from "./assets/config.json";

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
