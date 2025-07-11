import * as ts from "typescript";

// Create export = to export default transformer for ESM builds
export const createExportEqualsTransformer =
  <T extends ts.SourceFile | ts.Bundle>(): ts.TransformerFactory<T> =>
  (context) => {
    return (sourceFile) => {
      const visitor = (node: ts.Node): ts.Node => {
        // Handle export = syntax
        if (ts.isExportAssignment(node) && node.isExportEquals) {
          return ts.factory.createExportDefault(node.expression);
        }

        return ts.visitEachChild(node, visitor, context);
      };

      return ts.visitNode(sourceFile, visitor) as T;
    };
  };
