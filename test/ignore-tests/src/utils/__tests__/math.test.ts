import { add, multiply } from "../math";

// This is a nested test file that should NOT be included in the build output
describe("add", () => {
  it("should add two numbers", () => {
    expect(add(2, 3)).toBe(5);
  });
});

describe("multiply", () => {
  it("should multiply two numbers", () => {
    expect(multiply(3, 4)).toBe(12);
  });
});

