import { parseGenesisHash, parsePublicKey, parseSignature, decodeBase58 } from "./base58.js";
import { NecResolverSolanaError, solanaFail } from "./errors.js";

export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const TRANSFER_CHECKED_DISCRIMINATOR = 12;

export type TransactionVersion = "legacy" | 0;
export type InstructionLocation =
  | { readonly kind: "topLevel"; readonly topLevelIndex: number; readonly stackHeight?: number }
  | { readonly kind: "inner"; readonly parentTopLevelIndex: number; readonly innerIndex: number; readonly stackHeight?: number };

export interface TransferCheckedObservation {
  readonly tokenProgram: typeof SPL_TOKEN_PROGRAM | typeof TOKEN_2022_PROGRAM;
  readonly mint: string;
  readonly source: string;
  readonly destination: string;
  readonly authority: string;
  readonly amount: string;
  readonly decimals: number;
  readonly location: InstructionLocation;
}

export interface SolanaTransactionObservation {
  readonly slot: bigint;
  readonly blockTime: number | null;
  readonly version: TransactionVersion;
  readonly signatures: readonly string[];
  readonly recentBlockhash: string;
  readonly feePayer: string;
  readonly effectiveAccountKeys: readonly string[];
  readonly successful: boolean;
  readonly executionError: unknown;
  readonly transferChecked: readonly TransferCheckedObservation[];
  /** True only when the RPC response explicitly carried CPI trace metadata. */
  readonly instructionTraceComplete: boolean;
}

export interface SolanaSignatureStatusObservation {
  readonly contextSlot: bigint;
  readonly value: null | {
    readonly slot: bigint;
    readonly confirmations: number | null;
    readonly err: unknown;
    readonly confirmationStatus: "processed" | "confirmed" | "finalized" | null;
  };
}

