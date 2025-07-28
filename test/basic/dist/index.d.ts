/**
 * Main entry point for the test library
 */
import "./assets/styles.css";
import appConfig from "./assets/config.json";
export * from "./utils.js";
export * as utilsA from "./utils.js";
export interface Config {
    name: string;
    version: string;
}
export declare const createConfig: (name: string, version: string) => Config;
export declare const defaultConfig: Config;
export { appConfig };
export * from "./utils.js";
//# sourceMappingURL=index.d.ts.map