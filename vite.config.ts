import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const snapshotScriptUrl = pathToFileURL(path.resolve(__dirname, "scripts", "refresh-solana-universe.mjs")).href;
const RESPONSE_CACHE_CONTROL = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";

type DevSnapshotPayload = {
  mode?: string;
  warnings?: string[];
};

function integerEnv(name: string, fallback: number) {
  const raw = process.env[name];
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function jsonResponse(
  res: import("node:http").ServerResponse,
  statusCode: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", RESPONSE_CACHE_CONTROL);

  for (const [key, value] of Object.entries(extraHeaders)) {
    res.setHeader(key, value);
  }

  res.end(JSON.stringify(payload));
}

function enrichSnapshot(snapshot: unknown, lastRefreshError: string | null) {
  const record = snapshot as DevSnapshotPayload;
  const warnings = [...(record.warnings ?? [])];

  if (lastRefreshError) {
    warnings.push(`Live refresh failed, so cached data is being served: ${lastRefreshError}`);
  }

  return {
    ...(snapshot as Record<string, unknown>),
    mode: lastRefreshError ? "partial" : "live",
    warnings,
  };
}

function tokensLoansDevApi(): Plugin {
  let snapshotCache: {
    snapshot: unknown;
    fetchedAt: number;
    lastRefreshError: string | null;
    promise: Promise<unknown> | null;
  } = {
    snapshot: null,
    fetchedAt: 0,
    lastRefreshError: null,
    promise: null,
  };

  async function refreshSnapshot() {
    if (!snapshotCache.promise) {
      snapshotCache.promise = import(snapshotScriptUrl)
        .then((module) =>
          module.fetchSolanaAssetSnapshot({
            mode: "live",
            source: "Live Jupiter + protocol snapshot",
            warnings: [],
          }),
        )
        .then((snapshot) => {
          snapshotCache = {
            snapshot,
            fetchedAt: Date.now(),
            lastRefreshError: null,
            promise: null,
          };
          return snapshot;
        })
        .catch((error) => {
          snapshotCache.promise = null;
          throw error;
        });
    }

    return snapshotCache.promise;
  }

  return {
    name: "tokens-loans-dev-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const requestUrl = req.url?.split("?")[0];

        if (requestUrl !== "/api/assets") {
          next();
          return;
        }

        if (req.method === "OPTIONS") {
          res.statusCode = 204;
          res.setHeader("Cache-Control", "no-store, max-age=0, must-revalidate");
          res.end();
          return;
        }

        if (req.method !== "GET") {
          jsonResponse(res, 405, { error: "Method not allowed." }, { "Cache-Control": "no-store, max-age=0, must-revalidate" });
          return;
        }

        const now = Date.now();
        const ageMs = snapshotCache.snapshot ? now - snapshotCache.fetchedAt : Infinity;
        const ageSeconds = String(Math.max(0, Math.floor(ageMs / 1_000)));
        const ttlMs = integerEnv("ASSETS_API_CACHE_TTL_SECONDS", 3_600) * 1_000;
        const staleMs =
          integerEnv("ASSETS_API_MAX_STALE_SECONDS", integerEnv("ASSETS_API_STALE_SECONDS", 86_400)) * 1_000;

        if (snapshotCache.snapshot && ageMs <= ttlMs) {
          jsonResponse(res, 200, enrichSnapshot(snapshotCache.snapshot, snapshotCache.lastRefreshError), {
            "X-Data-Cache": "hit",
            "X-Data-Age-Seconds": ageSeconds,
          });
          return;
        }

        if (snapshotCache.snapshot && ageMs <= ttlMs + staleMs) {
          void refreshSnapshot().catch((error) => {
            snapshotCache.lastRefreshError = error instanceof Error ? error.message : "Unknown live fetch error.";
          });

          jsonResponse(res, 200, enrichSnapshot(snapshotCache.snapshot, snapshotCache.lastRefreshError), {
            "X-Data-Cache": "stale",
            "X-Data-Age-Seconds": ageSeconds,
          });
          return;
        }

        try {
          const snapshot = await refreshSnapshot();
          jsonResponse(res, 200, enrichSnapshot(snapshot, snapshotCache.lastRefreshError), {
            "X-Data-Cache": "miss",
            "X-Data-Age-Seconds": "0",
          });
        } catch (error) {
          jsonResponse(
            res,
            500,
            {
              error: "Unable to load live token coverage.",
              details: error instanceof Error ? error.message : "Unknown API error.",
            },
            {
              "Cache-Control": "no-store, max-age=0, must-revalidate",
            },
          );
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tokensLoansDevApi()],
});
