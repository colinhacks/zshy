/**
 * Plugin B - Another example plugin for testing
 */

export interface PluginB {
  name: string;
  version: string;
  configure(options: Record<string, any>): void;
}

export const pluginB: PluginB = {
  name: 'plugin-b',
  version: '1.0.0',
  configure(options) {
    console.log('Plugin B configured with:', options);
  }
};

export default pluginB;
