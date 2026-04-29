export type Foo = { bar: string };
export interface Baz {
  qux: number;
}
export const enum Direction {
  Up = "UP",
  Down = "DOWN",
}
export type { Logger } from "./utils.ts";

type DefaultWithTypeExports = {
  (input: Foo): Baz;
};

export default DefaultWithTypeExports;
