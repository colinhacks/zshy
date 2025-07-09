/**
 * Plugin B - Another example plugin for testing
 */
import "./plugin-b.css";
export interface PluginB {
    name: string;
    version: string;
    configure(options: Record<string, any>): void;
}
export declare const pluginB: PluginB;
export default pluginB;
//# sourceMappingURL=b.d.cts.map