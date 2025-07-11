import * as ts from "typescript";

// Create import.meta shim transformer for CJS builds
export const createImportMetaShimTransformer = (): ts.TransformerFactory<ts.SourceFile> => (context) => {
  return (sourceFile) => {
    const visitor = (node: ts.Node): ts.Node => {
      // Handle import.meta.url
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isMetaProperty(node.expression) &&
        node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
        node.name.text === "url"
      ) {
        return ts.factory.createCallExpression(
          ts.factory.createPropertyAccessExpression(
            ts.factory.createCallExpression(ts.factory.createIdentifier("require"), undefined, [
              ts.factory.createStringLiteral("url"),
            ]),
            ts.factory.createIdentifier("pathToFileURL")
          ),
          undefined,
          [ts.factory.createIdentifier("__filename")]
        );
      }

      // Handle import.meta.dirname
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isMetaProperty(node.expression) &&
        node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
        node.name.text === "dirname"
      ) {
        return ts.factory.createIdentifier("__dirname");
      }

      // Handle import.meta.filename
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isMetaProperty(node.expression) &&
        node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
        node.name.text === "filename"
      ) {
        return ts.factory.createIdentifier("__filename");
      }

      return ts.visitEachChild(node, visitor, context);
    };

    return ts.visitNode(sourceFile, visitor) as ts.SourceFile;
  };
};
