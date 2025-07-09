/**
 * Utility functions for the test library
 */
// triple slash for module.d.ts
/// <reference path="./module.d.ts" />
// Test dynamic import of assets
export const loadDocumentation = async () => {
    const readme = await import("./assets/README.md");
    return readme.default || "Documentation not found";
};
export const formatMessage = (message) => {
    return `[LOG] ${message}`;
};
export const isProduction = () => {
    // biome-ignore lint: ts
    return process.env["NODE_ENV"] === "production";
};
export const delay = (ms) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
};
export class ConsoleLogger {
    log(message) {
        console.log(formatMessage(message));
    }
    error(message) {
        console.error(formatMessage(`ERROR: ${message}`));
    }
}
//# sourceMappingURL=utils.js.map