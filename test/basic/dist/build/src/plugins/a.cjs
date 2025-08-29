"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pluginA = void 0;
/**
 * Plugin A - Example plugin for testing
 */
require("./plugin-a.css");
exports.pluginA = {
    name: "plugin-a",
    version: "1.0.0",
    execute() {
        console.log("Plugin A executed");
    },
};
exports.default = exports.pluginA;
//# sourceMappingURL=a.js.map