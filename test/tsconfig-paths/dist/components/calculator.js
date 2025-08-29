import { add, multiply } from "@utils/math";
import { config } from "@/config";
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
