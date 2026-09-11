// The return type is inferred, which isolatedDeclarations rejects (TS9007).
// Only the declaration emitter reports it, so a build that collects semantic
// diagnostics alone passes this file and ships JavaScript with no types.
export function inferred(a: number) {
  return a + 1;
}
