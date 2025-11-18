import { capitalize, reverse } from "./string";

// This is a test file in the same directory as the source file
// A shallow wildcard like "./src/utils/*" would pick this up
describe("capitalize", () => {
  it("should capitalize first letter", () => {
    expect(capitalize("hello")).toBe("Hello");
  });
});

describe("reverse", () => {
  it("should reverse a string", () => {
    expect(reverse("abc")).toBe("cba");
  });
});

