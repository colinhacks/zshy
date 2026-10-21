#!/usr/bin/env bash
# Install zshy the way a user would, into an empty project, and build a one-file library with it.
#
#   smoke-install.sh <package-spec> <typescript-version>
#
# <package-spec> is the packed tarball before staging, or zshy@<version> once npm serves it.
# Tests passing in the checkout do not prove the packed package works: a file left out of
# `files`, or a bin that does not resolve, only shows up once it is installed. TypeScript is
# pinned to the version the tests ran against, so this checks the package and not whichever
# TypeScript npm would pick for the peer range today (test.yml's typescript-next job covers newer
# ones). The library is loaded through every entry point zshy writes for it.
set -euo pipefail
spec="${1:?usage: smoke-install.sh <package-spec> <typescript-version>}"
typescript="${2:?usage: smoke-install.sh <package-spec> <typescript-version>}"
dir="$(mktemp -d)"
cd "$dir"
cat > package.json <<'JSON'
{ "name": "zshy-smoke", "version": "0.0.0", "type": "module", "zshy": "./src/index.ts" }
JSON
cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "strict": true, "target": "es2022", "module": "nodenext", "moduleResolution": "nodenext", "declaration": true, "skipLibCheck": true } }
JSON
mkdir src
echo 'export const answer: number = 42;' > src/index.ts
npm install --no-audit --no-fund --prefer-online "$spec" "typescript@$typescript"
# By path: zshy's `exports` does not expose ./package.json.
echo "installed zshy $(node -p "require('./node_modules/zshy/package.json').version") with TypeScript $(node -p "require('./node_modules/typescript/package.json').version")"
./node_modules/.bin/zshy
# zshy writes the entry points it built into package.json#exports; each condition it wrote must
# load and export what src/index.ts does. `require` loads every one of them too: a `require`
# condition is CommonJS, and Node.js 20.19+ can require() the ES modules behind the others.
node --input-type=module - <<'JS'
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const entry = JSON.parse(readFileSync("package.json", "utf8")).exports?.["."];
const targets = Object.entries(entry ?? {}).filter(([condition]) => condition !== "types");
if (targets.length === 0) throw new Error(`zshy wrote no entry point: ${JSON.stringify(entry)}`);
const require = createRequire(import.meta.url);
for (const [condition, file] of targets) {
  if (condition !== "require" && (await import(file)).answer !== 42) throw new Error(`import of ${file} is wrong`);
  if (require(file).answer !== 42) throw new Error(`require of ${file} is wrong`);
}
console.log(`entry points load: ${targets.map(([condition, file]) => `${condition} ${file}`).join(", ")}`);
JS
echo "✓ $spec installs and builds a library"
