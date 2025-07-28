/**
 * Plugin A - Example plugin for testing
 */
import "./plugin-a.css";

export interface PluginA {
  name: string;
  version: string;
  execute(): void;
}

export const pluginA: PluginA = {
  name: "plugin-a",
  version: "1.0.0",
  execute() {
    console.log("Plugin A executed");
  },
};

export default pluginA;
