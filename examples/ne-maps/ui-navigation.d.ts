export type NeMapsCollectionScope = "mine" | "examples";
export type NeMapsCaseView = "lens" | "trail" | "action";

export type NeMapsRouteState =
  | { kind: "atlas"; scope: NeMapsCollectionScope }
  | { kind: "detail"; scope: NeMapsCollectionScope; caseId: string; view: NeMapsCaseView };

export declare function parseCaseHash(hash: unknown): NeMapsRouteState;
