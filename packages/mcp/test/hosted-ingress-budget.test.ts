import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startNeMcpHttpServer } from "../src/http.js";
import type { NeMcpHttpServer } from "../src/http.js";
import { GlobalAbuseLimiter, HOSTED_DEFAULT_LIMITS, resolveLimits } from "../src/limits.js";
import { SOLANA_NETWORKS, SOLANA_RESPONSE_MAX_BYTES, restrictedSolanaRpcFetch } from "../src/live-solana.js";

const HOST = "mcp.example.org";
const NETWORK = "solana-mainnet" as const;
const URL = SOLANA_NETWORKS[NETWORK].url;
const VALID_RPC = JSON.stringify({jsonrpc:"2.0",id:1,method:"getGenesisHash",params:[]});
const OPENAI_SAFE_HEADERS={"host":HOST,"content-type":"application/json",
  "mcp-protocol-version":"2025-11-25","accept":"application/json,text/event-stream"};

async function post(port:number,body:string):Promise<{status:number,body:string}>{
 return new Promise((resolve,reject)=>{
  const req=httpRequest({host:"127.0.0.1",port,path:"/mcp",method:"POST",
   headers:{...OPENAI_SAFE_HEADERS,"content-length":String(Buffer.byteLength(body))}},res=>{
   const parts:Buffer[]=[];
   res.on("data",(x:Buffer)=>parts.push(x));
   res.on("end",()=>resolve({status:res.statusCode??0,body:Buffer.concat(parts).toString("utf8")}));
  });
  req.on("error",reject);req.end(body);
 });
}

function rpcResponse(body: ReadableStream<Uint8Array>, length?:string):Response{
 const r=new Response(body,{status:200,headers:{"content-type":"application/json",...(length===undefined?{}:{"content-length":length})}});
 Object.defineProperty(r,"url",{value:new globalThis.URL(URL).href});
 Object.defineProperty(r,"redirected",{value:false});
 Object.defineProperty(r,"clone",{value:()=>{throw Error("UNBOUNDED_RESPONSE_TEE_FORBIDDEN");}});
 return r;
}

describe("hosted HTTP JSON-RPC ingress admission — each request must mean ONE operation",()=>{
 let server:NeMcpHttpServer;
 beforeAll(async()=>{server=await startNeMcpHttpServer({
  host:"127.0.0.1",port:0,hosted:{publicOrigin:"https://"+HOST},
  limits:{maxConcurrent:2,maxRequestsPerMinute:24},
 });});
 afterAll(async()=>{await server.close();});
 it("rejects a two-call batch BEFORE SDK dispatch so one HTTP quota cannot fund many tools",async()=>{
  const request={jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"list_network_profiles",arguments:{}}};
  const result=await post(server.port,JSON.stringify([request,{...request,id:2}]));
  expect(result.status).toBe(400);
  expect(result.body).toContain("JSON-RPC");
  expect(result.body).not.toContain("network-evidence");
 });
 it("rejects mixed notifications/calls, arrays and empty batches but preserves single calls",async()=>{
  const request={jsonrpc:"2.0",id:3,method:"tools/list"};
  for(const bad of [[],[request],[request,{jsonrpc:"2.0",method:"notifications/initialized"}]]){
   const r=await post(server.port,JSON.stringify(bad));
   expect(r.status).toBe(400);
   expect(r.body).not.toContain("tools");
  }
  const good=await post(server.port,JSON.stringify(request));
  expect(good.status).toBe(200);
  expect(good.body).toContain("list_network_profiles");
 });
 it("refuses infinite subscription streams without blocking a single-concurrency hosted MCP client",async()=>{
  const solo=await startNeMcpHttpServer({
   host:"127.0.0.1",port:0,hosted:{publicOrigin:"https://"+HOST},
   limits:{maxConcurrent:1,maxRequestsPerMinute:4},
  });
  try{
   const listen=await post(solo.port,JSON.stringify({jsonrpc:"2.0",id:17,method:"subscriptions/listen",params:{}}));
   expect(listen.status).toBe(200);
   expect(JSON.parse(listen.body)).toEqual({
    jsonrpc:"2.0",id:17,error:{code:-32601,message:"subscriptions/listen is unavailable on this stateless server"},
   });
   // A rejected indefinite subscription must release the sole request slot.
   const tools=await post(solo.port,JSON.stringify({jsonrpc:"2.0",id:18,method:"tools/list"}));
   expect(tools.status).toBe(200);
   // The legacy SDK may return JSON-RPC over text/event-stream when Accept allows SSE.
   expect(tools.body).toContain("list_network_profiles");
   const invalid=await post(solo.port,JSON.stringify({jsonrpc:"2.0",id:{spoof:true},method:"subscriptions/listen"}));
   expect(invalid.status).toBe(400);
   const last=await post(solo.port,JSON.stringify({jsonrpc:"2.0",id:19,method:"tools/list"}));
   expect(last.status).toBe(200);
   // Refusal still consumes an HTTP admission, preventing quota bypass.
   const over=await post(solo.port,JSON.stringify({jsonrpc:"2.0",id:20,method:"tools/list"}));
   expect(over.status).toBe(429);
  }finally{await solo.close();}
 });
});

const LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

function ingressRequest(port: number, body: string | Buffer = LIST, method = "POST", headers: Record<string, string> = {}, headersOnly = false) {
  return new Promise<{ status: number; body: string; retryAfter: string | undefined }>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/mcp", method, agent: false,
      headers: { ...OPENAI_SAFE_HEADERS, connection: "close", ...headers } }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (chunk: Buffer) => parts.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString(), retryAfter: res.headers["retry-after"] });
        req.destroy();
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(7_000, () => req.destroy(new Error("ingress response not received")));
    if (headersOnly) req.flushHeaders();
    else req.end(body);
  });
}

async function incompletePost(port: number) {
  const socket = connect({ host: "127.0.0.1", port });
  let bytes = "";
  let closedAt: number | undefined;
  socket.on("data", (chunk) => { bytes += chunk.toString(); });
  // A reset can accompany the server's close when unread body bytes remain.
  socket.on("error", () => {});
  socket.once("close", () => { closedAt = performance.now(); });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const started = performance.now();
  socket.write(`POST /mcp HTTP/1.1\r\nHost: ${HOST}\r\nContent-Type: application/json\r\nContent-Length: 100\r\nConnection: close\r\n\r\n` + "x".repeat(16));
  return { socket, started, get bytes() { return bytes; }, get closedAt() { return closedAt; } };
}

function hostedIngress(maxConcurrent: number, maxRequestsPerMinute: number) {
  return startNeMcpHttpServer({ host: "127.0.0.1", port: 0, hosted: { publicOrigin: "https://" + HOST },
    limits: { maxConcurrent, maxRequestsPerMinute } });
}

