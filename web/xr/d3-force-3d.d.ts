// d3-force-3d ships no types; the worker uses a small part of it.
declare module "d3-force-3d" {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  export function forceSimulation(nodes?: any[], numDimensions?: number): any;
  export function forceLink(links?: any[]): any;
  export function forceManyBody(): any;
  export function forceCenter(x?: number, y?: number, z?: number): any;
}
