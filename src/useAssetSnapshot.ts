import { useEffect, useState } from "react";
import type { AssetSnapshotMode, AssetSnapshotPayload } from "./types";

const LIVE_SNAPSHOT_URL = "/api/assets";

type SnapshotState = {
  snapshot: AssetSnapshotPayload | null;
  status: AssetSnapshotMode | "loading";
  isRefreshing: boolean;
  error: string | null;
};

let cachedSnapshot: AssetSnapshotPayload | null = null;
let liveRequest: Promise<AssetSnapshotPayload> | null = null;

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

async function fetchSnapshot(url: string, fallbackMode: AssetSnapshotMode, fallbackSource: string) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Snapshot request failed with ${response.status}`);
  }

  const payload = (await response.json()) as unknown;

  if (!isAssetSnapshotPayload(payload)) {
    throw new Error("Snapshot payload was malformed");
  }

  return {
    ...payload,
    mode: payload.mode ?? fallbackMode,
    source: payload.source ?? fallbackSource,
    warnings: payload.warnings ?? [],
  } satisfies AssetSnapshotPayload;
}

async function loadLiveSnapshot() {
  if (!liveRequest) {
    liveRequest = fetchSnapshot(LIVE_SNAPSHOT_URL, "live", "Live protocol snapshot").finally(() => {
      liveRequest = null;
    });
  }

  const snapshot = await liveRequest;
  cachedSnapshot = snapshot;
  return snapshot;
}

export function snapshotStatusLabel(status: AssetSnapshotMode | "loading") {
  if (status === "loading") {
    return "Loading";
  }

  if (status === "partial") {
    return "Partial";
  }

  if (status === "snapshot") {
    return "Snapshot";
  }

  return "Live";
}

export function useAssetSnapshot() {
  const [state, setState] = useState<SnapshotState>(() => ({
    snapshot: cachedSnapshot,
    status: cachedSnapshot?.mode ?? "loading",
    isRefreshing: true,
    error: null,
  }));

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const liveSnapshot = await loadLiveSnapshot();

        if (cancelled) {
          return;
        }

        setState({
          snapshot: liveSnapshot,
          status: liveSnapshot.mode,
          isRefreshing: false,
          error: null,
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        setState((current) => ({
          snapshot: current.snapshot,
          status: current.snapshot ? "partial" : "loading",
          isRefreshing: false,
          error: current.snapshot ? null : error instanceof Error ? error.message : "Unable to load live token data.",
        }));
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
