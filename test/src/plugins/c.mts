/**
 * Plugin B - Another example plugin for testing
 */
import "./plugin-b.css";

export interface PluginC {
  name: string;
  version: string;
  configure(options: Record<string, any>): void;
}

export const pluginC: PluginC = {
  name: "plugin-b",
  version: "1.0.0",
  configure(options) {
    console.log("Plugin B configured with:", options);
  },
};

export default pluginC;
