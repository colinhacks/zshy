"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.named = exports.starred = void 0;
const starred = () => "starred";
exports.starred = starred;
const named = () => "named";
exports.named = named;
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
//# sourceMappingURL=leaf.js.map