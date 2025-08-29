"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Calculator = void 0;
const math_1 = require("../utils/math.cjs");
const config_1 = require("../config.cjs");
class Calculator {
    constructor() {
        this.name = config_1.config.appName;
    }
    add(a, b) {
        return (0, math_1.add)(a, b);
    }
    multiply(a, b) {
        return (0, math_1.multiply)(a, b);
    }
}
exports.Calculator = Calculator;
