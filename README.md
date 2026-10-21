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
- 📝 **Declarative entrypoint map** — Specify your TypeScript entrypoints in `package.json#/zshy`
- 🤖 **Auto-generated `"exports"`** — Writes `"exports"` map directly into your `package.json` and `jsr.json`
- 🧱 **ES modules** — Builds standard ESM, which `import` and (on Node.js 20.19+ and 22.12+) `require` can both load
- 📂 **Unopinionated** — Use any file structure or import extension syntax you like
- 📦 **Asset handling** — Non-JS assets are copied to the output directory
- ⚛️ **Supports `.tsx`** — Compiles to `.js` per your `tsconfig.json#/jsx*` settings
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

`zshy` builds with your project's own `typescript`, which must be 7.1 or later. While 7.1 is in beta, install it as `typescript@beta`. `zshy` builds ES modules only, so your package needs `"type": "module"`. To build with TypeScript 5 or 6, or to publish CommonJS, use `zshy@0.8`.

<br/>

### 2. Specify your entrypoint(s) in `package.json#zshy`:

Single entrypoint:

```diff
// package.json
{
  "name": "my-pkg",
  "version": "1.0.0",
  "type": "module",
+ "zshy": "./src/index.ts"
}
```

Multiple entrypoints:

```diff
// package.json
{
  "name": "my-pkg",
  "version": "1.0.0",
  "type": "module",

+ "zshy": {
+   "exports": {
+     ".": "./src/index.ts",
+     "./utils": "./src/utils.ts",
+     "./plugins/*": "./src/plugins/*",               // wildcard
+     "./components/**/*": "./src/components/**/*"    // deep wildcard
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
→  Building...
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

Node.js loads an ES module's relative imports by exact path, so `from "./util"` has to reach your users as `from "./util.js"`. Vanilla `tsc` won't write that for you: under `"moduleResolution": "bundler"` it emits the specifier exactly as you wrote it, and under `"nodenext"` it makes you write `.js` throughout your source. This is the limitation that pushes library authors toward bundlers or bundler-powered tools like `tsup`, `tsdown`, or `unbuild`...

...until now! `zshy` builds with `tsc` through TypeScript's compiler API, then rewrites every relative import in the emitted output to the file it names:

| Original path                                 | Result                     |
| --------------------------------------------- | -------------------------- |
| `from "./util"`                               | `from "./util.js"`         |
| `from "./util.ts"`                            | `from "./util.js"`         |
| `from "./util.js"`                            | `from "./util.js"`         |
| `from "./utils"` (a directory with `index.ts`) | `from "./utils/index.js"` |

Each `.ts` file becomes a `.js` file and its `.d.ts` declarations:

```bash
$ tree .
├── package.json
├── src
│   └── index.ts
└── dist # generated
  ├── index.js
  └── index.d.ts
```

Finally, `zshy` automatically writes `"exports"` into your `package.json`:

```diff
{
  // ...
  "zshy": {
    "exports": "./src/index.ts"
  },
+ "exports": { // auto-generated by zshy
+   ".": {
+     "types": "./dist/index.d.ts",
+     "default": "./dist/index.js"
+   }
+ }
}
```

The result is a tool that I consider to be the "holy grail" of TypeScript library build tools:

- emits standard ES modules whose imports Node.js can resolve as written
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
      "./plugins/*": "./src/plugins/*", // wildcard
      "./components/*": "./src/components/**/*" // deep wildcard
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
→  Building...
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
+     "types": "./dist/index.d.ts",
+     "default": "./dist/index.js"
+   },
+   "./utils": {
+     "types": "./dist/utils.d.ts",
+     "default": "./dist/utils.js"
+   },
+   "./plugins/*": {
+     "types": "./dist/src/plugins/*",
+     "default": "./dist/src/plugins/*"
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
+   "my-cli": "./dist/cli.js" // CLI entrypoint
+ }
}
```

<details>
<summary>Multiple CLIs</summary>

For packages that expose multiple CLI tools, `"bin"` can also be an object mapping each command name to its source file:

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
    "my-cli": "./dist/cli.js",
    "other": "./dist/other.js"
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

### CommonJS

