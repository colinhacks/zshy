import * as ts from "typescript";

function analyzeExportDeclaration(node: ts.ExportDeclaration): {
  hasNamedExports: boolean;
  hasTypeOnlyExports: boolean;
} {
  if (!node.exportClause && !node.moduleSpecifier) {
    return { hasNamedExports: false, hasTypeOnlyExports: false };
  }

  if (node.isTypeOnly) {
    return { hasNamedExports: false, hasTypeOnlyExports: true };
  }

  if (node.exportClause && ts.isNamedExports(node.exportClause)) {
    const hasNamedExports = node.exportClause.elements.some((element) => !element.isTypeOnly);
    const hasTypeOnlyExports = node.exportClause.elements.some((element) => element.isTypeOnly);
    return { hasNamedExports, hasTypeOnlyExports };
  }

  return { hasNamedExports: true, hasTypeOnlyExports: false };
}

// Shared function to analyze exports in a source file
export const analyzeExports = (
  sourceFile: ts.SourceFile
): { defaultExportNode: ts.Statement | null; hasNamedExports: boolean; hasTypeOnlyExports: boolean } => {
  let defaultExportNode: ts.Statement | null = null;
  let hasNamedExports = false;
  let hasTypeOnlyExports = false;

  const visitor = (node: ts.Node): void => {
    // 1) export default <expr>;
    if (ts.isExportAssignment(node) && !node.isExportEquals) {
      defaultExportNode = node;
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
      defaultExportNode = node;
    }
    // 3) named exports/re-exports (`export { a, type T }`, `export type { T }`, `export *`)
    else if (ts.isExportDeclaration(node)) {
      const exportInfo = analyzeExportDeclaration(node);
      hasNamedExports ||= exportInfo.hasNamedExports;
      hasTypeOnlyExports ||= exportInfo.hasTypeOnlyExports;
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
    // 7) named `export enum …` (but _not_ default)
    // Regular enums emit runtime JS; const enums are erased (type-only).
    else if (
      ts.isEnumDeclaration(node) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      !node.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      if (node.modifiers.some((m) => m.kind === ts.SyntaxKind.ConstKeyword)) {
        hasTypeOnlyExports = true;
      } else {
        hasNamedExports = true;
      }
    }
    // 8) type-only exports: `export type`, `export interface` (not default)
    else if (
      (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      !node.modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      hasTypeOnlyExports = true;
    }
    ts.forEachChild(node, visitor);
  };

  ts.forEachChild(sourceFile, visitor);
  return { defaultExportNode, hasNamedExports, hasTypeOnlyExports };
};
