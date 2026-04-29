import * as ts from "typescript";
import { analyzeExports } from "./tx-analyze-exports.js";

type CjsInteropTransformerOptions = {
  preserveConstEnums?: boolean;
};

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function bindingNameContains(name: ts.BindingName, text: string): boolean {
  if (ts.isIdentifier(name)) {
    return name.text === text;
  }
  return name.elements.some((element) => !ts.isOmittedExpression(element) && bindingNameContains(element.name, text));
}

function importClauseContainsRuntimeName(importClause: ts.ImportClause | undefined, text: string): boolean {
  if (!importClause || importClause.isTypeOnly) {
    return false;
  }
  if (importClause.name?.text === text) {
    return true;
  }

  const namedBindings = importClause.namedBindings;
  if (!namedBindings) {
    return false;
  }
  if (ts.isNamespaceImport(namedBindings)) {
    return namedBindings.name.text === text;
  }
  return namedBindings.elements.some((element) => !element.isTypeOnly && element.name.text === text);
}

function importClauseContainsTypeOnlyName(importClause: ts.ImportClause | undefined, text: string): boolean {
  if (!importClause) {
    return false;
  }
  if (importClause.isTypeOnly) {
    if (importClause.name?.text === text) {
      return true;
    }
    const namedBindings = importClause.namedBindings;
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      return namedBindings.name.text === text;
    }
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      return namedBindings.elements.some((element) => element.name.text === text);
    }
    return false;
  }

  const namedBindings = importClause.namedBindings;
  return (
    namedBindings != null &&
    ts.isNamedImports(namedBindings) &&
    namedBindings.elements.some((element) => element.isTypeOnly && element.name.text === text)
  );
}

function declaresRuntimeValue(stmt: ts.Statement, text: string, options: CjsInteropTransformerOptions): boolean {
  if (hasModifier(stmt, ts.SyntaxKind.DeclareKeyword)) {
    return false;
  }
  if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
    return stmt.name?.text === text;
  }
  if (ts.isEnumDeclaration(stmt)) {
    const isConstEnum = hasModifier(stmt, ts.SyntaxKind.ConstKeyword);
    return stmt.name.text === text && (!isConstEnum || options.preserveConstEnums === true);
  }
  if (ts.isVariableStatement(stmt)) {
    return stmt.declarationList.declarations.some((declaration) => bindingNameContains(declaration.name, text));
  }
  if (ts.isImportDeclaration(stmt)) {
    return importClauseContainsRuntimeName(stmt.importClause, text);
  }
  return false;
}

function declaresTypeOnlyName(stmt: ts.Statement, text: string): boolean {
  if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) {
    return stmt.name.text === text;
  }
  if (ts.isImportDeclaration(stmt)) {
    return importClauseContainsTypeOnlyName(stmt.importClause, text);
  }
  return false;
}

function hasExportedConstEnum(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some(
    (stmt) =>
      ts.isEnumDeclaration(stmt) &&
      hasModifier(stmt, ts.SyntaxKind.ExportKeyword) &&
      hasModifier(stmt, ts.SyntaxKind.ConstKeyword) &&
      !hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)
  );
}

function isTypeOnlyDefault(
  node: ts.Statement,
  sourceFile: ts.SourceFile,
  options: CjsInteropTransformerOptions
): boolean {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
    return true;
  }
  // `export default Foo` where Foo is an identifier: skip interop only if Foo has no runtime declaration.
  if (ts.isExportAssignment(node) && !node.isExportEquals && ts.isIdentifier(node.expression)) {
    const name = node.expression.text;
    const hasRuntimeDeclaration = sourceFile.statements.some((stmt) => declaresRuntimeValue(stmt, name, options));
    const hasTypeOnlyDeclaration = sourceFile.statements.some((stmt) => declaresTypeOnlyName(stmt, name));
    return hasTypeOnlyDeclaration && !hasRuntimeDeclaration;
  }
  return false;
}

export const createCjsInteropTransformer =
  (options: CjsInteropTransformerOptions = {}): ts.TransformerFactory<ts.SourceFile> =>
  (context) => {
    return (sourceFile) => {
      if (!ts.isSourceFile(sourceFile)) return sourceFile;

      const { defaultExportNode, hasNamedExports } = analyzeExports(sourceFile);

      const isDefaultTypeOnly = defaultExportNode != null && isTypeOnlyDefault(defaultExportNode, sourceFile, options);
      const hasRuntimeNamedExports =
        hasNamedExports || (options.preserveConstEnums === true && hasExportedConstEnum(sourceFile));
      const shouldApplyInterop = defaultExportNode && !hasRuntimeNamedExports && !isDefaultTypeOnly;

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
