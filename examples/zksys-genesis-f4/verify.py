#!/usr/bin/env python3
"""Pure, read-only verification of the exact 2026-11-20 public Genesis F4 capture.

Zero RPC, wallet, Core changes, serialization mutation, signing or submission.
Its source-bound verdicts are *not* independent Gateway consensus, PoDA,
ChainLock, or real ZK cryptographic verification.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys
import zipfile

ZIP_SHA256 = "a223831d3a304737e0f9e5004b25ebc1e8f18a754679b13a4770e506462384d8"
DOCS_SHA = "6f14d9af42f5cc4412b79278b8e8380e78426b28"
NE_SHA = "90526c75ad869b46fc19a585f6cbccc083627890"
TX_GEN = "0xa018d61db50752eeda10c6d52b51fd1741cc8eb41db46d9b972677539d5fef0b"
TX_GATE = "0x321f5184dea2ff8026bc84b01df304c8936b139e64b25774ffd326853b2391d9"
TX_RANGE = "0x4661a9f890147e1ceb4dc8647eeba801ec206d4a318b299083c291b89f9820f3"
TX_PROOF = "0xc82091801f6b0947db4bed5fb2400e07313e2730b0c37d389d2b3c5dba9fdde0"
TX_EXEC = "0x6498e1f4bd29000890343b377d9790b2a63db10e03d3d25fcd5ea1f9ed4f29e6"
GATE_EMITTER = "0x77484ccec0657a23d84809fe48d3f8201955c04d"
NEVM_EMITTER = "0x2d2d8853f547ee15e7c90997e1d74aafa607050c"
TOPIC_EXEC = "0x2402307311a4d6604e4e7b4c8a15a7e1213edb39c16a31efa70afb06030d3165"
TOPIC_RANGE = "0xa2ac105688fc09c2584d6b2e79dd0fc14e6003a20c62ac45aa858e8ed12bb7bb"
TOPIC_COMMIT = "0x8f2916b2f2d78cc5890ead36c06c0f6d5d112c7e103589947e8e2f0d6eddb763"
TOPIC_VERIFY = "0x22c9005dd88c18b552a1cd7e8b3b937fcde9ca69213c1f658f54d572e4877a81"


class EvidenceMismatch(ValueError):
    pass


def require(test: bool, name: str) -> None:
    if not test:
        raise EvidenceMismatch(name)


def object_no_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
    obj: dict[str, object] = {}
    for name, value in pairs:
        require(name not in obj, "DUPLICATE_JSON_PROPERTY:" + name)
        obj[name] = value
    return obj


def parse(raw: bytes) -> object:
    return json.loads(raw.decode("utf-8"), object_pairs_hook=object_no_duplicates)


def lower(x: object) -> str:
    require(isinstance(x, str), "EXPECTED_STRING")
    return x.lower()


def number(x: object) -> int:
    if isinstance(x, int) and not isinstance(x, bool):
        require(x >= 0, "NEGATIVE_INT")
        return x
    require(isinstance(x, str) and x.startswith("0x") and len(x)>2,
            "BAD_HEX_QUANTITY")
    return int(x, 16)


def bytes32(x: object) -> str:
    val = lower(x)
    require(val.startswith("0x") and len(val)==66, "INVALID_BYTES32")
    bytes.fromhex(val[2:])
    return val


def txid(x: object) -> str:
    return bytes32(x)


def get_source(name: str, originals: dict[str, bytes]) -> object:
    return parse(originals["capture/"+name+".response.json"])


def result(name: str, originals: dict[str, bytes]) -> dict:
    envelope = get_source(name, originals)
    require(isinstance(envelope, dict) and envelope.get("jsonrpc")=="2.0" and envelope.get("id")==1,
            name+":INVALID_RPC_ENVELOPE")
    require(envelope.get("error") is None, name+":RPC_ERROR")
    res=envelope.get("result")
    require(isinstance(res, dict), name+":EMPTY_RESULT")
    return res


def maybe_result(name: str, originals: dict[str, bytes]) -> object:
    envelope = get_source(name, originals)
    require(isinstance(envelope, dict) and envelope.get("jsonrpc")=="2.0" and envelope.get("id")==1,
            name+":INVALID_RPC_ENVELOPE")
    require(envelope.get("error") is None, name+":RPC_ERROR")
    return envelope.get("result")


def from_zip(path: Path) -> dict[str, bytes]:
    raw=path.read_bytes()
    require(hashlib.sha256(raw).hexdigest()==ZIP_SHA256, "WRONG_OR_CORRUPT_ORIGINAL_ZIP")
    require(len(raw)==25976, "UNEXPECTED_ZIP_SIZE")
    with zipfile.ZipFile(path) as z:
        names=z.namelist()
        require(len(names)==36 and len(names)==len(set(names)), "UNEXPECTED_ZIP_INVENTORY")
        for name in names:
            posix=PurePosixPath(name)
            require(not name.startswith("/") and ".." not in posix.parts and
                    (name.startswith("capture/") or name in ("capture-summary.log","CAPTURE_SCOPE.txt")),
                    "UNSAFE_ZIP_ENTRY")
            require(z.getinfo(name).file_size <= 1_000_000, "UNBOUNDED_ZIP_ENTRY")
        originals={name:z.read(name) for name in names}
    manifest=originals["capture/FILE_HASHES.sha256"].decode("utf-8")
    pins={}
    for line in manifest.splitlines():
        sha,sep,name=line.partition("  ")
        require(sep=="  " and len(sha)==64 and name and "/" not in name and name not in pins,
                "BAD_SOURCE_PIN")
        pins[name]=sha
    require(len(pins)==33, "WRONG_SOURCE_PIN_COUNT")
    for name,digest in pins.items():
        require(hashlib.sha256(originals["capture/"+name]).hexdigest()==digest,
                "SOURCE_SHA256_MISMATCH:"+name)
    report=parse(originals["capture/REPORT.json"])
    require(isinstance(report, dict), "REPORT_MISSING")
    require(report.get("documentation_sha")==DOCS_SHA and report.get("ne_public_sha")==NE_SHA,
            "SOURCE_REVISION_MISMATCH")
    require((report.get("complete_http_response_count"), report.get("rpc_errors"), report.get("unavailable"))==(19,0,0),
            "INCOMPLETE_CAPTURE")
    require(len(report["requests"])==19, "WRONG_REQUEST_COUNT")
    # Cross-check every original HTTP body against the independently recorded capture report.
    for name,record in report["requests"].items():
        if name+".response.json" not in pins:
            raise EvidenceMismatch("RESPONSE_NOT_PINNED:"+name)
        require(record["response_sha256"]==pins[name+".response.json"],
                "REPORT_VS_MANIFEST_MISMATCH:"+name)
    return originals


def pick(logs: list[dict], sig: str, source: str) -> dict:
    matches=[x for x in logs if x.get("topics") and lower(x["topics"][0])==sig]
    require(len(matches)==1, source+":EVENT_NOT_UNIQUE:"+sig)
    return matches[0]


def topics(log: dict) -> list[str]:
    return [lower(t) for t in log["topics"] if t is not None]


def index_logs(name: str, originals: dict[str, bytes]) -> list[dict]:
    page=get_source(name, originals)
    require(isinstance(page,dict) and isinstance(page.get("items"),list) and page.get("next_page_params") is None,
            name+":INDEX_PAGINATION_OR_FORMAT")
    return page["items"]


def crosscheck_rpc_index(prefix: str, originals: dict[str, bytes], hash_: str, height: int) -> tuple[dict,dict,list[dict]]:
    rpc=result("nevm-"+prefix+"-receipt", originals)
    transaction=result("nevm-"+prefix+"-transaction", originals)
    require(txid(rpc.get("transactionHash"))==hash_ and txid(transaction.get("hash"))==hash_, prefix+":WRONG_TX")
    require(number(rpc.get("blockNumber"))==height==number(transaction.get("blockNumber")), prefix+":BLOCK_HEIGHT_MISMATCH")
    require(bytes32(rpc.get("blockHash"))==bytes32(transaction.get("blockHash")),prefix+":BLOCK_HASH_MISMATCH")
    require(number(rpc.get("status"))==1 and number(transaction.get("chainId"))==5700,prefix+":RPC_EXECUTION_OR_CHAIN_MISMATCH")
    rlogs=rpc.get("logs")
    idx=index_logs("nevm-"+prefix+"-logs-index",originals)
    require(isinstance(rlogs,list) and len(rlogs)==len(idx), prefix+":LOG_COUNT_MISMATCH")
    indices=set()
    for ix in idx:
        k=number(ix["index"])
        require(k not in indices, prefix+":DUPLICATE_LOG_INDEX")
        indices.add(k)
        rpc_log=next((a for a in rlogs if number(a["logIndex"])==k),None)
        require(rpc_log is not None,prefix+":INDEX_WITHOUT_RPC_LOG")
        require(txid(ix["transaction_hash"])==hash_ and number(ix["block_number"])==height,prefix+":INDEX_CONTEXT_MISMATCH")
        require(bytes32(ix["block_hash"])==bytes32(rpc_log["blockHash"]),prefix+":INDEX_BLOCK_HASH_MISMATCH")
        require(lower(ix["address"]["hash"])==lower(rpc_log["address"])==NEVM_EMITTER,prefix+":EMITTER_MISMATCH")
        require(topics(ix)==topics(rpc_log),prefix+":TOPICS_MISMATCH")
        require(lower(ix["data"])==lower(rpc_log["data"]),prefix+":LOG_DATA_MISMATCH")
    return rpc, transaction, rlogs


def abi_word(data: bytes, pos: int) -> int:
    require(0<=pos and pos+32<=len(data), "ABI_OUT_OF_BOUNDS")
    return int.from_bytes(data[pos:pos+32],"big")


def abi_mock_proof(tx_input: str, commit: dict) -> dict:
    require(tx_input.startswith("0x") and len(tx_input)%2==0,"BAD_CALLDATA")
    raw=bytes.fromhex(tx_input[2:])
    require(raw[:4]==bytes.fromhex("9271e450"),"WRONG_PROVE_SELECTOR")
    head=raw[4:]
    require(len(head)>=160 and abi_word(head,32)==9448 and abi_word(head,64)==9448,"WRONG_OUTER_BATCH")
    offset=abi_word(head,96)
    require(offset==128,"WRONG_OUTER_ABI_OFFSET")
    length=abi_word(head,offset)
    require(length>=1 and offset+32+length<=len(head),"BAD_INNER_LENGTH")
    encoded=head[offset+32:offset+32+length]
    require(encoded[:1]==b"\x01","WRONG_PROVE_ENCODING_VERSION")
    inner=encoded[1:]
    require(len(inner)%32==0 and len(inner)>=11*32,"BAD_INNER_ABI")
    require(abi_word(inner,0)==9447,"WRONG_PREVIOUS_BATCH")
    batchoff=abi_word(inner,9*32)
    proofoff=abi_word(inner,10*32)
    require(batchoff==11*32 and proofoff%32==0 and proofoff>batchoff+32,"BAD_ARRAY_OFFSETS")
    require(abi_word(inner,batchoff)==1,"WRONG_BATCH_COUNT")
    batch=[abi_word(inner,batchoff+32+i*32) for i in range(9)]
    require(batch[0]==9448,"WRONG_INNER_BATCH")
    require(batch[1]==int(commit["topics"][2],16) and batch[8]==int(commit["topics"][3],16),
            "PROOF_VS_COMMIT_MISMATCH")
    count=abi_word(inner,proofoff)
    require(count==4 and proofoff+32+count*32==len(inner),"WRONG_PROOF_WORD_COUNT")
    words=[abi_word(inner,proofoff+32+i*32) for i in range(count)]
    require(words[:3]==[0x803,0,13],"NOT_V8_MOCK_TYPE_3")
    # Do not call this cryptographic verification: only the mock encoding is decoded.
    return {"version":8,"mock_proof_type":3,"proof_word_count":count,
            "previous_batch":9447,"new_batch":9448,"folded_input_word":hex(words[3])}


def verify_edges(originals: dict[str, bytes]) -> dict:
    require(number(maybe_result("genesis-chain-id",originals))==57057,"GENESIS_CHAIN_ID")
    require(number(maybe_result("nevm-chain-id",originals))==5700,"NEVM_CHAIN_ID")
    g_receipt=result("genesis-receipt",originals)
    g_tx=result("genesis-transaction",originals)
    g_block=result("genesis-block-by-hash",originals)
    require(txid(g_receipt["transactionHash"])==TX_GEN==txid(g_tx["hash"]),"GENESIS_TX_ID")
    require(number(g_receipt["status"])==1,"GENESIS_EXECUTION_FAILED")
    require(number(g_receipt["blockNumber"])==number(g_tx["blockNumber"])==number(g_block["number"])==10968,"GENESIS_BLOCK_HEIGHT")
    require(bytes32(g_receipt["blockHash"])==bytes32(g_tx["blockHash"])==bytes32(g_block["hash"]),"GENESIS_BLOCK_HASH")
    require(number(g_tx["chainId"])==57057,"GENESIS_TX_CHAIN_ID")
    require(isinstance(g_block["transactions"],list) and TX_GEN in [lower(h) for h in g_block["transactions"]],"GENESIS_BLOCK_TX_ABSENT")
    batch_a=originals["capture/batch-zks_getBatchByBlockNumber.response.json"]
    batch_b=originals["capture/batch-unstable_getBatchByBlockNumber.response.json"]
    require(batch_a==batch_b,"BATCH_RPC_METHODS_DIFFER")
    batch=result("batch-zks_getBatchByBlockNumber",originals)
    require(batch==result("batch-unstable_getBatchByBlockNumber",originals),"BATCH_RPC_METHOD_SEMANTICS_DIFFER")
    require(batch["batch_info"]["batch_number"]==10436,"BAD_EDGE_BATCH")
    require(batch["block_range"]["start"]<=10968<=batch["block_range"]["end"],"EDGE_HEIGHT_NOT_IN_RANGE")
    require(batch["execute_sl_block_number"]==31362,"GATEWAY_EXECUTION_HEIGHT_DISAGREES")
    state=bytes32(batch["batch_info"]["state_commitment"])
    commitment=bytes32(batch["batch_info"]["commitment"])
    gateway=index_logs("gateway-execution-logs-index", originals)
    gw_tx=get_source("gateway-execution-tx-index",originals)
    require(txid(gw_tx["hash"])==TX_GATE and gw_tx["status"]=="ok","GATEWAY_INDEX_TX_STATUS")
    gw=pick(gateway,TOPIC_EXEC,"GATEWAY")
    require(lower(gw["address"]["hash"])==GATE_EMITTER,"GATEWAY_WRONG_EMITTER")
    require(txid(gw["transaction_hash"])==TX_GATE and number(gw["block_number"])==31362,"GATEWAY_WRONG_TX_OR_BLOCK")
    require(len(topics(gw))==4 and number(gw["topics"][1])==10436,"GATEWAY_WRONG_BATCH")
    require(bytes32(gw["topics"][2])==state and bytes32(gw["topics"][3])==commitment,"GATEWAY_COMMITMENT_MISMATCH")
    _,tx_commit,range_logs=crosscheck_rpc_index("range",originals,TX_RANGE,1009176)
    range_ev=pick(range_logs,TOPIC_RANGE,"NEVM_RANGE")
    commit_ev=pick(range_logs,TOPIC_COMMIT,"NEVM_COMMIT")
    range_values=[number(x) for x in range_ev["topics"][1:]]
    require(len(topics(range_ev))==4 and range_values==[9448,31360,31362],"GATEWAY_BATCH_RANGE_INCORRECT")
    require(range_values[1]<=number(gw["block_number"])<=range_values[2],"GATEWAY_BLOCK_OUTSIDE_RANGE")
    require(len(topics(commit_ev))==4 and number(commit_ev["topics"][1])==9448,"GATEWAY_BATCH_COMMIT_INCORRECT")
    _,tx_proof,proof_logs=crosscheck_rpc_index("proof",originals,TX_PROOF,1009179)
    prove=pick(proof_logs,TOPIC_VERIFY,"NEVM_PROOF")
    require([number(x) for x in topics(prove)[1:]]==[9447,9448],"PROOF_BATCH_INTERVAL_INCORRECT")
    mock=abi_mock_proof(tx_proof["input"],commit_ev)
    _,tx_exec,exec_logs=crosscheck_rpc_index("execution",originals,TX_EXEC,1009182)
    executed=pick(exec_logs,TOPIC_EXEC,"NEVM_EXECUTION")
    require(len(topics(executed))==4 and [lower(x) for x in executed["topics"][1:]]==[lower(x) for x in commit_ev["topics"][1:]],"GATEWAY_BATCH_EXEC_COMMIT_MISMATCH")
    claims=[]
    def add(prop: str, verdict: str, basis: str, scope: str) -> None:
        claims.append({"proposition":prop,"verdict":verdict,"evidence_basis":basis,"scope":scope})
    add("genesis.exact_transaction_execution","supported","source_observation","Genesis RPC receipt+tx+block at 2026-11-20 capture")
    add("genesis.height_to_reported_batch","supported","deterministic_derivation","Both Genesis batch RPCs returned the same source values at height 10968; no hash binding")
    add("genesis.batch_to_gateway_indexed_execution","supported","deterministic_derivation","Gateway public index matches batch, emitter, state and commitment; NOT independent Gateway consensus")
    add("gateway.indexed_block_in_nevm_batch_range","supported","deterministic_derivation","Gateway block 31362 within NEVM on-chain reported range 31360..31362")
    add("nevm.batch_mock_proof_acceptance","supported","deterministic_derivation","Observed BlocksVerification and decoded V8 MOCK TYPE3 calldata; NOT cryptographic real proof")
    add("nevm.batch_execution_commitment_match","supported","deterministic_derivation","NEVM receipt logs and explorer logs agree, matching BlockCommit hash+commitment")
    for prop in ("core.poda_bytes_and_canonical_inclusion","core.chainlock_finality", "nevm.historical_active_verifier_contract", "zk.real_cryptographic_proof_verified", "destination.withdrawal_effect"):
        add(prop,"insufficient","source_observation","No independently sufficient evidence in this exact F4 capture")
    return {"schema":"ne-zksys-f4-offline-source-join/v0.1","archive_sha256":ZIP_SHA256,
            "docs_sha":DOCS_SHA,"ne_source_sha":NE_SHA,"mock_proof":mock,
            "supported":sum(c["verdict"]=="supported" for c in claims),
            "insufficient":sum(c["verdict"]=="insufficient" for c in claims),
            "claims":claims,"limitations":["No independent Gateway node consensus", "No Core PoDA raw byte retrieval or ChainLock", "Mock verifier does not establish a real ZK cryptographic proof", "No destination withdrawal or physical-world outcome"]}


def tamper_tests(originals: dict[str, bytes]) -> int:
    tests=[]
    def replaced(name: str, edit) -> dict[str, bytes]:
        key="capture/"+name+".response.json"
        obj=deepcopy(parse(originals[key]))
        edit(obj)
        result_map=dict(originals)
        result_map[key]=(json.dumps(obj,sort_keys=True,separators=(",",":"))+"\n").encode()
        return result_map
    def reject(label: str, altered: dict[str, bytes]):
        try: verify_edges(altered)
        except (EvidenceMismatch, KeyError, ValueError, TypeError, AssertionError):
            tests.append(label); return
        raise AssertionError("TAMPER_NOT_REJECTED:"+label)
    reject("wrong_chain_id",replaced("genesis-chain-id",lambda x:x.__setitem__("result","0x1")))
    reject("wrong_genesis_block_hash",replaced("genesis-receipt",lambda x:x["result"].__setitem__("blockHash","0x"+"a"*64)))
    reject("incorrect_batch_state",replaced("batch-zks_getBatchByBlockNumber",lambda x:x["result"]["batch_info"].__setitem__("state_commitment","0x"+"b"*64)))
    reject("wrong_gateway_emitter",replaced("gateway-execution-logs-index",lambda x:next(y for y in x["items"] if y["topics"][0]==TOPIC_EXEC)["address"].__setitem__("hash","0x"+"c"*40)))
    reject("wrong_gateway_batch",replaced("gateway-execution-logs-index",lambda x:next(y for y in x["items"] if y["topics"][0]==TOPIC_EXEC)["topics"].__setitem__(1,"0x"+format(10437,"064x"))))
    reject("range_does_not_cover_gateway",replaced("nevm-range-receipt",lambda x:next(y for y in x["result"]["logs"] if y["topics"][0]==TOPIC_RANGE)["topics"].__setitem__(3,"0x"+format(31361,"064x"))))
    reject("changed_nevm_commitment",replaced("nevm-execution-receipt",lambda x:next(y for y in x["result"]["logs"] if y["topics"][0]==TOPIC_EXEC)["topics"].__setitem__(3,"0x"+"d"*64)))
    reject("indexer_diverges_from_rpc",replaced("nevm-range-logs-index",lambda x:x["items"][0]["topics"].__setitem__(1,"0x"+format(9449,"064x"))))
    def flip_proof(x):
        raw=bytearray.fromhex(x["result"]["input"][2:]); head=raw[4:]
        outer=abi_word(head,96); inneroff=4+outer+32+1
        proof_offset=abi_word(raw[inneroff:],10*32)
        first=inneroff+proof_offset+32
        raw[first:first+32]=(0x802).to_bytes(32,"big")
        x["result"]["input"]="0x"+raw.hex()
    reject("non_mock_proof_type",replaced("nevm-proof-transaction",flip_proof))
    reject("wrong_execution_batch",replaced("nevm-execution-receipt",lambda x:next(y for y in x["result"]["logs"] if y["topics"][0]==TOPIC_EXEC)["topics"].__setitem__(1,"0x"+format(9449,"064x"))))
    reject("wrong_tx_id",replaced("nevm-proof-transaction",lambda x:x["result"].__setitem__("hash","0x"+"e"*64)))
    assert len(tests)==11
    return len(tests)


def main(argv: list[str]) -> int:
    if len(argv) not in (2,3):
        print("Usage: verify_zksys_genesis_f4.py ORIGINAL_PUBLIC_CAPTURE.zip [OUTPUT.json]",file=sys.stderr)
        return 2
    originals=from_zip(Path(argv[1]))
    report=verify_edges(originals)
    count=tamper_tests(originals)
    report["negative_tests_passed"]=count
    if len(argv)==3:
        Path(argv[2]).write_text(json.dumps(report,sort_keys=True,indent=2)+"\n")
    print("F4_OFFLINE_SOURCE_JOINS_PASS",f"supported={report['supported']}",
          f"insufficient={report['insufficient']}",f"tamper_rejected={count}")
    return 0


if __name__=="__main__":
    try: sys.exit(main(sys.argv))
    except (EvidenceMismatch, KeyError, ValueError, TypeError, zipfile.BadZipFile) as e:
        print("F4_OFFLINE_SOURCE_JOINS_FAIL",type(e).__name__,str(e)[:200],file=sys.stderr)
        sys.exit(1)