`zshy` builds ES modules only. Node.js 20.19+ and 22.12+ can `require()` an ES module, so CommonJS code can still load your package, unless it uses top-level `await`.

To publish CommonJS output, use `zshy@0.8`, which builds ESM and CommonJS side by side (with TypeScript 5 or 6). Coming from it:

- `"cjs": false` is still accepted, and changes nothing.
- `"cjs": true`, `"sealCjsExports"`, and conditions set to `"cjs"` are errors.
- `zshy` points `"main"` at the ESM entrypoint, replacing the `.cjs` path a 0.8 build wrote there.

<br/>

### Custom conditions

To specify custom conditions in your export maps, specify a `"conditions"` map. Each condition name must correspond to one of `"src" | "esm"`.

```diff
{
  "zshy": {
    "exports": {
      ".": "./src/index.ts"
    },
+   "conditions": {
+     "my-src-condition": "src",
+     "my-esm-condition": "esm"
+   }
  }
}
```

With this addition, `zshy` will add both conditions to the generated `"exports"` map:

```diff
// package.json
{
  "exports": {
    ".": {
+     "my-src-condition": "./src/index.ts",
+     "my-esm-condition": "./dist/index.js",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  }
}
```

<br/>

### JSR

For packages that also have a `jsr.json` file for publishing to [JSR](https://jsr.io/), `zshy` will copy your configured exports to `jsr.json/#exports`, making your `zshy` configuration the single source of truth for exports.

This will copy over the paths of the source code entrypoints, not the paths to the transpiled code, since JSR supports and encourages publishing TypeScript source code rather than pairs of `.js` + `.d.ts` files.

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

- **`module`**: Overridden to `"esnext"`
- **`moduleResolution`**: Overridden to `"bundler"`, so extensionless imports type-check (`zshy` then adds the extension)
- **`declaration`/`noEmit`/`emitDeclarationOnly`**: Overridden to ensure proper output
- **`verbatimModuleSyntax`**: Set to `false`, so a type-only import written without `import type` is still erased
- **`esModuleInterop`**: Set to `true` (it's a best practice)
- **`composite`**: Set to `false` to avoid resolution issues. `zshy` will build all files that are reachable from your specified entrypoints.

All other options are respected as defined, though `zshy` will also set the following reasonable defaults if they are not explicitly set:

- `outDir` (defaults to `./dist`)
- `declarationDir` (defaults to `outDir` — you probably shouldn't set this explicitly)
- `target` (defaults to `es2020`)

<br/>

### Which versions of TypeScript does `zshy` support?

TypeScript 7.1 and later. `zshy` builds with the `typescript` your project has installed, through the API of TypeScript's native compiler, and 7.1 is the first release where that API is stable. While 7.1 is in beta, install it as `typescript@beta`.

To build with TypeScript 5 or 6, use `zshy@0.8`, the last release built on the classic [Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API).

Coming from `zshy@0.8`, the ESM output should be unchanged (CommonJS output is gone: see [CommonJS](#commonjs)). A few declarations come out of TypeScript 7 in a different but equivalent shape, and source maps differ in detail. TypeScript 7 also keeps the defaults TypeScript 6 changed, and `zshy` checks your code with them. Two that commonly surface:

- `types` now defaults to `[]`, so Node.js globals like `console` and `process` need `"types": ["node"]`.
- Side-effect imports are checked, so `import "./styles.css"` reports TS2882 unless you set `"noUncheckedSideEffectImports": false`. `zshy` still copies the asset.

TypeScript 7 also removes `baseUrl`: spell `paths` targets relative to the tsconfig instead, e.g. `"./src/*"`.

<br/>

### Do I need to use a specific file structure?

No. You can organize your source however you like; `zshy` will transpile your entrypoints and all the files they import, respecting your `tsconfig.json` settings.

> **Comparison to `tshy`** — `tshy` requires you to put your source in a `./src` directory, and always builds to `./dist/esm` and `./dist/cjs`.

<br/>

### What files does `zshy` create?

A `.js` file and its `.d.ts` declarations for each `.ts` or `.tsx` source, plus source maps if your `tsconfig.json` asks for them:

```bash
$ tree .
├── package.json
├── src
│   └── index.ts
└── dist
    ├── index.js
    └── index.d.ts
```

A `.mts` source becomes `.mjs`/`.d.mts`, and a `.cts` source becomes `.cjs`/`.d.cts`: TypeScript's own output for those extensions, which `zshy` leaves as it is.

> **Comparison to `tshy`** — `tshy` generates plain `.js`/`.d.ts` files into separate `dist/esm` and `dist/cjs` directories, each with a stub `package.json` to enable proper module resolution in Node.js. This is more convoluted than the flat file structure generated by `zshy`. It also causes issues with [Module Federation](https://github.com/colinhacks/zod/issues/4656).

<br/>

### How does import rewriting work?

`zshy` rewrites relative `import`/`export` specifiers in the JavaScript and declarations that `tsc` emits, so each one names a real file:

| Original path                                 | Result                     |
| --------------------------------------------- | -------------------------- |
| `from "./util"`                               | `from "./util.js"`         |
| `from "./util.ts"`                            | `from "./util.js"`         |
| `from "./util.js"`                            | `from "./util.js"`         |
| `from "./utils"` (a directory with `index.ts`) | `from "./utils/index.js"` |

The TypeScript 7 API has no transformer hook, so `zshy` works on what `tsc` emits: each relative specifier is found by its position in the parsed output and rewritten there. A string that merely looks like a path is never touched.

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
+     "types": "./dist/index.d.ts",
+     "default": "./dist/index.js"
+   },
+   "./utils": {
+     "types": "./dist/utils.d.ts",
+     "default": "./dist/utils.js"
+   },
+   "./plugins/*": {
+     "types": "./dist/src/plugins/*",
+     "default": "./dist/src/plugins/*"
+   }
+ }
}
```

<br/>

### Can it support React Native or non-Node.js environments?

Yes! This is one of the key reasons `zshy` was originally developed. Some environments ignore `package.json#/exports` — the React Native Metro bundler does by default — which causes issues for packages that want to use subpath imports to structure their package. Fortunately `zshy` unlocks a workaround I call a _flat build_:

1. Set `outDir: "."` in your `tsconfig.json`
2. Keep your TypeScript sources out of the published package. If `package.json` has no `"files"`, `zshy` sets it to the built extensions for you:

   ```jsonc
   {
     // ...
     "files": ["**/*.js", "**/*.mjs", "**/*.cjs", "**/*.d.ts", "**/*.d.mts", "**/*.d.cts"]
   }
   ```

With this setup, your build outputs (`index.js`, etc) will be written to the package root. Older environments will resolve imports like `"your-library/utils"` to `"your-library/utils/index.js"`, effectively simulating subpath imports in environments that don't support them.

<br />

### Can I prevent `zshy` from modifying my `package.json`/`jsr.json`?

Yes. If you prefer to manage your export fields manually, you can prevent `zshy` from making any changes by setting the `noEdit` option to `true` in your `package.json#/zshy` config.

```jsonc
{
  "zshy": {
    "exports": "./src/index.ts",
    "noEdit": true
  }
}
```

When `noEdit` is enabled, `zshy` will build your files but will not write to `package.json` or `jsr.json`. You will be responsible for populating the `"exports"`, `"bin"`, `"main"`, `"module"`, and `"types"` fields yourself.

<br />

### Is it fast?

Not really. It uses `tsc` to typecheck your codebase, which is a lot slower than using a bundler that strips types. That said:

1. You _should_ be type checking your code during builds
2. `zshy` builds on TypeScript 7, the [10x faster native port](https://devblogs.microsoft.com/typescript/typescript-native-port/)

<br/>
<br/>

<h2 align="center">Acknowledgements</h2>

The DX of `zshy` was heavily inspired by [tshy](https://github.com/isaacs/tshy) by [@isaacs](https://x.com/izs), particularly its declarative entrypoint map and auto-updating of `package.json#/exports`. It proved that there's a modern way to transpile libraries using pure `tsc` (and various `package.json` hacks). Unfortunately its approach necessarily involved certain constraints that made it unworkable for Zod (described in the FAQ in more detail). `zshy` borrows elements of `tshy`'s DX while using the Compiler API to relax these constraints and provide a more "batteries included" experience.
