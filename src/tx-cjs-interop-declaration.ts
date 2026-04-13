import * as ts from "typescript";
import { analyzeExports } from "./tx-analyze-exports.js";

export const createCjsInteropDeclarationTransformer =
  (): ts.TransformerFactory<ts.SourceFile | ts.Bundle> => (context) => {
    const { factory } = context;

    return (sourceFile) => {
      if (!ts.isSourceFile(sourceFile)) return sourceFile;

      const { defaultExportNode, hasNamedExports, hasTypeOnlyExports } = analyzeExports(sourceFile);

      if (!defaultExportNode || hasNamedExports || hasTypeOnlyExports) {
        return sourceFile;
      }

      const outStmts: ts.Statement[] = [];

      for (const stmt of sourceFile.statements) {
        if (stmt === defaultExportNode) {
          // case A: `export default <expr>;`
          if (ts.isExportAssignment(stmt)) {
            if (ts.isIdentifier(stmt.expression)) {
              outStmts.push(factory.createExportAssignment(undefined, true, stmt.expression));
            } else {
              outStmts.push(
                factory.createVariableStatement(
                  undefined,
                  factory.createVariableDeclarationList(
                    [factory.createVariableDeclaration(factory.createIdentifier("_default"), undefined, undefined)],
                    ts.NodeFlags.Const
                  )
                )
              );
              outStmts.push(factory.createExportAssignment(undefined, true, factory.createIdentifier("_default")));
            }
          }
          // case B: `export default function|class|interface|type|enum …`
          else {
            let name: ts.Identifier | undefined =
              ts.isFunctionDeclaration(stmt) ||
              ts.isClassDeclaration(stmt) ||
              ts.isInterfaceDeclaration(stmt) ||
              ts.isTypeAliasDeclaration(stmt) ||
              ts.isEnumDeclaration(stmt)
                ? stmt.name
                : undefined;
            if (!name) {
              name = factory.createIdentifier("_default");
            }
            const modifiers = (ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined)?.filter(
              (m) => m.kind !== ts.SyntaxKind.ExportKeyword && m.kind !== ts.SyntaxKind.DefaultKeyword
            );
            const declareModifiers = [factory.createModifier(ts.SyntaxKind.DeclareKeyword), ...(modifiers || [])];

            let decl: ts.Statement;
            if (ts.isFunctionDeclaration(stmt)) {
              decl = factory.createFunctionDeclaration(
                declareModifiers,
                stmt.asteriskToken,
                name,
                stmt.typeParameters,
                stmt.parameters,
                stmt.type,
                undefined
              );
            } else if (ts.isClassDeclaration(stmt)) {
              decl = factory.createClassDeclaration(
                declareModifiers,
                name,
                stmt.typeParameters,
                stmt.heritageClauses,
                stmt.members
              );
            } else if (ts.isInterfaceDeclaration(stmt)) {
              decl = factory.createInterfaceDeclaration(
                declareModifiers,
                name,
                stmt.typeParameters,
                stmt.heritageClauses,
                stmt.members
              );
            } else if (ts.isTypeAliasDeclaration(stmt)) {
              decl = factory.createTypeAliasDeclaration(declareModifiers, name, stmt.typeParameters, stmt.type);
            } else if (ts.isEnumDeclaration(stmt)) {
              decl = factory.createEnumDeclaration(declareModifiers, name, stmt.members);
            } else {
              outStmts.push(stmt);
              continue;
            }

            outStmts.push(decl);
            outStmts.push(factory.createExportAssignment(undefined, true, name));
          }
        } else {
          outStmts.push(stmt);
        }
      }

      return factory.updateSourceFile(sourceFile, outStmts);
    };
  };
