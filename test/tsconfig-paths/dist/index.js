import { Calculator } from "./components/calculator.js";
import { add } from "./utils/math.js";
import { config } from "./config.js";
export { Calculator, add, config };
// Test the imports work
const calc = new Calculator();
console.log(`${config.appName} v${config.version}`);
console.log("2 + 3 =", calc.add(2, 3));
console.log("4 * 5 =", calc.multiply(4, 5));
