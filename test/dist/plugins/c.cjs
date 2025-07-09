"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pluginB = void 0;
/**
 * Plugin B - Another example plugin for testing
 */
require("./plugin-b.css");
exports.pluginB = {
    name: "plugin-b",
    version: "1.0.0",
    configure(options) {
        console.log("Plugin B configured with:", options);
    },
};
exports.default = exports.pluginB;
//# sourceMappingURL=c.cjs.map