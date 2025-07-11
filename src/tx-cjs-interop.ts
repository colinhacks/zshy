import * as ts from "typescript";
import { analyzeExports } from "./tx-analyze-exports.js";

export const createCjsInteropTransformer = (): ts.TransformerFactory<ts.SourceFile> => (context) => {
  return (sourceFile) => {
    if (!ts.isSourceFile(sourceFile)) return sourceFile;

    const { defaultExportNode, hasNamedExports } = analyzeExports(sourceFile);

    // Only apply transformation if we have exactly one default export and no named exports
    const shouldApplyInterop = defaultExportNode && !hasNamedExports;

    if (!shouldApplyInterop) {
      return sourceFile;
    }

    const visitor = (node: ts.Node): ts.Node => {
      // Add module.exports = exports.default at the end of the file
      if (ts.isSourceFile(node)) {
        const statements = [...node.statements];

        // Add the CJS interop line at the end
        statements.push(
          ts.factory.createExpressionStatement(
            ts.factory.createAssignment(
              ts.factory.createPropertyAccessExpression(
                ts.factory.createIdentifier("module"),
                ts.factory.createIdentifier("exports")
              ),
              ts.factory.createPropertyAccessExpression(
                ts.factory.createIdentifier("exports"),
                ts.factory.createIdentifier("default")
              )
            )
          )
        );

        return ts.factory.updateSourceFile(
          node,
          statements,
          node.isDeclarationFile,
          node.referencedFiles,
          node.typeReferenceDirectives,
          node.hasNoDefaultLib,
          node.libReferenceDirectives
        );
      }

      return ts.visitEachChild(node, visitor, context);
    };

    return ts.visitNode(sourceFile, visitor) as ts.SourceFile;
  };
};
