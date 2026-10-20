import { describe, expect, it } from "vitest";
import { engineKindFor } from "../src/engine.js";

describe("engineKindFor", () => {
  it("builds with the classic compiler API through TypeScript 6", () => {
    for (const version of ["5.7.3", "5.8.3", "6.0.3"]) expect(engineKindFor(version)).toBe("classic");
  });

  it("builds with the TypeScript 7 API from 7.1, prereleases included", () => {
    for (const version of ["7.1.0-dev.20261020.3", "7.1.0-beta", "7.1.0", "7.2.0", "8.0.0"]) {
      expect(engineKindFor(version)).toBe("ts7");
    }
  });

  it("supports no TypeScript 7.0, which shipped the new API only as an unstable preview", () => {
    for (const version of ["7.0.1-rc", "7.0.2"]) expect(engineKindFor(version)).toBeUndefined();
  });
});
