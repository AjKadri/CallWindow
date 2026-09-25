import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPreStocksQuote, getSupportedDemoCatalog } from "./market.mjs";
import {
  AuctionRoomError,
  claimTestAssets,
  getDistributorStatus,
  getSharedDistributorStatus,
  readConfiguredMarketAuction,
  readLiveAuctionRoom,
  validateMarketAuctionForDistribution,
} from "./auction-room.mjs";

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

async function readRequestBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 16_384) throw new AuctionRoomError("Request body is too large.", 413);
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new AuctionRoomError("Request body must be valid JSON.", 400);
  }
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
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/api/auction-room/claim") {
      try {
        const body = await readRequestBody(request);
        sendJson(response, 200, await claimTestAssets(body.wallet, body.auctionAddress ?? null, body.symbol ?? null));
      } catch (error) {
        const statusCode = error instanceof AuctionRoomError ? error.statusCode : 500;
        sendJson(response, statusCode, {
          status: "unavailable",
          reason: error.message || "Test-asset distribution failed.",
        });
      }
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET, POST" }).end();
      return;
    }
    if (url.pathname === "/api/market") {
      sendJson(response, 200, await getSupportedDemoCatalog(fetchImpl));
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
      const liveRoom = await readLiveAuctionRoom();
      sendJson(response, 200, historicalProof
        ? {
          status: "available",
          network: "devnet",
          liveRoom,
          distributor: await getDistributorStatus(liveRoom),
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
          liveRoom,
          distributor: await getDistributorStatus(liveRoom),
          reason: "No tracked public devnet proof is available in this checkout yet.",
        });
      return;
    }
    if (url.pathname === "/api/auction-room/shared-status") {
      sendJson(response, 200, await getSharedDistributorStatus(url.searchParams.get("auctionAddress")));
      return;
    }
    if (url.pathname === "/api/auction-room/market-status") {
      const symbol = url.searchParams.get("symbol") ?? "";
      const auctionAddress = url.searchParams.get("auctionAddress");
      if (!symbol) {
        sendJson(response, 400, { status: "unavailable", reason: "A supported PreStocks product symbol is required." });
        return;
      }
      if (!auctionAddress) {
        const configured = await readConfiguredMarketAuction(symbol);
        if (!configured) {
          sendJson(response, 200, { status: "unavailable", symbol, reason: "No shared Devnet window is configured for this product yet. Create the first funded window from this Demo." });
          return;
        }
        try {
          const target = await validateMarketAuctionForDistribution(configured.auctionAddress, symbol, {
            marketFetchImpl: fetchImpl,
            requireOpen: false,
          });
          const distributor = await getSharedDistributorStatus(configured.auctionAddress, { symbol, marketFetchImpl: fetchImpl });
          sendJson(response, 200, {
            symbol,
            auctionAddress: target.auctionAddress,
            network: "devnet",
            state: target.record.state,
            cutoffTime: target.record.cutoffTime.toString(),
            distributor,
          });
        } catch (error) {
          sendJson(response, 200, { status: "unavailable", symbol, reason: error.message ?? "The configured market window could not be verified." });
        }
        return;
      }
      sendJson(response, 200, { symbol, ...(await getSharedDistributorStatus(auctionAddress, { symbol, marketFetchImpl: fetchImpl })) });
      return;
    }
    await serveStatic(response, url.pathname);
  });
}
