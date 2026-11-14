// Messages between the page and the core worker. Every core call is listed
// here once, so the worker and the client cannot drift apart.

export interface CoreApi {
  coreVersion(): string;
  /** Six numbers per edge: ax, ay, ra, bx, by, rb (mm). */
  medialAxisOfRing(ring: Float64Array): Float64Array;
}

export type CoreMethod = keyof CoreApi;

export interface CoreRequest<M extends CoreMethod = CoreMethod> {
  id: number;
  method: M;
  args: Parameters<CoreApi[M]>;
}

export type CoreResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };
