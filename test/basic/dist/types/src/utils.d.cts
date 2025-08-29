/**
 * Utility functions for the test library
 */
export declare const loadDocumentation: () => Promise<string>;
export declare const formatMessage: (message: string) => string;
export declare const isProduction: () => boolean;
export declare const delay: (ms: number) => Promise<void>;
export interface Logger {
    log(message: string): void;
    error(message: string): void;
}
export declare class ConsoleLogger implements Logger {
    log(message: string): void;
    error(message: string): void;
}
//# sourceMappingURL=utils.d.ts.map