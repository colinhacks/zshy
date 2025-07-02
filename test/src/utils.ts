/**
 * Utility functions for the test library
 */

// triple slash for module.d.ts
/// <reference path="./module.d.ts" />
// Test dynamic import of assets
export const loadDocumentation = async (): Promise<string> => {
  const readme = await import("./assets/README.md");
  return readme.default || "Documentation not found";
};

export const formatMessage = (message: string): string => {
  return `[LOG] ${message}`;
};

export const isProduction = (): boolean => {
  return process.env.NODE_ENV === "production";
};

export const delay = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export interface Logger {
  log(message: string): void;
  error(message: string): void;
}

export class ConsoleLogger implements Logger {
  log(message: string): void {
    console.log(formatMessage(message));
  }

  error(message: string): void {
    console.error(formatMessage(`ERROR: ${message}`));
  }
}
