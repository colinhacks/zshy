import * as path from "node:path";
import * as ts from "typescript";
import * as utils from "./utils.js";

export const createExtensionRewriteTransformer =
  (config: {
    rootDir: string;
    ext: string;
    onAssetImport?: (assetPath: string) => void;
  }): ts.TransformerFactory<ts.SourceFile | ts.Bundle> =>
  (context) => {
    return (sourceFile) => {
      const visitor = (node: ts.Node): ts.Node => {
        const isImport = ts.isImportDeclaration(node);
        const isExport = ts.isExportDeclaration(node);
        const isDynamicImport = ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;

        let originalText: string;
        if (isImport || isExport || isDynamicImport) {
          if (isImport || isExport) {
            if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) {
              return ts.visitEachChild(node, visitor, context);
            }

            originalText = node.moduleSpecifier.text;
          } else if (isDynamicImport) {
            const arg = node.arguments[0]!;
            if (!ts.isStringLiteral(arg)) {
              // continue
              return ts.visitEachChild(node, visitor, context);
            }
            originalText = arg.text;
          } else {
            // If it's not an import, export, or dynamic import, just visit children
            return ts.visitEachChild(node, visitor, context);
          }

          const isRelativeImport = originalText.startsWith("./") || originalText.startsWith("../");
          if (!isRelativeImport) {
            // If it's not a relative import, don't transform it
            return node;
          }

          const ext = path.extname(originalText).toLowerCase();

          // rewrite .js to resolved js extension
          if (ext === ".js" || ext === ".ts") {
            const newText = originalText.slice(0, -3) + config.ext;
            if (isImport) {
              return ts.factory.updateImportDeclaration(
                node,
                node.modifiers,
                node.importClause,
                ts.factory.createStringLiteral(newText),
                node.assertClause
              );
            } else if (isExport) {
              return ts.factory.updateExportDeclaration(
                node,
                node.modifiers,
                node.isTypeOnly,
                node.exportClause,
                ts.factory.createStringLiteral(newText),
                node.assertClause
              );
            } else if (isDynamicImport) {
              return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
                ts.factory.createStringLiteral(newText),
                ...node.arguments.slice(1),
              ]);
            }
          }

          // rewrite extensionless imports to .js
          if (ext === "") {
            const newText = originalText + config.ext;
            if (isImport) {
              return ts.factory.updateImportDeclaration(
                node,
                node.modifiers,
                node.importClause,
                ts.factory.createStringLiteral(newText),
                node.assertClause
              );
            } else if (isExport) {
              return ts.factory.updateExportDeclaration(
                node,
                node.modifiers,
                node.isTypeOnly,
                node.exportClause,
                ts.factory.createStringLiteral(newText),
                node.assertClause
              );
            } else if (isDynamicImport) {
              return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
                ts.factory.createStringLiteral(newText),
                ...node.arguments.slice(1),
              ]);
            }
          }

          // copy asset files
          if (utils.isAssetFile(originalText)) {
            // it's an asset
            if (ts.isSourceFile(sourceFile)) {
              const sourceFileDir = path.dirname(sourceFile.fileName);
              const resolvedAssetPath = path.resolve(sourceFileDir, originalText);
              // Make it relative to the source root (rootDir)
              const relAssetPath = path.relative(config.rootDir, resolvedAssetPath);
              // Track asset import if callback provided
              if (config.onAssetImport) {
                config.onAssetImport(relAssetPath);
              }
            }
            // Don't transform asset dynamic imports, leave them as-is
            return node;
          }
        }

        return ts.visitEachChild(node, visitor, context);
      };

      return ts.visitNode(sourceFile, visitor) as ts.SourceFile;
    };
  };
