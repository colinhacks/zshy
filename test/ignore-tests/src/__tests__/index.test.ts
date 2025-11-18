import { greet, version } from "../index";

// This is a test file that should NOT be included in the build output
describe("greet", () => {
  it("should greet with name", () => {
    expect(greet("World")).toBe("Hello, World!");
  });
});

describe("version", () => {
  it("should export version", () => {
    expect(version).toBe("1.0.0");
  });
});

