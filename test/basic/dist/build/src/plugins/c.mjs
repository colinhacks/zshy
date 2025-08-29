/**
 * Plugin B - Another example plugin for testing
 */
import "./plugin-b.css";
export const pluginC = {
    name: "plugin-b",
    version: "1.0.0",
    configure(options) {
        console.log("Plugin B configured with:", options);
    },
};
export default pluginC;
//# sourceMappingURL=c.mjs.map