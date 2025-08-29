/**
 * Plugin B - Another example plugin for testing
 */
import "./plugin-b.css";
export interface PluginC {
    name: string;
    version: string;
    configure(options: Record<string, any>): void;
}
export declare const pluginC: PluginC;
export default pluginC;
//# sourceMappingURL=c.d.mts.map