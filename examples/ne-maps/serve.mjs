import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
const port = Number(process.env.PORT || 4177);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };

const server = createServer(async (req, res) => {
  try {
    const raw = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    const relative = normalize(raw).replace(/^([.][.][/\\])+/, "").replace(/^[/\\]+/, "");
    let file = join(root, relative || "index.html");
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found\n");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`NE Maps: http://127.0.0.1:${port}/`);
});
