import { Button } from "./button";

// This is a test file in the same directory as the source file
// A shallow wildcard like "./src/components/*" would pick this up
describe("Button", () => {
  it("should create a button", () => {
    const result = Button({ label: "Click me", onClick: () => {} });
    expect(result).toBe("Button(Click me)");
  });
});

