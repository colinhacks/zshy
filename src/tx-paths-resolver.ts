import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

export interface PathsConfig {
  baseUrl?: string;
  paths?: Record<string, string[]>;
  tsconfigDir: string;
  rootDir: string;
}

function matchPathPattern(moduleSpecifier: string, pattern: string): { matched: boolean; captured?: string } {
  // Handle wildcard patterns
  if (pattern.includes("*")) {
    // Convert pattern to regex
    const regexPattern = pattern
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\\\*/g, "(.*)");
    const regex = new RegExp(`^${regexPattern}$`);
    const match = moduleSpecifier.match(regex);
    
    if (match) {
      return { matched: true, captured: match[1] };
    }
  } else if (moduleSpecifier === pattern) {
    // Exact match
    return { matched: true };
  }
  
  return { matched: false };
}

function resolvePaths(
  moduleSpecifier: string,
  config: PathsConfig
): string | null {
  // Skip relative imports
  if (moduleSpecifier.startsWith("./") || moduleSpecifier.startsWith("../")) {
    return null;
  }
  
  // Skip node modules
  if (!moduleSpecifier.startsWith("@") && !moduleSpecifier.includes("/") && !config.paths?.[moduleSpecifier]) {
    // Check if this could be a paths alias
    const hasMatchingPattern = config.paths && Object.keys(config.paths).some(pattern => {
      const cleanPattern = pattern.replace("*", "");
      return moduleSpecifier.startsWith(cleanPattern);
    });
    
    if (!hasMatchingPattern) {
      return null;
    }
  }
  
  if (!config.paths) return null;
  
  // Try to match against path patterns
  for (const [pattern, replacements] of Object.entries(config.paths)) {
    const { matched, captured } = matchPathPattern(moduleSpecifier, pattern);
    
    if (matched) {
      // Try each replacement in order
      for (const replacement of replacements) {
        let resolvedPath = replacement;
        
        // Replace wildcard with captured content
        if (captured !== undefined && replacement.includes("*")) {
          resolvedPath = replacement.replace("*", captured);
        }
        
        // Resolve relative to baseUrl or tsconfig directory
        const basePath = config.baseUrl 
          ? path.resolve(config.tsconfigDir, config.baseUrl)
          : config.tsconfigDir;
        
        const absolutePath = path.resolve(basePath, resolvedPath);
        
        // Check if the path exists (try with various extensions)
        const extensions = [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];
        
        // First try exact path
        if (fs.existsSync(absolutePath)) {
          // Check if it's a directory with index file
          if (fs.statSync(absolutePath).isDirectory()) {
            for (const ext of ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"]) {
              if (fs.existsSync(absolutePath + ext)) {
                // Return relative path from the source file location
                return absolutePath + ext;
              }
            }
          } else {
            return absolutePath;
          }
        }
        
        // Try with extensions
        for (const ext of extensions) {
          if (fs.existsSync(absolutePath + ext)) {
            return absolutePath + ext;
          }
        }
      }
    }
  }
  
  return null;
}

export const createPathsResolverTransformer =
  (config: PathsConfig): ts.TransformerFactory<ts.SourceFile | ts.Bundle> =>
  (context) => {
    return (sourceFile) => {
      const visitor = (node: ts.Node): ts.Node => {
        const isImport = ts.isImportDeclaration(node);
        const isExport = ts.isExportDeclaration(node);
        const isDynamicImport = ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword;
        
        let originalText: string;
        if (isImport || isExport || isDynamicImport) {
          if (isImport || isExport) {
            if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) {
              return ts.visitEachChild(node, visitor, context);
            }
            
            originalText = node.moduleSpecifier.text;
          } else if (isDynamicImport) {
            const arg = node.arguments[0]!;
            if (!ts.isStringLiteral(arg)) {
              return ts.visitEachChild(node, visitor, context);
            }
            originalText = arg.text;
          } else {
            return ts.visitEachChild(node, visitor, context);
          }
          
          // Try to resolve using paths
          const resolvedPath = resolvePaths(originalText, config);
          
          if (resolvedPath && ts.isSourceFile(sourceFile)) {
            // Convert absolute path to relative path from current source file
            const sourceFileDir = path.dirname(sourceFile.fileName);
            let relativePath = path.relative(sourceFileDir, resolvedPath);
            
            // Ensure it starts with ./ or ../
            if (!relativePath.startsWith(".")) {
              relativePath = "./" + relativePath;
            }
            
            // Convert to posix path
            relativePath = relativePath.replace(/\\/g, "/");
            
            // Remove extension for TypeScript files
            if (relativePath.endsWith(".ts") || relativePath.endsWith(".tsx")) {
              relativePath = relativePath.replace(/\.(ts|tsx)$/, "");
            }
            
            // Update the node with resolved path
            if (isImport) {
              return ts.factory.updateImportDeclaration(
                node,
                node.modifiers,
                node.importClause,
                ts.factory.createStringLiteral(relativePath),
                node.assertClause
              );
            } else if (isExport) {
              return ts.factory.updateExportDeclaration(
                node,
                node.modifiers,
                node.isTypeOnly,
                node.exportClause,
                ts.factory.createStringLiteral(relativePath),
                node.assertClause
              );
            } else if (isDynamicImport) {
              return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
                ts.factory.createStringLiteral(relativePath),
                ...node.arguments.slice(1),
              ]);
            }
          }
        }
        
        return ts.visitEachChild(node, visitor, context);
      };
      
      return ts.visitNode(sourceFile, visitor) as ts.SourceFile;
    };
  };