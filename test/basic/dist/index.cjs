"use strict";
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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.appConfig = exports.defaultConfig = exports.createConfig = exports.utilsA = void 0;
/**
 * Main entry point for the test library
 */
require("./assets/styles.css");
const config_json_1 = __importDefault(require("./assets/config.json"));
exports.appConfig = config_json_1.default;
const hello_1 = __importDefault(require("./hello.cjs"));
const utilsC = __importStar(require("./utils.cjs"));
const utilsA = __importStar(require("./utils.cjs"));
const utilsB = __importStar(require("./utils.cjs"));
__exportStar(require("./utils.cjs"), exports);
exports.utilsA = __importStar(require("./utils.cjs"));
// code
console.log("🚀 Hello from zshy test fixture!");
// test default export
(0, hello_1.default)();
// test import.meta shims for CJS builds
console.log(require("url").pathToFileURL(__filename));
console.log(__dirname);
console.log(__filename);
utilsA.delay(5);
utilsB.delay(5);
utilsC.delay(5);
const createConfig = (name, version) => {
    return { name, version };
};
exports.createConfig = createConfig;
exports.defaultConfig = {
    name: "test-library",
    version: "1.0.0",
};
// Re-export utilities
__exportStar(require("./utils.cjs"), exports);
//# sourceMappingURL=index.js.map