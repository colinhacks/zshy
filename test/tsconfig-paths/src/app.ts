// Test non-at-sign aliases

import { config } from "$config";
import { Calculator } from "components/calculator";
import { isValidEmail, isValidPhone } from "lib/validator";
import { add } from "utils/math";
import { capitalize, formatDate } from "#helpers";
import { Calculator as CalcFromTilde } from "~/components/calculator";

export function runApp() {
  console.log("Testing non-at-sign aliases:");

  // Test bare path imports
  console.log("utils/math - add(5, 3):", add(5, 3));

  // Test components import
  const calc = new Calculator();
  console.log("components/calculator - multiply(4, 6):", calc.multiply(4, 6));

  // Test lib import
  console.log("lib/validator - isValidEmail('test@example.com'):", isValidEmail("test@example.com"));
  console.log("lib/validator - isValidPhone('+1234567890'):", isValidPhone("+1234567890"));

  // Test # alias
  console.log("#helpers - formatDate(new Date('2024-01-15')):", formatDate(new Date("2024-01-15")));
  console.log("#helpers - capitalize('hello'):", capitalize("hello"));

  // Test $ alias
  console.log("$config:", config);

  // Test ~ alias (baseUrl)
  const calcFromTilde = new CalcFromTilde();
  console.log("~/components/calculator - add(10, 20):", calcFromTilde.add(10, 20));
}

runApp();
