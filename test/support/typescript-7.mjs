// Runs zshy against TypeScript 7.1 without reinstalling `typescript`: loaded with `node --import` ahead of tsx, it
// resolves `typescript` and every `typescript/*` subpath to the `typescript-next` devDependency alias instead, for
// `import` and `require` alike. zshy then picks its engine from that version exactly as it would for a user.
//
// Once the installed `typescript` is itself 7.1 or later (CI installs one), it is left to resolve for real.
import { createRequire, registerHooks } from "node:module";

const installed = createRequire(import.meta.url)("typescript/package.json").version;
const [major, minor] = installed.split(".").map((part) => Number.parseInt(part, 10));

if (major < 7 || (major === 7 && minor < 1)) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "typescript" || specifier.startsWith("typescript/")) {
        return nextResolve(`typescript-next${specifier.slice("typescript".length)}`, context);
      }
      return nextResolve(specifier, context);
    },
  });
}
