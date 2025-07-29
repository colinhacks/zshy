import * as ts from "typescript";
import { analyzeExports } from "./tx-analyze-exports.js";

export const createCjsInteropDeclarationTransformer =
  (): ts.TransformerFactory<ts.SourceFile | ts.Bundle> => (context) => {
    const { factory } = context;

    return (sourceFile) => {
      if (!ts.isSourceFile(sourceFile)) return sourceFile;

      const { defaultExportNode, hasNamedExports } = analyzeExports(sourceFile);

      // only proceed in the single-default, no-named case
      if (!defaultExportNode || hasNamedExports) {
        return sourceFile;
      }

      const outStmts: ts.Statement[] = [];

      for (const stmt of sourceFile.statements) {
        if (stmt === defaultExportNode) {
          // case A: `export default <expr>;`
          if (ts.isExportAssignment(stmt)) {
            // export default <expr>
            // If it's an identifier, use as is; otherwise, declare const _default: ...
            if (ts.isIdentifier(stmt.expression)) {
              outStmts.push(factory.createExportAssignment(undefined, true, stmt.expression));
            } else {
              // declare const _default: typeof <expr>;
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
            // pull the declared name or use _default
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
            // strip off `export` & `default`
            const modifiers = (ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined)?.filter(
              (m) => m.kind !== ts.SyntaxKind.ExportKeyword && m.kind !== ts.SyntaxKind.DefaultKeyword
            );

            // Add declare modifier for declaration files
            const declareModifiers = [factory.createModifier(ts.SyntaxKind.DeclareKeyword), ...(modifiers || [])];

            // rebuild the declaration without export/default
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
              // unexpected — just keep original
              outStmts.push(stmt);
              continue;
            }

            outStmts.push(decl);
            // append `export = Name;`
            outStmts.push(factory.createExportAssignment(undefined, true, name));
          }
        } else {
          outStmts.push(stmt);
        }
      }

      return factory.updateSourceFile(sourceFile, outStmts);
    };
  };
