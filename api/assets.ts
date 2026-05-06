import { Redis } from "@upstash/redis";
import { waitUntil } from "@vercel/functions";
// @ts-expect-error Server route imports the live snapshot builder from a runtime-authored .mjs module.
import { fetchSolanaAssetSnapshot } from "../scripts/refresh-solana-universe.mjs";
import type { AssetSnapshotPayload } from "../src/types";

const DEFAULT_CACHE_TTL_SECONDS = 3_600;
const DEFAULT_MAX_STALE_SECONDS = 86_400;
const DEFAULT_RECORD_TTL_SECONDS = 93_600;
const DEFAULT_LOCK_SECONDS = 300;
const DEFAULT_LOCK_WAIT_MS = 7_500;
const DEFAULT_LOCK_POLL_MS = 500;
const DEFAULT_KEY_PREFIX = "tokens-loans:assets:v1";
const RESPONSE_CACHE_CONTROL = "public, max-age=0, s-maxage=60, stale-while-revalidate=300";

type CacheStatus = "hit" | "miss" | "stale";

type RedisSnapshotRecord = {
  payload: AssetSnapshotPayload;
  cachedAt: string;
  lastRefreshStartedAt?: string;
  lastRefreshError?: string | null;
};

let redisClient: Redis | null = null;
let localSnapshotCache: {
  record: RedisSnapshotRecord | null;
  promise: Promise<RedisSnapshotRecord> | null;
} = {
  record: null,
  promise: null,
};

