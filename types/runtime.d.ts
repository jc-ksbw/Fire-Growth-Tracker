interface D1ResultMeta { changes?: number }
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: D1ResultMeta }>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<unknown>;
}
interface Fetcher { fetch(request: Request): Promise<Response> }

declare module "cloudflare:workers" {
  export const env: { DB: D1Database; [key: string]: unknown };
}

declare module "gifenc" {
  export function GIFEncoder(): {
    writeFrame(indexed: Uint8Array, width: number, height: number, options: { palette?: number[][]; delay?: number; repeat?: number }): void;
    finish(): void;
    bytes(): Uint8Array;
  };
  export function quantize(pixels: Uint8ClampedArray, colors: number): number[][];
  export function applyPalette(pixels: Uint8ClampedArray, palette: number[][]): Uint8Array;
}
