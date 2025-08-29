import { add, multiply } from "@utils/math";
import { config } from "@/config";

export class Calculator {
  name: string;

  constructor() {
    this.name = config.appName;
  }

  add(a: number, b: number): number {
    return add(a, b);
  }

  multiply(a: number, b: number): number {
    return multiply(a, b);
  }
}
