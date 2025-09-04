<p align="center">

  <h1 align="center">🐒<br/><code>zshy</code></h1>
  <p align="center">The no-bundler build tool for TypeScript libraries. Powered by <code>tsc</code>.
    <br/>
    by <a href="https://x.com/colinhacks">@colinhacks</a>
  </p>
</p>
<br/>

<p align="center">
<a href="https://opensource.org/licenses/MIT" rel="nofollow"><img src="https://img.shields.io/github/license/colinhacks/zshy" alt="License"></a>
<a href="https://www.npmjs.com/package/zshy" rel="nofollow"><img src="https://img.shields.io/npm/dw/zshy.svg" alt="npm"></a>
<a href="https://github.com/colinhacks/zshy" rel="nofollow"><img src="https://img.shields.io/github/stars/colinhacks/zshy" alt="stars"></a>
</p>

<br/>
<br/>
<br/>

<!-- ## What is `zshy`? -->

<h2 align="center">What is <code>zshy</code>?</h2>

`zshy` (zee-shy) is a bundler-free batteries-included build tool for transpiling TypeScript libraries. It was originally created as an internal build tool for [Zod](https://github.com/colinhacks/zod) but is now available as a general-purpose tool for TypeScript libraries.

- 👑 **Powered by `tsc`** — The gold standard for TypeScript transpilation
- 📦 **Bundler-free** — No bundler or bundler configs involved
- 🟦 **No config file** — Reads from your `package.json` and `tsconfig.json`
- 🔗 **No rebuild/watch modes** — Use `--dev` to symlink dist to source for live development
- 📝 **Declarative entrypoint map** — Specify your TypeScript entrypoints in `package.json#/zshy`
- 🤖 **Auto-generated `"exports"`** — Writes `"exports"` map directly into your `package.json`
- 🧱 **Dual-module builds** — Builds ESM and CJS outputs from a single TypeScript source file
- 📂 **Unopinionated** — Use any file structure or import extension syntax you like
- 📦 **Asset handling** — Non-JS assets are copied to the output directory
- ⚛️ **Supports `.tsx`** — Rewrites to `.js/.cjs/.mjs` per your `tsconfig.json#/jsx*` settings
- 🐚 **CLI-friendly** — First-class `"bin"` support
- 🐌 **Blazing fast** — Just kidding, it's slow. But [it's worth it](#is-it-fast)

<!-- - 📱 **Supports React Native** — Supports a [flat build mode](#can-it-support-react-native-legacy-or-non-nodejs-environments) designed for bundlers that don't support `package.json#/exports` -->

<br/>
<br/>
<br/>

<h2 align="center">Quickstart</h2>

<br/>

### 1. Install `zshy` as a dev dependency:

```bash
npm install --save-dev zshy
yarn add --dev zshy
pnpm add --save-dev zshy
```

<br/>

### 2. Specify your entrypoint(s) in `package.json#zshy`:

```diff
{
  "name": "my-pkg",
  "version": "1.0.0",

  // with a single entrypoint
+ "zshy": "./src/index.ts"

  // with multiple entrypoints (subpaths, wildcards, deep wildcards)
+ "zshy": {
+   "main": "./src/index.ts",
+   "module": "./src/index.ts",
+   "exports": {
+     ".": "./src/index.ts",
+     "./utils": "./src/utils.ts",
+     "./plugins/*": "./src/plugins/*",
+     "./components/**/*": "./src/components/**/*"
+   }
+ }
}
```

<br/>

### 3. Run a build

Run a build with `npx zshy`:

```bash
$ npx zshy # use --dry-run to try it out without writing/updating files

→  Starting zshy build 🐒
→  Detected project root: /Users/colinmcd94/Documents/projects/zshy
→  Reading package.json from ./package.json
→  Reading tsconfig from ./tsconfig.json
→  Cleaning up outDir...
→  Determining entrypoints...
   ╔════════════╤════════════════╗
   ║ Subpath    │ Entrypoint     ║
   ╟────────────┼────────────────╢
   ║ "my-pkg"   │ ./src/index.ts ║
   ╚════════════╧════════════════╝
→  Resolved build paths:
   ╔══════════╤════════════════╗
   ║ Location │ Resolved path  ║
   ╟──────────┼────────────────╢
   ║ rootDir  │ ./src          ║
   ║ outDir   │ ./dist         ║
   ╚══════════╧════════════════╝
→  Package is an ES module (package.json#/type is "module")
→  Building CJS... (rewriting .ts -> .cjs/.d.cts)
→  Building ESM...
→  Updating package.json#/exports...
→  Updating package.json#/bin...
→  Build complete! ✅
```

> **Add a `"build"` script to your `package.json`**
>
> ```diff
> {
>   // ...
>   "scripts": {
> +   "build": "zshy"
>   }
> }
> ```
>
> Then, to run a build:
>
> ```bash
> $ npm run build
> ```

<br/>

<br/>

<h2 align="center">How it works</h2>

Vanilla `tsc` does not perform _extension rewriting_; it will only ever transpile a `.ts` file to a `.js` file (never `.cjs` or `.mjs`). This is the fundamental limitation that forces library authors to use bundlers or bundler-powered tools like `tsup`, `tsdown`, or `unbuild`...

...until now! `zshy` works around this limitation using the official [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API), which provides some powerful (and criminally under-utilized) hooks for customizing file extensions during the `tsc` build process.

Using these hooks, `zshy` transpiles each `.ts` file to `.js/.d.ts` (ESM) and `.cjs/.d.cts` (CommonJS):

```bash
$ tree .
├── package.json
├── src
│   └── index.ts
└── dist # generated
  ├── index.js
  ├── index.cjs
  ├── index.d.ts
  └── index.d.cts
```

Similarly, all relative `import`/`export` statements are rewritten to include the appropriate file extension. (Other tools like `tsup` or `tsdown` do the same, but they require a bundler to do so.)

| Original path      | Result (ESM)       | Result (CJS)        |
| ------------------ | ------------------ | ------------------- |
| `from "./util"`    | `from "./util.js"` | `from "./util.cjs"` |
| `from "./util.ts"` | `from "./util.js"` | `from "./util.cjs"` |
| `from "./util.js"` | `from "./util.js"` | `from "./util.cjs"` |

Finally, `zshy` automatically writes `"exports"` into your `package.json`:

```diff
{
  // ...
  "zshy": {
    "exports": "./src/index.ts"
  },
+ "exports": { // auto-generated by zshy
+   ".": {
+     "types": "./dist/index.d.cts",
+     "import": "./dist/index.js",
+     "require": "./dist/index.cjs"
+   }
+ }
}
```

The result is a tool that I consider to be the "holy grail" of TypeScript library build tools:

- performs dual-module (ESM + CJS) builds
- type checks your code
- leverages `tsc` for gold-standard transpilation
- doesn't require a bundler
- doesn't require another config file (just `package.json` and `tsconfig.json`)

<br/>
<br/>

<h2 align="center">Usage</h2>

<br/>

### Flags

```sh
$ npx zshy --help
Usage: zshy [options]

Options:
  -h, --help                        Show this help message
  -p, --project <path>              Path to tsconfig (default: ./tsconfig.json)
      --verbose                     Enable verbose output
      --dev                         Enable development mode (symlink dist to source)
      --dry-run                     Don't write any files or update package.json
      --fail-threshold <threshold>  When to exit with non-zero error code
                                      "error" (default)
                                      "warn"
                                      "never"
```

<br/>

### Subpaths and wildcards

Multi-entrypoint packages can specify subpaths or wildcard exports in `package.json#/zshy/exports`:

```jsonc
{
  "name": "my-pkg",
  "version": "1.0.0",

  "zshy": {
    "exports": {
      ".": "./src/index.ts", // root entrypoint
      "./utils": "./src/utils.ts", // subpath
      "./plugins/*": "./src/plugins/*" // wildcard
    }
  }
}
```

<details>
<summary>View typical build output</summary>

When you run a build, you'll see something like this:

```bash
$ npx zshy

→  Starting zshy build... 🐒
→  Detected project root: /path/to/my-pkg
→  Reading package.json from ./package.json
→  Reading tsconfig from ./tsconfig.json
→  Determining entrypoints...
   ╔════════════════════╤═════════════════════════════╗
   ║ Subpath            │ Entrypoint                  ║
   ╟────────────────────┼─────────────────────────────╢
   ║ "my-pkg"           │ ./src/index.ts              ║
   ║ "my-pkg/utils"     │ ./src/utils.ts              ║
   ║ "my-pkg/plugins/*" │ ./src/plugins/* (5 matches) ║
   ╚════════════════════╧═════════════════════════════╝
→  Resolved build paths:
   ╔══════════╤════════════════╗
   ║ Location │ Resolved path  ║
   ╟──────────┼────────────────╢
   ║ rootDir  │ ./src          ║
   ║ outDir   │ ./dist         ║
   ╚══════════╧════════════════╝
→  Package is ES module (package.json#/type is "module")
→  Building CJS... (rewriting .ts -> .cjs/.d.cts)
→  Building ESM...
→  Updating package.json exports...
→  Build complete! ✅
```

And the generated `"exports"` map will look like this:

```diff
// package.json
{
  // ...
+ "exports": {
+   ".": {
+     "types": "./dist/index.d.cts",
+     "import": "./dist/index.js",
+     "require": "./dist/index.cjs"
+   },
+   "./utils": {
+     "types": "./dist/utils.d.cts",
+     "import": "./dist/utils.js",
+     "require": "./dist/utils.cjs"
+   },
+   "./plugins/*": {
+     "types": "./dist/src/plugins/*",
+     "import": "./dist/src/plugins/*",
+     "require": "./dist/src/plugins/*"
+   }
+ }
}
```

</details>

<br/>

### Building CLIs (`"bin"` support)

If your package is a CLI, specify your CLI entrypoint in `package.json#/zshy/bin`. `zshy` will include this entrypoint in your builds and automatically set `"bin"` in your package.json.

```diff
{
  // package.json
  "name": "my-cli",
  "version": "1.0.0",
  "type": "module",
  "zshy": {
+   "bin": "./src/cli.ts"
  }
}
```

The `"bin"` field is automatically written into your `package.json`:

```diff
{
  // package.json
  "name": "my-cli",
  "version": "1.0.0",
  "zshy": {
    "exports": "./src/index.ts",
    "bin": "./src/cli.ts"
  },
+ "bin": {
+   "my-cli": "./dist/cli.cjs" // CLI entrypoint)
+ }
}
```

> **Note** — The `"bin"` field defaults to the CJS build unless you have disabled it with `"cjs": false`.

<details>
<summary>Multiple CLIs</summary>

For packages that expose multiple CLI tools, `"bin"` can also be an object mappingeach command name to its source file:

```jsonc
{
  // package.json
  "name": "my-cli",
  "version": "1.0.0",
  "type": "module",
  "zshy": {
    "bin": {
      "my-cli": "./src/cli.ts",
      "other": "./src/other.ts"
    }
  }
}
```

This generates a corresponding object `"bin"` field:

```diff
{
  // package.json
  "name": "my-cli",
  "version": "1.0.0",
  "zshy": {
    "exports": "./src/index.ts",
    "bin": {
      "my-cli": "./src/cli.ts",
      "other": "./src/other.ts"
    }
  },
  "bin": {
    "my-cli": "./dist/cli.cjs",
    "other": "./dist/other.cjs"
  }
}
```

</details>

Be sure to include a [shebang](<https://en.wikipedia.org/wiki/Shebang_(Unix)>) as the first line of your CLI entrypoint file:

```ts
#!/usr/bin/env node

// CLI code here
```

<br/>

### ESM-only

For packages that only need ESM builds, you can disable CommonJS output entirely:

```jsonc
{
  "zshy": {
    "exports": { ... },
    "cjs": false
  }
}
```

This will generate only ESM files (`.js` and `.d.ts`) and the `package.json#/exports` will only include `"import"` and `"types"` conditions.

```jsonc
{
  // package.json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

<br/>

### Custom conditions

To specify custom conditions in your export maps, specify a `"conditions"` map. Each condition name must correspond to one of `"src" | "esm" | "cjs"`.

```diff
{
  "zshy": {
    "exports": {
      ".": "./src/index.ts"
    },
+   "conditions": {
+    "my-src-condition": "src"
+    "my-esm-condition": "esm",
+    "my-cjs-condition": "cjs"
+ }
}
```

With this addition, `zshy` will add the `"my-source"` condition to the generated `"exports"` map:

```diff
// package.json
{
  "exports": {
    ".": {
+     "my-src-condition": "./src/index.ts",
+     "my-esm-condition": "./dist/index.js",
+     "my-cjs-condition": "./dist/index.cjs"
      "types": "./dist/index.d.cts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  }
}
```

<br/>
<br/>
<br/>

<h2 align="center">FAQ for nerds</h2>

<br/>

### How does `zshy` resolve entrypoints?

It reads your `package.json#/zshy` config:

```jsonc
// package.json
{
  "name": "my-pkg",
  "version": "1.0.0",
  "zshy": {
    "exports": {
      ".": "./src/index.ts",
      "./utils": "./src/utils.ts",
      "./plugins/*": "./src/plugins/*", // shallow match {.ts,.tsx,.cts,.mts} files
      "./components/*": "./src/components/**/*" // deep match *.{.ts,.tsx,.cts,.mts} files
    }
  }
}
```

A few important notes about `package.json#/zshy/exports`:

- All keys should start with `"./"`
- All values should be relative paths to source files (resolved relative to the `package.json` file)

A few notes on wildcards exports:

- The _key_ should always end in `"/*"`
- The _value_ should correspond to a glob-like path value that ends in either `"/*"` (shallow match) or `"/**/*"` (deep match)
- Do not include a file extensions! `zshy` matches source files with the following extensions:
  - `.ts`, `.tsx`, `.cts`, `.mts`
- A shallow match (`./<dir>/*`) will match both:
  - `./<dir>/*.{ts,tsx,cts,mts}`
  - `./<dir>/*/index.{ts,tsx,cts,mts}`.
- A deep match (`./<dir>/**/*`) will match all files recursively in the specified directory, including subdirectories:
  - `./<dir>/**/*.{ts,tsx,cts,mts}`
  - `./<dir>/**/*/index.{ts,tsx,cts,mts}`

**Note** — Since `zshy` computes an exact set of resolved entrypoints, your `"files"`, `"include"`, and `"exclude"` settings in `tsconfig.json` are ignored during the build.

<br/>

### Does `zshy` respect my `tsconfig.json` compiler options?

Yes! With some strategic overrides:

- **`module`**: Overridden (`"commonjs"` for CJS build, `"esnext"` for ESM build)
- **`moduleResolution`**: Overridden (`"node10"` for CJS, `"bundler"` for ESM)
- **`declaration`/`noEmit`/`emitDeclarationOnly`**: Overridden to ensure proper output
- **`verbatimModuleSyntax`**: Set to `false` to allow multiple build formats
- **`esModuleInterop`**: Set to `true` (it's a best practice)
- **`composite`**: Set to `false` to avoid resolution issues. `zshy` will build all files that are reachable from your specified entrypoints.

All other options are respected as defined, though `zshy` will also set the following reasonable defaults if they are not explicitly set:

- `outDir` (defaults to `./dist`)
- `declarationDir` (defaults to `outDir` — you probably shouldn't set this explicitly)
- `target` (defaults to `es2020`)

<br/>

### Do I need to use a specific file structure?

No. You can organize your source however you like; `zshy` will transpile your entrypoints and all the files they import, respecting your `tsconfig.json` settings.

> **Comparison to `tshy`** — `tshy` requires you to put your source in a `./src` directory, and always builds to `./dist/esm` and `./dist/cjs`.

<br/>

### What files does `zshy` create?

It depends on your `package.json#/type` field. If your package is ESM (that is, `"type": "module"` in `package.json`):

- `.js` + `.d.ts` (ESM)
- `.cjs` + `.d.cts` (CJS)

```bash
$ tree dist

.
├── package.json # if type == "module"
├── src
│   └── index.ts
└── dist
    ├── index.js
    ├── index.d.ts
    ├── index.cjs
    └── index.d.cts
```

Otherwise, the package is considered _default-CJS_ and the ESM build files will be rewritten as `.mjs`/`.d.mts`.

- `.mjs` + `.d.mts` (ESM)
- `.js` + `.d.ts` (CJS)

```bash
$ tree dist
.
├── package.json # if type != "module"
├── src
│   └── index.ts
└── dist
    ├── index.js
    ├── index.d.ts
    ├── index.mjs
    └── index.d.mts
```

> **Comparison to `tshy`** — `tshy` generates plain `.js`/`.d.ts` files into separate `dist/esm` and `dist/cjs` directories, each with a stub `package.json` to enable proper module resolution in Node.js. This is more convoluted than the flat file structure generated by `zshy`. It also causes issues with [Module Federation](https://github.com/colinhacks/zod/issues/4656).

<br/>

### How does extension rewriting work?

`zshy` uses the [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) to rewrite file extensions during the `tsc` emit step.

- If `"type": "module"`
  - `.ts` becomes `.js`/`.d.ts` (ESM) and `.cjs`/`.d.cts` (CJS)
- Otherwise:
  - `.ts` becomes `.mjs`/`.d.mts` (ESM) and `.js`/`.d.ts` (CJS)

Similarly, all relative `import`/`export` statements are rewritten to account for the new file extensions.

| Original path      | Result (ESM)       | Result (CJS)        |
| ------------------ | ------------------ | ------------------- |
| `from "./util"`    | `from "./util.js"` | `from "./util.cjs"` |
| `from "./util.ts"` | `from "./util.js"` | `from "./util.cjs"` |
| `from "./util.js"` | `from "./util.js"` | `from "./util.cjs"` |

TypeScript's Compiler API provides dedicated hooks for performing such transforms (though they are criminally under-utilized).

- **`ts.TransformerFactory`**: Provides AST transformations to rewrite import/export extensions before module conversion
- **`ts.CompilerHost#writeFile`**: Handles output file extension changes (`.js` → `.cjs`/`.mjs`)

> **Comparison to `tshy`** — `tshy` was designed to enable dual-package builds powered by the `tsc` compiler. To make this work, it relies on a specific file structure and the creation of temporary `package.json` files to accommodate the various idiosyncrasies of Node.js module resolution. It also requires the use of separate `dist/esm` and `dist/cjs` build subdirectories.

<br/>

### Can I use extension-less imports?

Yes! `zshy` supports whatever import style you prefer:

- `from "./utils"`: classic extensionless imports
- `from "./utils.js"`: ESM-friendly extensioned imports
- `from "./util.ts"`: recently supported natively via[`rewriteRelativeImportExtensions`](https://www.typescriptlang.org/tsconfig/#rewriteRelativeImportExtensions)

Use whatever you like; `zshy` will rewrite all imports/exports properly during the build process.

> **Comparison to `tshy`** — `tshy` forces you to use `.js` imports throughout your codebase. While this is generally a good practice, it's not always feasible, and there are hundreds of thousands of existing TypeScript codebases reliant on extensionless imports.

<br/>

### What about `package.json#/exports`?

Your exports map is automatically written into your `package.json` when you run `zshy`. The generated exports map looks like this:

```diff
{
  "zshy": {
    "exports": {
      ".": "./src/index.ts",
      "./utils": "./src/utils.ts",
      "./plugins/*": "./src/plugins/*"
    }
  },
+ "exports": { // auto-generated by zshy
+   ".": {
+     "types": "./dist/index.d.cts",
+     "import": "./dist/index.js",
+     "require": "./dist/index.cjs"
+   },
+   "./utils": {
+     "types": "./dist/utils.d.cts",
+     "import": "./dist/utils.js",
+     "require": "./dist/utils.cjs"
+   },
+   "./plugins/*": {
+     "import": "./dist/src/plugins/*",
+     "require": "./dist/src/plugins/*"
+   }
+ }
}
```

<br/>

### Why `.d.cts` for `"types"`?

The `"types"` field always points to the CJS declaration file (`.d.cts`). This is an intentional design choice. **It solves the "Masquerading as ESM" issue**. You've likely seen this dreaded error before:

```ts
import mod from "pkg";         ^^^^^
//              ^ The current file is a CommonJS module whose imports will produce 'require' calls; however, the referenced file is an ECMAScript module and cannot be imported with 'require'. Consider writing a dynamic 'import("pkg")' call instead.
```

Simply put, an ESM file can `import` CommonJS, but CommonJS files can't `require` ESM. By having `"types"` point to the `.d.cts` declarations, we can always avoid the error above. Technically we're tricking TypeScript into thinking our code is CommonJS; in practice, this has no real consequences and maximizes compatibility.

To learn more, read the ["Masquerading as ESM"](https://github.com/arethetypeswrong/arethetypeswrong.github.io/blob/main/docs/problems/FalseESM.md) writeup from ATTW.

> **Comparison to `tshy`** — `tshy` generates independent (but identical) `.d.ts` files in `dist/esm` and `dist/cjs`. This can cause [Excessively Deep](https://github.com/colinhacks/zod/issues/4422) errors if users of the library use declaration merging (`declare module {}`) for plugins/extensions. [Zod](https://github.com/colinhacks/zod), [day.js](https://day.js.org/), and others rely on this pattern for plugins.

<br/>

### Why do I see "Masquerading as CJS"?

This is expected behavior when running the "Are The Types Wrong" tool. This warning does not cause any resolution issues (unlike "Masquerading as ESM"). Technically, we're tricking TypeScript into thinking our code is CommonJS; when in fact it may be ESM. The ATTW tool is very rigorous and flags this; in practice, this has no real consequences and maximizes compatibility (Zod has relied on the CJS masquerading trick since it's earliest days.)

To learn more, read the ["Masquerading as CJS"](https://github.com/arethetypeswrong/arethetypeswrong.github.io/blob/main/docs/problems/FalseCJS.md) writeup from ATTW.

<br/>

### How are default exports transpiled?

**CJS interop transform** — When a file contains a single `export default ...` and _no named exports_...

```ts
function hello() {
  console.log('hello');
}

export default hello;
```

...the built `.cjs` code will assign the exported value directly to `module.exports`:

```ts
function hello() {
  console.log('hello');
}
exports.default = hello;
module.exports = exports.default;
```

...and the associated `.d.cts` files will use `export =` syntax:

```ts
declare function hello(): void;
export = hello;
```

The ESM build is not impacted by this transform.

**ESM interop transform** — Similarly, if a source `.ts` file contains the following syntax:

```ts
export = ...
```

...the generated _ESM_ build will transpile to the following syntax:

```ts
export default ...
```

<br/>

### Can it support React Native or non-Node.js environments?

Yes! This is one of the key reasons `zshy` was originally developed. Many environments don't support `package.json#/exports` yet:

- Node.js v12.7 or earlier
- React Native - The Metro bundler does not support `"exports"` by default
- TypeScript projects with legacy configs — e.g. `"module": "commonjs"`

This causes issues for packages that want to use subpath imports to structure their package. Fortunately `zshy` unlocks a workaround I call a _flat build_:

1. Remove `"type": "module"` from your `package.json` (if present)
2. Set `outDir: "."` in your `tsconfig.json`
3. Configure `"exclude"` in `package.json` to exclude all source files:

   ```jsonc
   {
     // ...
     "exclude": ["**/*.ts", "**/*.tsx", "**/*.cts", "**/*.mts", "node_modules"]
   }
   ```

With this setup, your build outputs (`index.js`, etc) will be written to the package root. Older environments will resolve imports like `"your-library/utils"` to `"your-library/utils/index.js"`, effectively simulating subpath imports in environments that don't support them.

<br />

### Can I prevent `zshy` from modifying my `package.json`?

Yes. If you prefer to manage your `package.json` fields manually, you can prevent `zshy` from making any changes by setting the `noEdit` option to `true` in your `package.json#/zshy` config.

```jsonc
{
  "zshy": {
    "exports": "./src/index.ts",
    "noEdit": true
  }
}
```

When `noEdit` is enabled, `zshy` will build your files but will not write to `package.json`. You will be responsible for populating the `"exports"`, `"bin"`, `"main"`, `"module"`, and `"types"` fields yourself.

<br />

### Is it fast?

Not really. It uses `tsc` to typecheck your codebase, which is a lot slower than using a bundler that strips types. That said:

1. You _should_ be type checking your code during builds
2. TypeScript is [about to get 10x faster](https://devblogs.microsoft.com/typescript/typescript-native-port/)

<br/>
<br/>

<h2 align="center">Acknowledgements</h2>

The DX of `zshy` was heavily inspired by [tshy](https://github.com/isaacs/tshy) by [@isaacs](https://x.com/izs), particularly its declarative entrypoint map and auto-updating of `package.json#/exports`. It proved that there's a modern way to transpile libraries using pure `tsc` (and various `package.json` hacks). Unfortunately its approach necessarily involved certain constraints that made it unworkable for Zod (described in the FAQ in more detail). `zshy` borrows elements of `tshy`'s DX while using the Compiler API to relax these constraints and provide a more "batteries included" experience.
