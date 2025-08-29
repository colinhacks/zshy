import { add, multiply } from "../utils/math.js";
import { config } from "../config.js";
export class Calculator {
    constructor() {
        this.name = config.appName;
    }
    add(a, b) {
        return add(a, b);
    }
    multiply(a, b) {
        return multiply(a, b);
    }
}