function integerEnv(name: string, fallback: number) {
  const raw = process.env[name];
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function stringEnv(name: string, fallback: string) {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

function cacheTtlSeconds() {
  return integerEnv("ASSETS_API_CACHE_TTL_SECONDS", DEFAULT_CACHE_TTL_SECONDS);
}

function maxStaleSeconds() {
  return integerEnv(
    "ASSETS_API_MAX_STALE_SECONDS",
    integerEnv("ASSETS_API_STALE_SECONDS", DEFAULT_MAX_STALE_SECONDS),
  );
}

function recordTtlSeconds() {
  return integerEnv("ASSETS_API_REDIS_RECORD_TTL_SECONDS", DEFAULT_RECORD_TTL_SECONDS);
}

function lockSeconds() {
  return integerEnv("ASSETS_API_REDIS_LOCK_SECONDS", DEFAULT_LOCK_SECONDS);
}

function lockWaitMs() {
  return integerEnv("ASSETS_API_LOCK_WAIT_MS", DEFAULT_LOCK_WAIT_MS);
}

function lockPollMs() {
  return integerEnv("ASSETS_API_LOCK_POLL_MS", DEFAULT_LOCK_POLL_MS);
}

function isLocalDevelopment() {
  return !process.env.VERCEL && process.env.NODE_ENV !== "production";
}

function isRedisConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function getRedis() {
  if (!isRedisConfigured()) {
    throw new Error("Upstash Redis is not configured.");
  }

  if (!redisClient) {
    redisClient = Redis.fromEnv();
  }

  return redisClient;
}

function runtimeEnvironment() {
  return process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
}

function keyPrefix() {
  return `${stringEnv("ASSETS_API_REDIS_KEY_PREFIX", DEFAULT_KEY_PREFIX)}:${runtimeEnvironment()}`;
}

function snapshotKey() {
  return `${keyPrefix()}:snapshot`;
}

function refreshLockKey() {
  return `${keyPrefix()}:refresh-lock`;
}

function nowIso() {
  return new Date().toISOString();
}

function cacheAgeSeconds(cachedAt: string) {
  const ageMs = Date.now() - new Date(cachedAt).getTime();
  return Math.max(0, Math.floor(ageMs / 1_000));
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown cache error.";
}

function isAssetSnapshotPayload(value: unknown): value is AssetSnapshotPayload {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<AssetSnapshotPayload>;
  return Boolean(
    candidate.meta &&
      typeof candidate.meta.generatedAt === "string" &&
      Array.isArray(candidate.assets) &&
      typeof candidate.mode === "string" &&
      typeof candidate.source === "string",
  );
}

function isRedisSnapshotRecord(value: unknown): value is RedisSnapshotRecord {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<RedisSnapshotRecord>;
  return typeof candidate.cachedAt === "string" && isAssetSnapshotPayload(candidate.payload);
}

function buildCachedPayload(record: RedisSnapshotRecord) {
  const warnings = [...(record.payload.warnings ?? [])];
  let mode: AssetSnapshotPayload["mode"] = "live";

  if (record.lastRefreshError) {
    mode = "partial";
    warnings.push(`Live refresh failed, so cached data is being served: ${record.lastRefreshError}`);
  }

  return {
    ...record.payload,
    mode,
    warnings,
  } satisfies AssetSnapshotPayload;
}

function dataResponse(payload: AssetSnapshotPayload, cacheStatus: CacheStatus, ageSeconds: number, init: ResponseInit = {}) {
  return Response.json(payload, {
    ...init,
    headers: {
      "Cache-Control": RESPONSE_CACHE_CONTROL,
      "X-Data-Cache": cacheStatus,
      "X-Data-Age-Seconds": String(ageSeconds),
      ...(init.headers ?? {}),
    },
  });
}

function errorResponse(message: string, details: string, status = 500) {
  return Response.json(
    { error: message, details },
    {
      status,
      headers: {
        "Cache-Control": "no-store, max-age=0, must-revalidate",
      },
    },
  );
}

async function fetchFreshPayload() {
  return fetchSolanaAssetSnapshot({
    mode: "live",
    source: "Live Jupiter + protocol snapshot",
    warnings: [],
  });
}

async function readRedisRecord() {
  const redis = getRedis();
  const raw = await redis.get<string>(snapshotKey());

  if (!raw || typeof raw !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRedisSnapshotRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeRedisRecord(record: RedisSnapshotRecord) {
  const redis = getRedis();
  await redis.set(snapshotKey(), JSON.stringify(record), { ex: recordTtlSeconds() });
}

async function acquireRedisRefreshLock() {
  const redis = getRedis();
  const result = await redis.set(refreshLockKey(), nowIso(), { nx: true, ex: lockSeconds() });
  return result === "OK";
}

async function releaseRedisRefreshLock() {
  try {
    await getRedis().del(refreshLockKey());
  } catch {
    // Ignore unlock failures so we do not mask the original response path.
  }
}

async function waitForRedisRecord(previousCachedAt: string | null) {
  const timeoutAt = Date.now() + lockWaitMs();

  while (Date.now() < timeoutAt) {
    await delay(lockPollMs());
    const record = await readRedisRecord();

    if (!record) {
      continue;
    }

    if (!previousCachedAt || new Date(record.cachedAt).getTime() > new Date(previousCachedAt).getTime()) {
      return record;
    }
  }

  return null;
}

async function writeFreshRedisRecord(startedAt: string) {
  const payload = await fetchFreshPayload();
  const record: RedisSnapshotRecord = {
    payload: {
      ...payload,
      mode: "live",
      warnings: payload.warnings ?? [],
    },
    cachedAt: nowIso(),
    lastRefreshStartedAt: startedAt,
    lastRefreshError: null,
  };

  await writeRedisRecord(record);
  return record;
}

async function markRedisRefreshStarted(record: RedisSnapshotRecord, startedAt: string) {
  await writeRedisRecord({
    ...record,
    lastRefreshStartedAt: startedAt,
  });
}

async function markRedisRefreshFailure(fallbackRecord: RedisSnapshotRecord | null, startedAt: string, error: unknown) {
  const latest = (await readRedisRecord()) ?? fallbackRecord;

  if (!latest) {
    return;
  }

  await writeRedisRecord({
    ...latest,
    lastRefreshStartedAt: startedAt,
    lastRefreshError: errorMessage(error),
  });
}

async function refreshRedisInBackground(fallbackRecord: RedisSnapshotRecord) {
  const startedAt = nowIso();

  try {
    await markRedisRefreshStarted(fallbackRecord, startedAt);
    await writeFreshRedisRecord(startedAt);
  } catch (error) {
    await markRedisRefreshFailure(fallbackRecord, startedAt, error);
  } finally {
    await releaseRedisRefreshLock();
  }
}

async function readLocalRecord() {
  return localSnapshotCache.record;
}

async function writeLocalRecord(record: RedisSnapshotRecord) {
  localSnapshotCache.record = record;
}

async function acquireLocalRefreshPromise(startedAt: string) {
  if (!localSnapshotCache.promise) {
    localSnapshotCache.promise = (async () => {
      const payload = await fetchFreshPayload();
      const record: RedisSnapshotRecord = {
        payload: {
          ...payload,
          mode: "live",
          warnings: payload.warnings ?? [],
        },
        cachedAt: nowIso(),
        lastRefreshStartedAt: startedAt,
        lastRefreshError: null,
      };

      localSnapshotCache.record = record;
      return record;
    })().finally(() => {
      localSnapshotCache.promise = null;
    });
  }

  return localSnapshotCache.promise;
}

async function refreshLocalInBackground(record: RedisSnapshotRecord) {
  const startedAt = nowIso();

  try {
    localSnapshotCache.record = {
      ...record,
      lastRefreshStartedAt: startedAt,
    };
    await acquireLocalRefreshPromise(startedAt);
  } catch (error) {
    localSnapshotCache.record = {
      ...(localSnapshotCache.record ?? record),
      lastRefreshStartedAt: startedAt,
      lastRefreshError: errorMessage(error),
    };
  }
}

async function getLocalSnapshot() {
  const record = await readLocalRecord();
  const maxAge = maxStaleSeconds();
  const freshAge = cacheTtlSeconds();

  if (!record) {
    const freshRecord = await acquireLocalRefreshPromise(nowIso());
    return { payload: buildCachedPayload(freshRecord), cacheStatus: "miss" as const, ageSeconds: 0 };
  }

  const ageSeconds = cacheAgeSeconds(record.cachedAt);

  if (ageSeconds <= freshAge) {
    return { payload: buildCachedPayload(record), cacheStatus: "hit" as const, ageSeconds };
  }

  if (ageSeconds <= maxAge) {
    void refreshLocalInBackground(record);
    return { payload: buildCachedPayload(record), cacheStatus: "stale" as const, ageSeconds };
  }

  try {
    const freshRecord = await acquireLocalRefreshPromise(nowIso());
    return { payload: buildCachedPayload(freshRecord), cacheStatus: "miss" as const, ageSeconds: 0 };
  } catch (error) {
    throw new Error(`Local refresh failed after cache expiry: ${errorMessage(error)}`);
  }
}

async function getRedisBackedSnapshot() {
  const record = await readRedisRecord();
  const freshAge = cacheTtlSeconds();
  const maxAge = maxStaleSeconds();

  if (!record) {
    const lockAcquired = await acquireRedisRefreshLock();

    if (!lockAcquired) {
      const awaitedRecord = await waitForRedisRecord(null);

      if (awaitedRecord) {
        return {
          payload: buildCachedPayload(awaitedRecord),
          cacheStatus: "miss" as const,
          ageSeconds: cacheAgeSeconds(awaitedRecord.cachedAt),
        };
      }

      throw new Error("Live refresh is already in progress, but no cache record became available in time.");
    }

    try {
      const freshRecord = await writeFreshRedisRecord(nowIso());
      return { payload: buildCachedPayload(freshRecord), cacheStatus: "miss" as const, ageSeconds: 0 };
    } finally {
      await releaseRedisRefreshLock();
    }
  }

  const ageSeconds = cacheAgeSeconds(record.cachedAt);

  if (ageSeconds <= freshAge) {
    return { payload: buildCachedPayload(record), cacheStatus: "hit" as const, ageSeconds };
  }

  if (ageSeconds <= maxAge) {
    const lockAcquired = await acquireRedisRefreshLock();

    if (lockAcquired) {
      waitUntil(refreshRedisInBackground(record));
    }

    return {
      payload: buildCachedPayload(record),
      cacheStatus: "stale" as const,
      ageSeconds,
    };
  }

  const lockAcquired = await acquireRedisRefreshLock();

  if (!lockAcquired) {
    const awaitedRecord = await waitForRedisRecord(record.cachedAt);

    if (awaitedRecord) {
      return {
        payload: buildCachedPayload(awaitedRecord),
        cacheStatus: "miss" as const,
        ageSeconds: cacheAgeSeconds(awaitedRecord.cachedAt),
      };
    }

    throw new Error("Cached token data expired and another refresh did not complete before the wait timeout.");
  }

  try {
    const freshRecord = await writeFreshRedisRecord(nowIso());
    return { payload: buildCachedPayload(freshRecord), cacheStatus: "miss" as const, ageSeconds: 0 };
  } finally {
    await releaseRedisRefreshLock();
  }
}

async function getSnapshot() {
  if (isLocalDevelopment() && !isRedisConfigured()) {
    return getLocalSnapshot();
  }

  if (!isRedisConfigured()) {
    throw new Error("Upstash Redis environment variables are missing.");
  }

  return getRedisBackedSnapshot();
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Cache-Control": "no-store, max-age=0, must-revalidate",
    },
  });
}

export async function GET() {
  try {
    const { payload, cacheStatus, ageSeconds } = await getSnapshot();
    return dataResponse(payload, cacheStatus, ageSeconds);
  } catch (error) {
    return errorResponse("Unable to load live token coverage.", errorMessage(error));
  }
}
