/**
 * Main entry point for the test library
 */
export interface Config {
  name: string;
  version: string;
}

export const createConfig = (name: string, version: string): Config => {
  return { name, version };
};

export const defaultConfig: Config = {
  name: "test-library",
  version: "1.0.0"
};

// Re-export utilities
export * from './utils.js';
