"use strict";
/**
 * Utility functions for the test library
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConsoleLogger = exports.delay = exports.isProduction = exports.formatMessage = exports.loadDocumentation = void 0;
// triple slash for module.d.ts
/// <reference path="./module.d.ts" />
// Test dynamic import of assets
const loadDocumentation = async () => {
    const readme = await Promise.resolve().then(() => __importStar(require("./assets/README.md")));
    return readme.default || "Documentation not found";
};
exports.loadDocumentation = loadDocumentation;
const formatMessage = (message) => {
    return `[LOG] ${message}`;
};
exports.formatMessage = formatMessage;
const isProduction = () => {
    // biome-ignore lint: ts
    return process.env["NODE_ENV"] === "production";
};
exports.isProduction = isProduction;
const delay = (ms) => {
    return new Promise((resolve) => setTimeout(resolve, ms));
};
exports.delay = delay;
class ConsoleLogger {
    log(message) {
        console.log((0, exports.formatMessage)(message));
    }
    error(message) {
        console.error((0, exports.formatMessage)(`ERROR: ${message}`));
    }
}
exports.ConsoleLogger = ConsoleLogger;
//# sourceMappingURL=utils.js.map