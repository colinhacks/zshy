
<p align="center">

  <h1 align="center">🐒<br/><code>zshy</code></h1>
  <p align="center">TypeScript-first dual package builder. Zero config, maximum compatibility.
    <br/>
    by <a href="https://x.com/colinhacks">@colinhacks</a>
  </p>
</p>
<br/>

<p align="center">
<a href="https://github.com/colinhacks/zshy/actions?query=branch%3Amain"><img src="https://github.com/colinhacks/zshy/actions/workflows/test.yml/badge.svg?event=push&branch=main" alt="zshy CI status" /></a>
<a href="https://opensource.org/licenses/MIT" rel="nofollow"><img src="https://img.shields.io/github/license/colinhacks/zshy" alt="License"></a>
<a href="https://www.npmjs.com/package/zshy" rel="nofollow"><img src="https://img.shields.io/npm/dw/zshy.svg" alt="npm"></a>
<a href="https://github.com/colinhacks/zshy" rel="nofollow"><img src="https://img.shields.io/github/stars/colinhacks/zshy" alt="stars"></a>
</p>

<div align="center">
  <a href="https://github.com/colinhacks/zshy">GitHub</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="https://twitter.com/colinhacks">𝕏</a>
  <span>&nbsp;&nbsp;•&nbsp;&nbsp;</span>
  <a href="https://bsky.app/profile/colinhacks.com">Bluesky</a>
  <br />
</div>

<br/>
<br/>

## What is `zshy`?

