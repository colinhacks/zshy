"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = exports.add = exports.Calculator = void 0;
const calculator_1 = require("@components/calculator");
Object.defineProperty(exports, "Calculator", { enumerable: true, get: function () { return calculator_1.Calculator; } });
const math_1 = require("@utils/math");
Object.defineProperty(exports, "add", { enumerable: true, get: function () { return math_1.add; } });
const config_1 = require("@/config");
Object.defineProperty(exports, "config", { enumerable: true, get: function () { return config_1.config; } });
// Test the imports work
const calc = new calculator_1.Calculator();
console.log(`${config_1.config.appName} v${config_1.config.version}`);
console.log("2 + 3 =", calc.add(2, 3));
console.log("4 * 5 =", calc.multiply(4, 5));
