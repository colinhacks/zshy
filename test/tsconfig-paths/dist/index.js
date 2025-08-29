import { Calculator } from "@components/calculator";
import { add } from "@utils/math";
import { config } from "@/config";
export { Calculator, add, config };
// Test the imports work
const calc = new Calculator();
console.log(`${config.appName} v${config.version}`);
console.log("2 + 3 =", calc.add(2, 3));
console.log("4 * 5 =", calc.multiply(4, 5));