`zshy` is a simple-but-powerful build tool for compiling TypeScript libraries. It was originally created as internal build tool for [Zod](https://github.com/colinhacks/zod) but is now available as a general-purpose tool.

- **Supports ESM/CJS** — Builds ESM and CJS code from a single TypeScript source file.

- **Bundler-free** — No Rust, no bundlers, no extra configs, just good old-fashioned `tsc`.

- **Declarative config** — No build scripts, just a simple `"zshy"` field in your `package.json`.
  ```jsonc
  // package.json
  {
    "name": "my-pkg",
    "version": "1.0.0",
    "zshy": { // config lives inside package.json
      "exports": {
        ".": "./src/index.ts",
        "./utils": "./src/utils.ts",
        "./types": "./src/types.ts"
      }
    }
  }
  ```  
- **Auto-generated `package.json#exports`** — Generates the appropriate `exports` map and writes it directly into your `package.json`.

- **Supports `.tsx`** — JSX syntax will be transformed according to your `tsconfig.json` settings.

- **Blazing fast** — Just kidding, it's slow. Typechecking with `tsc` is a lot slower than using a bundler that strips types. Buuut—
  1. you *should* be type checking your code during builds
  2. TypeScript is [about to get 10x faster](https://devblogs.microsoft.com/typescript/typescript-native-port/) and 
  3. you just spent the last hour staring at a Cursor spinner anyway.

## Usage

### 1️⃣ Install `zshy` as a dev dependency:

```bash
npm install --save-dev zshy
```

### 2️⃣ Add the `"zshy"` field to your `package.json`

```jsonc
{
  "name": "my-pkg",
  "version": "1.0.0",

  // Example 1: a single entrypoint
  "zshy": "./src/index.ts",

  // Example 2: multiple subpaths
  "zshy": {
    "exports": {
      ".": "./src/index.ts",
      "./utils": "./src/utils.ts",
      "./types": "./src/types.ts"
    }
  },

  // Example 3: wildcard exports
  "zshy": {
    ".": "./src/index.ts",
    "./plugins/*": "./src/plugins/*" // do *not* include extension!
  }
}
```

### 3️⃣ Run a build

```bash
$ npx zshy

💎 Starting zshy build...
⚙️ Detected project root: /path/to/my-pkg
📦 Reading package.json from ./package.json
📁 Reading tsconfig from ./tsconfig.json
➡️ Determining entrypoints...
   ╔══════════════════╤═════════════════════════╗
   ║ Subpath          │ Entrypoint              ║
   ╟──────────────────┼─────────────────────────╢
   ║ "zshy"           │ ./src/index.ts              ║
   ╟──────────────────┼─────────────────────────╢
   ║ "zshy/utils"     │ ./src/utils.ts              ║
   ╟──────────────────┼─────────────────────────╢
   ║ "zshy/plugins/*" │ ./src/plugins/* (2 matches) ║
   ╚══════════════════╧═════════════════════════╝
📂 Transpiling from ./src (rootDir) to ./dist (outDir)
🟨 Package is ES module (package.json#type is "module")
🧱 Building CJS... (rewriting .ts -> .cjs/.d.cts)
🧱 Building ESM...
📦 Updating package.json exports...
   {
     ".": {
       "types": "./dist/index.d.cts",
       "import": "./dist/index.js",
       "require": "./dist/index.cjs"
     }
   }
🎉 Build complete!
```


Alernatively, create a `package.json` `build` script.

```diff
{
  // ...
  "scripts": {
+   "build": "zshy"
  }
}
```

The to run a build:

```bash
$ npm run build
```


## Build details (for nerds only)

This section walks through the build process used by `zshy` step-by-step, explaining some of its design decisions along the way.

### Step 1: Resolve entry points

First, `zshy` reads your `package.json#zshy` config to determine your source entrypoints. 


```jsonc
// package.json
{
  "name": "my-pkg",
  "version": "1.0.0",
  "zshy": {
    "exports": {
      ".": "./src/index.ts",
      "./utils": "./src/utils.ts",
      "./plugins/*": "./src/plugins/*" // matches all .ts/.tsx files in ./src/plugins
    }
  }
}
```

### Determine `rootDir`

Unless otherwise specified in your `tsconfig.json`, the `rootDir` is automatically determined from the common ancestor directory of all entry points. In the example above, the `rootDir` is `./src`.


### Determine `outDir`

`zshy` respects the `outDir` setting in your `tsconfig.json#compilerOptions`. It defaults to `./dist`.


### Resolve `tsconfig.json` compiler options

`zshy` uses your existing `tsconfig.json` when building, with some strategic overrides:

- **`module`**: Set to `"commonjs"` for CJS build, `"esnext"` for ESM build
- **`moduleResolution`**: Set to `"node10"` for CJS, `"bundler"` for ESM  
- **`moduleDetection`**: Set to `"auto"` 
- **`declaration`/`noEmit`/`emitDeclarationOnly`**: Overwritten to ensure proper output
- **`verbatimModuleSyntax`**: Set to `false` to allow for multiple build formats



### Step 3: Check `package.json#type`

Before compiling, `zshy` reads the value of `package.json#type`. 

- If you have `"type": "module"` in `package.json` (recommended) then your package is *default-ESM*. In this case, `zshy` will produce
  - `.js`/`.d.ts` in ESM format
  - `.cjs`/`.d.cts` in CJS format
- If you do not have `"type": "module"` (or it is set to `"commonjs"`), then your package is *default-CJS*. In this case, `zshy` will produce
  - `.mjs`/`.d.mts` in ESM format
  - `.js`/`.d.ts` in CJS format

> Remember: the `package.json#type` field determines whether Node.js considers `.js` (or `.d.ts`) file within your project to be ESM or CJS.

Extension rewriting is achieved with a simple AST transform applied during compilation via the [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API).

The vanilla `tsc` compiler does not provde a mechanism for transpiling a `.ts` file to `.cjs`. To achieve this `zshy` uses the TypeScript Compiler API and a simple AST extension to rewrite the extensions as needed. both inside `import/export` statements and Extension rewriting is achieved with a simple AST transform applied during compilation via the TypeScript Compiler API.



Extension rewriting is achieved with a simple AST transform applied during compilation via the TypeScript Compiler API.

### Step 4: Generate exports

`zshy` automatically writes the `exports` map to your `package.json`:

```jsonc
{
  "exports": {
    ".": {
      "types": "./dist/index.d.cts",
      "import": "./dist/index.js", 
      "require": "./dist/index.cjs"
    }
  }
}
```

> **Why `.d.cts` for types?** The `"types"` field always points to the CJS declaration file. This avoids the ["Masquerading as ESM"](https://github.com/arethetypeswrong/arethetypeswrong.github.io/blob/main/docs/problems/FalseESM.md) error, which can make packages un-importable from CJS environments. Since ESM can `require()` CJS but CJS can't `import` ESM (without dynamic imports), converging on `.d.cts` ensures maximum compatibility.

### Features of `zshy`

While heavily inspired by [`tshy`](https://github.com/isaacs/tshy), `zshy` differs in several major ways:

- **Extension rewriting** — Uses the TypeScript Compiler API to rewrite imports, exports, and file extensions as needed. 

> `tshy` was designed to enable dual-package builds powered by the `tsc` compiler. To make this work, it relies on a specific file structure and the creation of temporary `package.json` files to accommodate the various idiosyncrasies of Node.js module resolution. TypeScript provides a robust API for AST transformations that `tshy` does not take advantage of.

- **Unopinionated file structure** — Allows any set of input entrypoints. `zshy` transpiles your entrypoints and all the files they import. It respects `outDir`, `rootDir`, and `declarationDir` in your `tsconfig.json` if specified (and provides sensible defaults otherwise).

> `tshy` requires you to put your source in a `./src` directory, and always builds to `./dist`

**Clean, flat structure** — No nested directories or duplicated files. `zshy` generates `.js`/`.cjs`/`.d.cts` files alongside each other, mirroring the original source file structure. 

>`tshy` always generates plain `.js`/`.d.ts` files into separate `dist/esm` and `dist/cjs` directories. Each of these subdirectories contain a stub `package.json` with a `"type"` field to indicate the module format. This also causes issues with [Module Federation](https://github.com/colinhacks/zod/issues/4656) caused by stub `package.json` files.

**No duplicate `.d.ts` files** —  `zshy` produces a single canonical declaration file for each source files.

> `tshy` generates independent (but identical) `.d.ts` files in `dist/esm` and `dist/cjs`. This duplication introduces the possibility for thorny [Excessively Deep](https://github.com/colinhacks/zod/issues/4422) issues in packages that rely on declaration merging (`declare module {}`) for plugins (e.g. [Zod](https://github.com/colinhacks/zod), [day.js](https://day.js.org/), etc)

**Extensionless imports** — There are thousands of legacy codebases that rely on TypeScript's old extension-less imports. More recently, TypeScript added support for `.ts` extensions with [`rewriteRelativeImportExtensions`](https://www.typescriptlang.org/tsconfig/#rewriteRelativeImportExtensions). You can use whatever you like; `zshy` will rewrite the extensions during build.

> `tshy` requires you to include file extensions on your imports. While this is generally a good practice, it's not always feasible. 

- **Support for legacy, non-Node.js environments** — Many React Native codebases and older TypeScript projects rely on legacy module resolution systems that pre-date the existence of `package.json#exports` and ESM. 

1. Metro bundlers for React Native
2. Projects with `tsconfig.json#module` set to `"commonjs"`
3. Non-Node.js environments with different module resolution systems

With `zshy` it's possible to *simulate* subpath imports in these environments:

1. Put your source files in your package root (not in a `src` directory) 
2. Set `outDir` to `.`

With this setup, imports like `"your-libary/utils"` will auto-resolve to `"your-libarary/utils/index.js"` in most environments. Zod uses this approach to achieve broader compatibilty. 

