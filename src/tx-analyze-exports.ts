import * as ts from "typescript";

// Shared function to analyze exports in a source file
export const analyzeExports = (sourceFile: ts.SourceFile): { hasDefaultExport: boolean; hasNamedExports: boolean } => {
  let hasDefaultExport = false;
  let hasNamedExports = false;

  const visitor = (node: ts.Node): void => {
    // 1) export default <expr>;
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      hasDefaultExport = true;
    }
    // 2) export default function/class/interface/type/enum …
    else if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      node.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      hasDefaultExport = true;
    }
    // 3) named re-exports (`export { a, b } from …` or `export { x }`)
    else if (ts.isExportDeclaration(node) && node.exportClause) {
      hasNamedExports = true;
    }
    // 4) named `export const/let/var …`
    else if (ts.isVariableStatement(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      hasNamedExports = true;
    }
    // 5) named `export function …` (but _not_ default)
    else if (
      ts.isFunctionDeclaration(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      !node.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      hasNamedExports = true;
    }
    // 6) named `export class …` (but _not_ default)
    else if (
      ts.isClassDeclaration(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      !node.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      hasNamedExports = true;
    }

    ts.forEachChild(node, visitor);
  };

  ts.forEachChild(sourceFile, visitor);
  return { hasDefaultExport, hasNamedExports };
};
