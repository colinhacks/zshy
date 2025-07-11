/**
 * Plugin A - Example plugin for testing
 */
export interface PluginD {
  name: string;
  version: string;
  execute(): void;
}

export const pluginD: PluginD = {
  name: "plugin-d",
  version: "1.0.0",
  execute() {
    console.log("Plugin D executed");
  },
};

export default pluginD;
