<p align="center">

  <h1 align="center">⚜️<br/><code>zshy</code></h1>
  <p align="center">Gold-standard build tool for TypeScript libraries.
    <br/>
    by <a href="https://x.com/colinhacks">@colinhacks</a>
  </p>
</p>
<br/>

<p align="center">
<!-- <a href="https://github.com/colinhacks/zshy/actions?query=branch%3Amain"><img src="https://github.com/colinhacks/zshy/actions/workflows/test.yml/badge.svg?event=push&branch=main" alt="zshy CI status" /></a> -->
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
<br/>


<!-- ## What is `zshy`? -->

<h2 align="center">What is <code>zshy</code>?</h2>

`zshy` is a simple, zero-config build tool for transpiling TypeScript libraries. It was originally created as internal build tool for [Zod](https://github.com/colinhacks/zod) but is now available as a general-purpose tool for TypeScript libraries.

### Features

- 🧱 **Dual-package builds** — Builds ESM and CJS outputs from a single TypeScript source file.

- 👑 **Powered by `tsc`** — No bundling, no extra configs, just good old-fashioned `tsc`. It's the gold standard for transpiling TypeScript.

- 🏠 **Declarative config** — No build scripts, just a simple `"zshy"` field in your `package.json`.
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
- 🤖 **Auto-generated `"exports"`** — Generates the appropriate `"exports"` map and writes it directly into your `package.json`.

- 📂 **Unopinionated about file structure** — You can use any file structure you like. `zshy` respects your `outDir` (and `rootDir` and `declarationDir`) and makes sure the `"exports"` map is always 100% correct.

- 🔗 **Unopinionated about import extensions** — Use any import syntax TypeScript supports: extensionless, `.js`, `.ts`, whatever. `zshy` rewrites extensions during the build to ensure compatibility

- ⚛️ **Supports `.tsx`** — JSX syntax will be transformed according to your `tsconfig.json` settings.

- 🐌 **Blazing fast** — Just kidding, it's slow. Typechecking with `tsc` is a lot slower than using a bundler that strips types. That said:
  1. you *should* be type checking your code during builds,
  2. TypeScript is [about to get 10x faster](https://devblogs.microsoft.com/typescript/typescript-native-port/), and 
  3. you just spent the last hour staring at a Cursor spinner anyway


<br/>
<br/>
<h2 align="center">Usage</h2>

<br/>

### 1. Install `zshy` as a dev dependency:

```bash
npm install --save-dev zshy
yarn add --dev zshy
pnpm add --save-dev zshy
```

<br/>

### 2. Add the `"zshy"` field to your `package.json`

Specify your package entrypoint with the `"zshy"` key in `package.json`.

```jsonc
{
  "name": "my-pkg",
  "version": "1.0.0",
  "zshy": "./src/index.ts" // package entrypoint
}
```

More complicated packages can specify subpaths or wildcard exports with `"zshy.exports"`:

```jsonc
{
  "name": "my-pkg",
  "version": "1.0.0",

  "zshy": {
    "exports": {
      ".": "./src/index.ts", // root entrypoints
      "./utils": "./src/utils.ts", // subpath
      "./plugins/*": "./src/plugins/*" // wildcards
    }
  }
}
```

<br/>

### 3. Run a build

```bash
$ npx zshy

💎 Starting zshy build...
⚙️ Detected project root: /path/to/my-pkg
📦 Reading package.json from ./package.json
📁 Reading tsconfig from ./tsconfig.json
➡️ Determining entrypoints...
   ╔════════════════════╤═════════════════════════════╗
   ║ Subpath            │ Entrypoint                  ║
   ╟────────────────────┼─────────────────────────────╢
   ║ "my-pkg"           │ ./src/index.ts              ║
   ╟────────────────────┼─────────────────────────────╢
   ║ "my-pkg/utils"     │ ./src/utils.ts              ║
   ╟────────────────────┼─────────────────────────────╢
   ║ "my-pkg/plugins/*" │ ./src/plugins/* (5 matches) ║
   ╚════════════════════╧═════════════════════════════╝
📂 Transpiling from ./src (rootDir) to ./dist (outDir)
🟨 Package is ES module (package.json#type is "module")
🧱 Building CJS... (rewriting .ts -> .cjs/.d.cts)
🧱 Building ESM...
📦 Updating package.json exports...
   {
     ".": {
       "types": "./out/index.d.cts",
       "import": "./out/index.js",
       "require": "./out/index.cjs"
     },
     "./utils": {
       "types": "./out/utils.d.cts",
       "import": "./out/utils.js",
       "require": "./out/utils.cjs"
     },
     "./plugins/*": {
       "import": "./out/src/plugins/*",
       "require": "./out/src/plugins/*"
     }
   }
🎉 Build complete!
```

Alernatively, add a `"build"` script to your `package.json`:

```diff
{
  // ...
  "scripts": {
+   "build": "zshy"
  }
}
```

Then, to run a build:

```bash
$ npm run build
```


<br/>
<br/>
<h2 align="center">FAQ</h2>

<br/>

### How does `zshy` resolve entrypoints?

It reads your `package.json#zshy` config:

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

**Note** — Since `zshy` computes an exact set of resolved entrypoints, your `"files"`, `"include"`, and `"exclude"` settings in `tsconfig.json` are ignored during the build.

<br/>

### Does `zshy` respect my `tsconfig.json` compiler options?

Yes! With some strategic overrides:

- **`module`**: Overridden (`"commonjs"` for CJS build, `"esnext"` for ESM build)
- **`moduleResolution`**: Overridden (`"node10"` for CJS, `"bundler"` for ESM)
- **`declaration`/`noEmit`/`emitDeclarationOnly`**: Overridden to ensure proper output
- **`verbatimModuleSyntax`**: Set to `false` to allow multiple build formats

All other options are respected, including:

- `rootDir` (defaults to the common ancestor directory of all entrypoints)
- `outDir` (defaults to `./dist`)
- `declarationDir` (defaults to `./dist` — you probably shouldn't set this explicitly)
- `target` (defaults to `es2020`)
- `jsx`

<br/>

### Do I need to use a specific file structure?

No. You can organize your source however you like; `zshy` will transpile your entrypoints and all the files they import, respecting your `tsconfig.json` settings.

> **Comparison** — `tshy` requires you to put your source in a `./src` directory, and always builds to `./dist/esm` and `./dist/cjs`.

<br/>

### What files does `zshy` create?

It depends on your `package.json#type` field. If your package is ESM (that is, `"type": "module"` in `package.json`), the CJS build files will be generated as `.cjs`/`.d.cts`:

- `.js` + `.d.ts` (ESM)
- `.cjs` + `.d.cts` (CJS)

```bash
$ tree out

.
├── package.json # if type == "module"
├── src
│   └── index.ts
└── out
    ├── index.js 
    ├── index.d.ts
    ├── index.cts
    └── index.d.cts
```

Otherwise, the package is considered *default-CJS* and the ESM build files will be rewritten as `.mjs`/`.d.mts`.

- `.mjs` + `.d.mts` (ESM)
- `.js` + `.d.ts` (CJS)

```bash
$ tree out
.
├── package.json # if type != "module"
├── src
│   └── index.ts
└── out
    ├── index.js
    ├── index.d.ts
    ├── index.mjs
    └── index.d.mts
```

> **Comparison** — `tshy` generates plain `.js`/`.d.ts` files into separate `dist/esm` and `dist/cjs` directories, each with a stub `package.json` to enable proper module resolution in Node.js. This is more convoluted than the flat file structure generated by `zshy`. It also causes issues with [Module Federation](https://github.com/colinhacks/zod/issues/4656). 

<br/>

### How does extension rewriting work?

`zshy` uses the [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) to perform extension rewriting during the `tsc` build process. TypeScript provides dedicated hooks for performing such transforms (though they are criminally under-utilized, until now!):

- **`ts.TransformerFactory`**: Provides AST transformations to rewrite import/export extensions before module conversion
- **`ts.CompilerHost#writeFile`**: Handles output file extension changes (`.js` → `.cjs`/`.mjs`)

> **Comparison** — `tshy` was designed to enable dual-package builds powered by the `tsc` compiler. To make this work, it relies on a specific file structure and the creation of temporary `package.json` files to accommodate the various idiosyncrasies of Node.js module resolution. TypeScript provides a robust API for AST transformations (`ts.TransformerFactory`) that `tshy` does not take advantage of.

<br/>

### Can I use extension-less imports?

Yes! `zshy` supports whatever import style you prefer: 
- `from "./utils"`: classic extensionless imports
- `from "./utils.js"`: ESM-friendly extensioned imports
- `from "./util.ts"`: recently supported natively via[`rewriteRelativeImportExtensions`](https://www.typescriptlang.org/tsconfig/#rewriteRelativeImportExtensions)

Use whatever you like; `zshy` will rewrite extensionless and `.ts` imports/exports to have the appropriate file extension.

> **Comparison** — `tshy` forces you to use `.js` imports throughout your codebase. While this is generally a good practice, it's not always feasible, and there are hundreds of thousands of existing TypeScript codebases reliant on extensionless imports.

<br/>

### How does it generate `package.json#exports`?

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
+     "types": "./out/index.d.cts",
+     "import": "./out/index.js",
+     "require": "./out/index.cjs"
+   },
+   "./utils": {
+     "types": "./out/utils.d.cts", 
+     "import": "./out/utils.js",
+     "require": "./out/utils.cjs"
+   },
+   "./plugins/*": {
+     "import": "./out/src/plugins/*",
+     "require": "./out/src/plugins/*"
+   }
+ }
}
```

<br/>

### Why `.d.cts` for `"types"`?

The `"types"` field always points to the CJS declaration file (`.d.cts`). This is an intentional design choice.

**It solves "Masquerading as ESM" issue**. Put more simply, you can always `import` a CJS package from ESM, but you can't `require` an ES module from a CJS environment. You've likely seen this dreaded error before:

```ts
import mod from "pkg";         ^^^^^
//              ^ The current file is a CommonJS module whose imports will produce 'require' calls; however, the referenced file is an ECMAScript module and cannot be imported with 'require'. Consider writing a dynamic 'import("pkg")' call instead.
```

By having `"types"` point to the `.d.cts` declarations, this error will never happen. Technically, we're lying to TypeScript and telling it to always assume our code is CommonJS; in practice, this has no real consequences and maximizes compatibility. To learn more, read the ["Masquerading as ESM"](https://github.com/arethetypeswrong/arethetypeswrong.github.io/blob/main/docs/problems/FalseESM.md) and ["Masquerading as CJS"](https://github.com/arethetypeswrong/arethetypeswrong.github.io/blob/main/docs/problems/FalseCJS.md) writeups from Are The Types Wrong. 

> **Comparison** — `tshy` generates independent (but identical) `.d.ts` files in `dist/esm` and `dist/cjs`. This can cause [Excessively Deep](https://github.com/colinhacks/zod/issues/4422) errors if users of the library use declaration merging (`declare module {}`) for plugins/extensions. [Zod](https://github.com/colinhacks/zod), [day.js](https://day.js.org/), and others rely on this pattern for plugins.

<br/>

### Can it support React Native legacy or non-Node.js environments?

Yes! This is one of the key reasons `zshy` was originally developed for Zod. 

Many environments don't support `package.json#exports` yet (React Native, older bundlers, Node.js v10 or earlier, and many TypeScript projects using legacy configs). This causes issues for packages that want to use subpath imports to structure their package. Fortunately `zshy` unlocks a workaround I call a *flat build*:

1. Remove `"type": "module"` from your `package.json` (if present)
2. Put your source files in your package root (not in a `src` directory)
3. Set `outDir: "."` in your `tsconfig.json`

With this setup, your build outputs (`index.js`, etc) will be written to disk right next to their corresponding source files. This lets you simulate subpath imports; imports like `"your-library/utils"` will generally resolve to `"your-library/utils/index.js"` in environments that predate modern module resolution. Zod uses this approach for broader compatibility with the following environments:

1. **Node.js v12.7 or older**
2. **TypeScript projects using legacy configs** - e.g. `"module": "commonjs"`
3. **React Native** - The Metro bundler does not support `"exports"` by default 
