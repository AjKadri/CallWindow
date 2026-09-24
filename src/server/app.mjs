import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPreStocksCatalog, getPreStocksQuote } from "./market.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WEB_ROOT = existsSync(path.join(ROOT, "dist", "index.html"))
  ? path.join(ROOT, "dist")
  : path.join(ROOT, "web");

const MIME = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readPublicDevnetProof() {
  const proofPaths = [
    path.join(ROOT, "dist", "devnet-proof.json"),
    path.join(ROOT, "web", "public", "devnet-proof.json"),
  ];
  for (const proofPath of proofPaths) {
    try {
      return JSON.parse(await readFile(proofPath, "utf8"));
    } catch {}
  }
  return null;
}

async function serveStatic(response, pathname) {
  let requestedPath;
  try {
    requestedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }
  const relativePath = requestedPath === "/" ? "index.html" : requestedPath.slice(1);
  let absolutePath = path.resolve(WEB_ROOT, relativePath);
  if (absolutePath !== WEB_ROOT && !absolutePath.startsWith(`${WEB_ROOT}${path.sep}`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const fileInfo = await stat(absolutePath);
    if (fileInfo.isDirectory()) absolutePath = path.join(absolutePath, "index.html");
    const body = await readFile(absolutePath);
    response.writeHead(200, {
      "content-type": MIME.get(path.extname(absolutePath)) ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
  }
}

export function createCallWindowServer({ fetchImpl = fetch } = {}) {
  return createServer(async (request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" }).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/market") {
      sendJson(response, 200, await getPreStocksCatalog(fetchImpl));
      return;
    }
    if (url.pathname === "/api/quote") {
      const side = url.searchParams.get("side");
      const amount = url.searchParams.get("amount");
      const symbol = url.searchParams.get("symbol");
      const mint = url.searchParams.get("mint");
      if (!side || !amount || !symbol || !mint) {
        sendJson(response, 400, {
          status: "unavailable",
          source: "https://api.jup.ag/swap/v2/order",
          observedAt: new Date().toISOString(),
          reason: "Provide a verified product symbol, mint, quote direction, and input size",
          failureType: "invalid-input",
        });
        return;
      }
      sendJson(response, 200, await getPreStocksQuote({ symbol, mint, side, amount }, { fetchImpl }));
      return;
    }
    if (url.pathname === "/api/devnet") {
      const historicalProof = await readPublicDevnetProof();
      sendJson(response, 200, historicalProof
        ? {
          status: "available",
          network: "devnet",
          historicalProof,
          currentReference: {
            network: historicalProof.network,
            programId: historicalProof.program.address,
            programDataAddress: historicalProof.program.programDataAddress,
            auctionAddress: historicalProof.historicalAuction.address,
            mints: historicalProof.historicalAuction.mints,
          },
        }
        : {
          status: "unavailable",
          network: "devnet",
          reason: "No tracked public devnet proof is available in this checkout yet.",
        });
      return;
    }
    await serveStatic(response, url.pathname);
  });
}
