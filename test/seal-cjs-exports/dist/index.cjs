"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.local = exports.renamed = void 0;
__exportStar(require("./leaf.cjs"), exports);
var leaf_js_1 = require("./leaf.cjs");
Object.defineProperty(exports, "renamed", { enumerable: true, get: function () { return leaf_js_1.named; } });
const local = () => "local";
exports.local = local;
for (const key of Object.getOwnPropertyNames(exports)) {
  const desc = Object.getOwnPropertyDescriptor(exports, key);
  if (!desc || !desc.get || !desc.configurable) continue;
  let value;
  try {
    value = desc.get();
  } catch {
    continue;
  }
  // a circular require may not have settled this one yet, so leave it live
  if (value === undefined) continue;
  Object.defineProperty(exports, key, { value, writable: false, enumerable: desc.enumerable, configurable: false });
}
Object.freeze(exports);
//# sourceMappingURL=index.js.map