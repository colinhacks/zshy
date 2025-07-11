import * as ts from "typescript";
import type { ProjectOptions } from "./compile";
import { analyzeExports } from "./tx-analyze-exports";
import * as utils from "./utils";

// Create CJS interop transformer for single default exports
export const createCjsInteropTransformer =
  (config: ProjectOptions): ts.TransformerFactory<ts.SourceFile> =>
  (context) => {
    return (sourceFile) => {
      // Use shared export analysis function
      const { hasDefaultExport, hasNamedExports } = analyzeExports(sourceFile);

      // Only apply transformation if we have exactly one default export and no named exports
      const shouldApplyInterop = hasDefaultExport && !hasNamedExports;

      // Debug logging
      if (shouldApplyInterop && config.verbose) {
        utils.emojiLog("🔄", `Applying cjsInterop transform to ${sourceFile.fileName}`);
      }

      const visitor = (node: ts.Node): ts.Node => {
        // For CJS builds, we'll handle export = transformation in the afterDeclarations phase
        // For now, just pass through the node
        return ts.visitEachChild(node, visitor, context);
      };

      const transformedSourceFile = ts.visitNode(sourceFile, visitor) as ts.SourceFile;

      // For CJS builds, inject module.exports = exports.default at the end
      if (shouldApplyInterop) {
        const moduleExportsStatement = ts.factory.createExpressionStatement(
          ts.factory.createBinaryExpression(
            ts.factory.createPropertyAccessExpression(
              ts.factory.createIdentifier("module"),
              ts.factory.createIdentifier("exports")
            ),
            ts.factory.createToken(ts.SyntaxKind.EqualsToken),
            ts.factory.createPropertyAccessExpression(
              ts.factory.createIdentifier("exports"),
              ts.factory.createIdentifier("default")
            )
          )
        );

        const statements = [...transformedSourceFile.statements, moduleExportsStatement];
        return ts.factory.updateSourceFile(transformedSourceFile, statements);
      }

      return transformedSourceFile;
    };
  };
