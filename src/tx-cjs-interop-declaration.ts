import * as ts from "typescript";
import { analyzeExports } from "./tx-analyze-exports";

export const createCjsInteropDeclarationTransformer =
  (): ts.TransformerFactory<ts.SourceFile | ts.Bundle> => (context) => {
    return (sourceFile) => {
      // Only apply to SourceFile, not Bundle
      if (!ts.isSourceFile(sourceFile)) {
        return sourceFile;
      }

      // Use shared export analysis function
      const { hasDefaultExport, hasNamedExports } = analyzeExports(sourceFile);

      // Only apply transformation if we have exactly one default export and no named exports
      const shouldApplyInterop = hasDefaultExport && !hasNamedExports;

      const visitor = (node: ts.Node): ts.Node => {
        // Transform export default to export = in declaration files
        if (shouldApplyInterop && ts.isExportAssignment(node) && !node.isExportEquals) {
          // Create export = syntax
          return ts.factory.createExportAssignment(undefined, undefined, node.expression);
        }

        return ts.visitEachChild(node, visitor, context);
      };

      return ts.visitNode(sourceFile, visitor) as ts.SourceFile | ts.Bundle;
    };
  };