export interface SolanaBlockObservation {
  readonly blockhash: string;
  readonly previousBlockhash: string;
  readonly parentSlot: bigint;
  readonly blockTime: number | null;
  readonly blockHeight: bigint | null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) solanaFail("SOLANA_MALFORMED_RESPONSE", `${label}: must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) solanaFail("SOLANA_MALFORMED_RESPONSE", `${label}: must be an array`);
  return value;
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) solanaFail("SOLANA_MALFORMED_RESPONSE", `${label}: must be a non-negative safe integer`);
  return value;
}

function nullableTime(value: unknown, label: string): number | null {
  return value === null ? null : safeInteger(value, label);
}

function responsePublicKey(value: unknown, label: string): string {
  try { return parsePublicKey(value, label); } catch (error) {
    if (error instanceof NecResolverSolanaError) solanaFail("SOLANA_MALFORMED_RESPONSE", error.message);
    throw error;
  }
}

function responseSignature(value: unknown, label: string): string {
  try { return parseSignature(value, label); } catch (error) {
    if (error instanceof NecResolverSolanaError) solanaFail("SOLANA_MALFORMED_RESPONSE", error.message);
    throw error;
  }
}

export function parseGenesisHashResult(value: unknown): string {
  try { return parseGenesisHash(value, "getGenesisHash.result"); } catch (error) {
    if (error instanceof NecResolverSolanaError) solanaFail("SOLANA_MALFORMED_RESPONSE", error.message);
    throw error;
  }
}

function parseVersion(value: unknown): TransactionVersion {
  if (value === "legacy") return "legacy";
  if (value === 0) return 0;
  throw new NecResolverSolanaError("SOLANA_UNSUPPORTED_TRANSACTION_VERSION", `unsupported transaction version ${JSON.stringify(value)}`);
}

function decodedData(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string") solanaFail("SOLANA_MALFORMED_RESPONSE", `${label}.data: must be base58 text`);
  if (value === "") return new Uint8Array();
  try { return decodeBase58(value, `${label}.data`); } catch (error) {
    if (error instanceof NecResolverSolanaError) solanaFail("SOLANA_MALFORMED_RESPONSE", error.message);
    throw error;
  }
}

function instructionIndexes(value: unknown, label: string, keyCount: number): number[] {
  return array(value, `${label}.accounts`).map((entry, index) => {
    const accountIndex = safeInteger(entry, `${label}.accounts[${index}]`);
    if (accountIndex >= keyCount) solanaFail("SOLANA_MALFORMED_RESPONSE", `${label}.accounts[${index}]: account index out of range`);
    return accountIndex;
  });
}

function decodeInstruction(
  value: unknown,
  label: string,
  keys: readonly string[],
  location: InstructionLocation,
): TransferCheckedObservation | null {
  const instruction = record(value, label);
  const programIdIndex = safeInteger(instruction.programIdIndex, `${label}.programIdIndex`);
  if (programIdIndex >= keys.length) solanaFail("SOLANA_MALFORMED_RESPONSE", `${label}.programIdIndex: program index out of range`);
  const accounts = instructionIndexes(instruction.accounts, label, keys.length);
  const data = decodedData(instruction.data, label);
  const program = keys[programIdIndex] as string;
  if (program !== SPL_TOKEN_PROGRAM && program !== TOKEN_2022_PROGRAM) return null;
  if (data.length === 0 || data[0] !== TRANSFER_CHECKED_DISCRIMINATOR) return null;
  if (data.length !== 10 || accounts.length < 4) solanaFail("SOLANA_MALFORMED_RESPONSE", `${label}: malformed TransferChecked instruction`);
  let amount = 0n;
  for (let i = 0; i < 8; i++) amount |= BigInt(data[i + 1] as number) << BigInt(i * 8);
  return {
    tokenProgram: program,
    source: keys[accounts[0] as number] as string,
    mint: keys[accounts[1] as number] as string,
    destination: keys[accounts[2] as number] as string,
    authority: keys[accounts[3] as number] as string,
    amount: amount.toString(),
    decimals: data[9] as number,
    location,
  };
}

function optionalStackHeight(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return safeInteger(value, `${label}.stackHeight`);
}

export function parseTransactionResult(value: unknown): SolanaTransactionObservation | null {
  if (value === null) return null;
  const root = record(value, "getTransaction.result");
  const slot = BigInt(safeInteger(root.slot, "transaction.slot"));
  const version = parseVersion(root.version);
  const transaction = record(root.transaction, "transaction.transaction");
  const signatures = array(transaction.signatures, "transaction.signatures").map((v, i) => responseSignature(v, `transaction.signatures[${i}]`));
  if (signatures.length === 0) solanaFail("SOLANA_MALFORMED_RESPONSE", "transaction.signatures: must not be empty");
  const message = record(transaction.message, "transaction.message");
  const staticKeys = array(message.accountKeys, "transaction.message.accountKeys").map((v, i) => responsePublicKey(v, `transaction.message.accountKeys[${i}]`));
  if (staticKeys.length === 0) solanaFail("SOLANA_MALFORMED_RESPONSE", "transaction.message.accountKeys: must not be empty");
  const meta = record(root.meta, "transaction.meta");
  const lookups = message.addressTableLookups === undefined ? [] : array(message.addressTableLookups, "transaction.message.addressTableLookups");
  let loadedWritable: string[] = [];
  let loadedReadonly: string[] = [];
  if (version === 0) {
    if (lookups.length > 0 && (meta.loadedAddresses === undefined || meta.loadedAddresses === null)) {
      throw new NecResolverSolanaError("SOLANA_INCOMPLETE_ACCOUNT_KEYS", "version-0 transaction uses ALTs but resolved loadedAddresses are absent");
    }
    if (meta.loadedAddresses !== undefined && meta.loadedAddresses !== null) {
      const loaded = record(meta.loadedAddresses, "transaction.meta.loadedAddresses");
      loadedWritable = array(loaded.writable, "transaction.meta.loadedAddresses.writable").map((v, i) => responsePublicKey(v, `loadedAddresses.writable[${i}]`));
      loadedReadonly = array(loaded.readonly, "transaction.meta.loadedAddresses.readonly").map((v, i) => responsePublicKey(v, `loadedAddresses.readonly[${i}]`));
    }
    let expectedWritable = 0;
    let expectedReadonly = 0;
    for (let i = 0; i < lookups.length; i++) {
      const lookup = record(lookups[i], `addressTableLookups[${i}]`);
      responsePublicKey(lookup.accountKey, `addressTableLookups[${i}].accountKey`);
      expectedWritable += array(lookup.writableIndexes, `addressTableLookups[${i}].writableIndexes`).map((v, j) => safeInteger(v, `addressTableLookups[${i}].writableIndexes[${j}]`)).length;
      expectedReadonly += array(lookup.readonlyIndexes, `addressTableLookups[${i}].readonlyIndexes`).map((v, j) => safeInteger(v, `addressTableLookups[${i}].readonlyIndexes[${j}]`)).length;
    }
    if (expectedWritable !== loadedWritable.length || expectedReadonly !== loadedReadonly.length) {
      throw new NecResolverSolanaError("SOLANA_INCOMPLETE_ACCOUNT_KEYS", "resolved loadedAddresses do not cover the complete ALT-derived account space");
    }
  } else if (lookups.length > 0) {
    solanaFail("SOLANA_MALFORMED_RESPONSE", "legacy transaction cannot carry address table lookups");
  }
  const keys = [...staticKeys, ...loadedWritable, ...loadedReadonly];
  const transfers: TransferCheckedObservation[] = [];
  const topLevel = array(message.instructions, "transaction.message.instructions");
  for (let i = 0; i < topLevel.length; i++) {
    const inst = record(topLevel[i], `topLevel[${i}]`);
    const stackHeight = optionalStackHeight(inst.stackHeight, `topLevel[${i}]`);
    const decoded = decodeInstruction(inst, `topLevel[${i}]`, keys, { kind: "topLevel", topLevelIndex: i, ...(stackHeight === undefined ? {} : { stackHeight }) });
    if (decoded) transfers.push(decoded);
  }
  // An explicit empty array is an observed complete-empty CPI trace. A
  // null/absent field is not equivalent: top-level instructions remain
  // usable, but no conclusion may assume there were no unreported CPIs.
  const instructionTraceComplete = Array.isArray(meta.innerInstructions);
  const innerGroups: unknown[] = instructionTraceComplete ? meta.innerInstructions as unknown[] : [];
  const seenParents = new Set<number>();
  for (let g = 0; g < innerGroups.length; g++) {
    const group = record(innerGroups[g], `innerInstructions[${g}]`);
    const parent = safeInteger(group.index, `innerInstructions[${g}].index`);
    if (parent >= topLevel.length || seenParents.has(parent)) solanaFail("SOLANA_MALFORMED_RESPONSE", `innerInstructions[${g}]: invalid or duplicate parent index`);
    seenParents.add(parent);
    const instructions = array(group.instructions, `innerInstructions[${g}].instructions`);
    for (let i = 0; i < instructions.length; i++) {
      const inst = record(instructions[i], `innerInstructions[${g}].instructions[${i}]`);
      const stackHeight = optionalStackHeight(inst.stackHeight, `innerInstructions[${g}].instructions[${i}]`);
      const decoded = decodeInstruction(inst, `innerInstructions[${g}].instructions[${i}]`, keys, { kind: "inner", parentTopLevelIndex: parent, innerIndex: i, ...(stackHeight === undefined ? {} : { stackHeight }) });
      if (decoded) transfers.push(decoded);
    }
  }
  return {
    slot,
    blockTime: nullableTime(root.blockTime, "transaction.blockTime"),
    version,
    signatures,
    recentBlockhash: responsePublicKey(message.recentBlockhash, "transaction.message.recentBlockhash"),
    feePayer: staticKeys[0] as string,
    effectiveAccountKeys: keys,
    successful: meta.err === null,
    executionError: meta.err,
    transferChecked: transfers,
    instructionTraceComplete,
  };
}

export function parseSignatureStatusesResult(value: unknown): SolanaSignatureStatusObservation {
  const root = record(value, "getSignatureStatuses.result");
  const context = record(root.context, "signatureStatuses.context");
  const values = array(root.value, "signatureStatuses.value");
  if (values.length !== 1) solanaFail("SOLANA_MALFORMED_RESPONSE", "signatureStatuses.value must contain exactly one entry");
  const entry = values[0];
  if (entry === null) return { contextSlot: BigInt(safeInteger(context.slot, "signatureStatuses.context.slot")), value: null };
  const status = record(entry, "signatureStatuses.value[0]");
  const confirmation = status.confirmationStatus;
  if (confirmation !== null && confirmation !== "processed" && confirmation !== "confirmed" && confirmation !== "finalized") solanaFail("SOLANA_MALFORMED_RESPONSE", "invalid confirmationStatus");
  const confirmations = status.confirmations;
  if (confirmations !== null) safeInteger(confirmations, "signatureStatuses.value[0].confirmations");
  return {
    contextSlot: BigInt(safeInteger(context.slot, "signatureStatuses.context.slot")),
    value: {
      slot: BigInt(safeInteger(status.slot, "signatureStatuses.value[0].slot")),
      confirmations: confirmations as number | null,
      err: status.err,
      confirmationStatus: confirmation,
    },
  };
}

export function parseBlockResult(value: unknown): SolanaBlockObservation | null {
  if (value === null) return null;
  const block = record(value, "getBlock.result");
  const height = block.blockHeight;
  return {
    blockhash: responsePublicKey(block.blockhash, "block.blockhash"),
    previousBlockhash: responsePublicKey(block.previousBlockhash, "block.previousBlockhash"),
    parentSlot: BigInt(safeInteger(block.parentSlot, "block.parentSlot")),
    blockTime: nullableTime(block.blockTime, "block.blockTime"),
    blockHeight: height === null ? null : BigInt(safeInteger(height, "block.blockHeight")),
  };
}
