import type { NeMapsCaseCollectionV01 } from "./contracts/case-envelope.js";

export declare const NE_MAPS_CASE_SCHEMA_VERSION: "ne-maps-case/v0.1";
export declare const NE_MAPS_COLLECTION_SCHEMA_VERSION: "ne-maps-case-collection/v0.1";
export declare const NE_MAPS_LIMITS: Readonly<{ maxCases: number; maxStringLength: number; maxDepth: number }>;

export declare class NeMapsValidationError extends TypeError {
  readonly path: string;
  constructor(path: string, message: string);
}

export interface NeMapsCollectionValidationOptionsV01 {
  /** Additional Lens validator, e.g. public @nec/lens validateLensBrowserSafeCaseV01. */
  validateLens?: (lens: unknown, path: string) => void;
}

export declare function assertLensRenderableV01(lens: unknown, path?: string): void;
export declare function validateNeMapsCollectionV01(
  value: unknown,
  options?: NeMapsCollectionValidationOptionsV01,
): NeMapsCaseCollectionV01;