describe("SEC-01 reservation and body deadlines", () => {
  for (const trickle of [false, true]) {
    it(trickle
      ? "T2: a trickled POST body is cut by an absolute deadline, not an idle timeout"
      : "T1: an incomplete POST body answers 408 and frees the sole /mcp slot within 6 s", { timeout: 20_000 }, async () => {
      const solo = await hostedIngress(1, 24);
      let pending: Awaited<ReturnType<typeof incompletePost>> | undefined;
      let interval: ReturnType<typeof setInterval> | undefined;
      try {
        pending = await incompletePost(solo.port);
        const held = pending;
        if (trickle) interval = setInterval(() => { if (!held.socket.destroyed) held.socket.write("x"); }, 1_000);
        await delay(100);
        expect((await ingressRequest(solo.port)).status).toBe(429);
        await expect.poll(() => held.closedAt, { timeout: 6_000, interval: 20 }).toBeDefined();
        expect(held.closedAt! - held.started).toBeLessThanOrEqual(6_000);
        if (!trickle || held.bytes.length > 0) expect(held.bytes).toMatch(/^HTTP\/1\.1 408/);
        if (!trickle) {
          expect(held.bytes.toLowerCase()).toContain("connection: close");
          expect(held.bytes).toContain('"code":-32000');
          expect(held.bytes).toContain("Request Timeout: request body not received in time");
        }
        // All 24 charges remain available after the timeout and concurrent 429.
        for (let i = 0; i < 24; i++) expect((await ingressRequest(solo.port)).status).toBe(200);
        expect((await ingressRequest(solo.port)).status).toBe(429);
      } finally {
        clearInterval(interval);
        pending?.socket.destroy();
        await solo.close();
      }
    });
  }

  it("T3: non-POST, 415, 413 and 400 refusals do not consume the window; batch and subscription refusals still do", { timeout: 20_000 }, async () => {
    const solo = await hostedIngress(2, 3);
    try {
      for (let i = 0; i < 3; i++) expect((await ingressRequest(solo.port, "", "GET")).status).toBe(405);
      expect((await ingressRequest(solo.port, "{}", "POST", { "content-type": "text/plain" })).status).toBe(415);
      for (const bad of ["not json", '{"id":1,"id":2}', Buffer.from([0xff])]) {
        expect((await ingressRequest(solo.port, bad)).status).toBe(400);
      }
      expect((await ingressRequest(solo.port, "", "POST", { "content-length": "1048577" }, true)).status).toBe(413);
      for (let i = 0; i < 3; i++) expect((await ingressRequest(solo.port)).status).toBe(200);
      const refused = await ingressRequest(solo.port);
      expect(refused.status).toBe(429);
      expect(refused.retryAfter).toMatch(/^\d+$/);
      expect(Number(refused.retryAfter)).toBeGreaterThanOrEqual(1);
      expect(Number(refused.retryAfter)).toBeLessThanOrEqual(60);
    } finally { await solo.close(); }
    const charged = await hostedIngress(2, 2);
    try {
      expect((await ingressRequest(charged.port, `[${LIST}]`)).status).toBe(400);
      expect((await ingressRequest(charged.port, JSON.stringify({ jsonrpc: "2.0", id: 2, method: "subscriptions/listen" }))).status).toBe(200);
      expect((await ingressRequest(charged.port)).status).toBe(429);
    } finally { await charged.close(); }
  });

  it("T4: reserve holds a slot without charging; charge is idempotent, re-rolls and refuses a spent window", () => {
    let now = 1_000;
    const limiter = new GlobalAbuseLimiter(resolveLimits({ maxConcurrent: 2, maxRequestsPerMinute: 1 }, HOSTED_DEFAULT_LIMITS), () => now);
    const a = limiter.reserve();
    const b = limiter.reserve();
    if (!a.ok || !b.ok) throw new Error("expected two reservations");
    expect(limiter.current).toEqual({ inFlight: 2, windowCount: 0 });
    expect(limiter.reserve()).toEqual({ ok: false, retryAfterSeconds: 1 });
    expect(a.charge()).toEqual({ ok: true });
    expect(a.charge()).toEqual({ ok: true });
    now += 15_000;
    expect(b.charge()).toEqual({ ok: false, retryAfterSeconds: 45 });
    expect(b.charge()).toEqual({ ok: false, retryAfterSeconds: 45 });
    b.release(); b.release();
    expect(limiter.reserve()).toEqual({ ok: false, retryAfterSeconds: 45 });
    expect(limiter.current).toEqual({ inFlight: 1, windowCount: 1 });
    a.release(); a.release();
    now += 45_000;
    const c = limiter.reserve();
    if (!c.ok) throw new Error("expected reservation in new window");
    expect(limiter.current).toEqual({ inFlight: 1, windowCount: 0 });
    expect(c.charge()).toEqual({ ok: true });
    c.release();
    now += 60_000;
    const d = limiter.reserve();
    const e = limiter.reserve();
    if (!d.ok || !e.ok) throw new Error("expected reservations before rollover");
    expect(e.charge()).toEqual({ ok: true });
    e.release();
    expect(d.charge()).toEqual({ ok: false, retryAfterSeconds: 60 });
    now += 60_000;
    // A reservation held across rollover must charge the new, empty window.
    expect(d.charge()).toEqual({ ok: true });
    expect(limiter.current).toEqual({ inFlight: 1, windowCount: 1 });
    // Repeating a successful charge across a window boundary never charges again.
    now += 60_000;
    const f = limiter.reserve();
    if (!f.ok) throw new Error("expected reservation after rollover");
    expect(d.charge()).toEqual({ ok: true });
    expect(limiter.current).toEqual({ inFlight: 2, windowCount: 0 });
    expect(f.charge()).toEqual({ ok: true });
    d.release(); f.release();
    expect(limiter.current).toEqual({ inFlight: 0, windowCount: 1 });
    expect(Object.keys(limiter).sort()).toEqual(["inFlight", "limits", "now", "windowCount", "windowStart"]);
  });

  it("G1: a full window refuses an unread body before reading it", { timeout: 20_000 }, async () => {
    const solo = await hostedIngress(1, 1);
    try {
      expect((await ingressRequest(solo.port)).status).toBe(200);
      const started = performance.now();
      const refused = await ingressRequest(solo.port, "", "POST", { "content-length": "1048576" }, true);
      expect(refused.status).toBe(429);
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally { await solo.close(); }
  });

  it("G2: client abort releases the sole slot within one second", { timeout: 20_000 }, async () => {
    const solo = await hostedIngress(1, 24);
    let pending: Awaited<ReturnType<typeof incompletePost>> | undefined;
    try {
      pending = await incompletePost(solo.port);
      await delay(200);
      expect((await ingressRequest(solo.port)).status).toBe(429);
      const started = performance.now();
      pending.socket.destroy();
      await expect.poll(async () => (await ingressRequest(solo.port)).status, { timeout: 900, interval: 20 }).toBe(200);
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      pending?.socket.destroy();
      await solo.close();
    }
  });
});

describe("bounded fixed-source Solana provider fetch cannot clone/tee response bodies",()=>{
 it("accepts bounded valid JSON without ever invoking clone()",async()=>{
  let requests=0;
  const inner:typeof fetch=async()=>{requests++;return rpcResponse(new ReadableStream({
   start(ctrl){ctrl.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":"some_genesis"}'));ctrl.close();}
  }));};
  const guarded=restrictedSolanaRpcFetch(inner,NETWORK);
  const res=await guarded(URL,{method:"POST",body:VALID_RPC});
  expect(await res.text()).toContain("some_genesis");
  expect(requests).toBe(1);
 });
 it("caps a headerless streaming provider before materializing more than 800kB, cancelling the original stream",async()=>{
  let cancellations=0;
  let reads=0;
  const chunk=new Uint8Array(128*1024).fill(120);
  const provider=new ReadableStream<Uint8Array>({
   pull(ctrl){
    reads++;
    ctrl.enqueue(chunk);
    if(reads>12)ctrl.close();
   },
   cancel(){cancellations++;}
  },{highWaterMark:1});
  const guarded=restrictedSolanaRpcFetch(async()=>rpcResponse(provider),NETWORK);
  await expect(guarded(URL,{method:"POST",body:VALID_RPC}))
   .rejects.toMatchObject({code:"MCP_MULTICHAIN_TOO_LARGE"});
  expect(cancellations).toBeGreaterThan(0);
  expect(reads).toBeLessThan(12);
 });
 it("aborts a provider that stalls AFTER headers, even if mocked fetch ignores the AbortSignal",async()=>{
  let cancelled=0;
  const hanging=new ReadableStream<Uint8Array>({
   start(){ /* provider sends headers, but never responds with body bytes */ },
   cancel(){cancelled++;}
  });
  const controller=new AbortController();
  const guarded=restrictedSolanaRpcFetch(async()=>rpcResponse(hanging),NETWORK);
  const pending=guarded(URL,{method:"POST",body:VALID_RPC,signal:controller.signal});
  // This is a caller cancellation; the real deadline is the same combined
  // AbortSignal (8 seconds) and must reach the original reader as well.
  setImmediate(()=>controller.abort());
  await expect(pending).rejects.toMatchObject({code:"MCP_MULTICHAIN_SOURCE_FAILED"});
  expect(cancelled).toBe(1);
 });

 it("keeps SDK-only Solana signature-list RPC excluded from hosted live method allowlist",async()=>{
  let reads=0;
  const inner:typeof fetch=async()=>{reads++;throw Error("should never reach provider");};
  const guarded=restrictedSolanaRpcFetch(inner,NETWORK);
  const unsafe=JSON.stringify({jsonrpc:"2.0",id:1,method:"getBlock",params:[
   418897974,{commitment:"finalized",transactionDetails:"signatures",rewards:false,maxSupportedTransactionVersion:0},
  ]});
  await expect(guarded(URL,{method:"POST",body:unsafe}))
   .rejects.toMatchObject({code:"MCP_MULTICHAIN_SOURCE_FAILED"});
  expect(reads).toBe(0);
 });
 it("cancels rejected 503 source bodies, sanitizes errors and never discloses provider text",async()=>{
  const secret="PROVIDER_PRIVATE_CREDENTIAL_EXAMPLE";
  let cancelled=0;
  const inner:typeof fetch=async()=>{
   const body=new ReadableStream<Uint8Array>({
    start(c){c.enqueue(new TextEncoder().encode(secret));},
    cancel(){cancelled++;}
   });
   const response=new Response(body,{status:503});
   Object.defineProperty(response,"url",{value:new globalThis.URL(URL).href});
   return response;
  };
  const guarded=restrictedSolanaRpcFetch(inner,NETWORK);
  let caught:unknown;
  try{await guarded(URL,{method:"POST",body:VALID_RPC});}catch(error){caught=error;}
  expect(caught).toMatchObject({code:"MCP_MULTICHAIN_SOURCE_FAILED"});
  expect(String(caught)).not.toContain(secret);
  expect(cancelled).toBe(1);
 });

 it("rejects declared oversized provider content-length without reading it",async()=>{
  let reads=0;
  const provider=new ReadableStream<Uint8Array>({pull(){reads++;}});
  const guarded=restrictedSolanaRpcFetch(async()=>rpcResponse(provider,String(SOLANA_RESPONSE_MAX_BYTES+1)),NETWORK);
  await expect(guarded(URL,{method:"POST",body:VALID_RPC}))
   .rejects.toMatchObject({code:"MCP_MULTICHAIN_TOO_LARGE"});
  expect(reads).toBeLessThanOrEqual(1);
 });
});
