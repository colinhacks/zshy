import * as ts from "typescript";
import { analyzeExports } from "./tx-analyze-exports.js";

function isTypeOnlyDefault(node: ts.Statement, sourceFile: ts.SourceFile): boolean {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
    return true;
  }
  // `export default Foo` where Foo is an identifier — check if it resolves to a type/interface
  if (ts.isExportAssignment(node) && !node.isExportEquals && ts.isIdentifier(node.expression)) {
    const name = node.expression.text;
    for (const stmt of sourceFile.statements) {
      if (
        (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) &&
        stmt.name.text === name
      ) {
        return true;
      }
    }
  }
  return false;
}

export const createCjsInteropTransformer = (): ts.TransformerFactory<ts.SourceFile> => (context) => {
  return (sourceFile) => {
    if (!ts.isSourceFile(sourceFile)) return sourceFile;

    const { defaultExportNode, hasNamedExports } = analyzeExports(sourceFile);

    const isDefaultTypeOnly = defaultExportNode != null && isTypeOnlyDefault(defaultExportNode, sourceFile);
    const shouldApplyInterop = defaultExportNode && !hasNamedExports && !isDefaultTypeOnly;

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
