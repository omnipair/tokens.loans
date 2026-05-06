import {
  startTransition,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createEnrichedAssets, sectorLabels, statusMeta } from "./data";
import type { AccessStatus, EnrichedAsset, SectorKey } from "./types";
import { snapshotStatusLabel, useAssetSnapshot } from "./useAssetSnapshot";

type StatusFilter = AccessStatus | "all";
type SectorFilter = SectorKey | "all";

type MapNode = {
  asset: EnrichedAsset;
  x: number;
  y: number;
  radius: number;
  opacity: number;
  drift: number;
  phaseX: number;
  phaseY: number;
};

type MapModel = {
  width: number;
  height: number;
  nodes: MapNode[];
};

type Viewport = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ImageState = {
  img: HTMLImageElement | null;
  status: "idle" | "loading" | "loaded" | "error";
};

const WORLD_WIDTH = 2800;
const WORLD_HEIGHT = 1900;
const MIN_RADIUS = 2.5;
const MAX_RADIUS = 34;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function hashUnit(value: string, seed = 0) {
  let hash = 2166136261 ^ seed;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return ((hash >>> 0) % 10_000) / 10_000;
}

function formatCount(value: number) {
  return new Intl.NumberFormat("en").format(value);
}

function formatShare(value: number) {
  if (value === 0) {
    return "0%";
  }

  if (value < 0.1) {
    return `${value.toFixed(2)}%`;
  }

  return `${value.toFixed(1)}%`;
}

function formatCompactUsd(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return "—";
  }

  if (value >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(1)}B`;
  }

  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }

  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(1)}K`;
  }

  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}

function formatTokenPrice(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return "—";
  }

  if (value >= 1000) {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(value);
  }

  if (value >= 1) {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    }).format(value);
  }

  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(value);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function shortAddress(address: string) {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function getAssetFallback(symbol: string) {
  const cleaned = symbol.replace(/[^a-z0-9]/gi, "");
  return cleaned.slice(0, 2).toUpperCase() || "?";
}

function sizeSignal(asset: EnrichedAsset) {
  if (asset.marketCapUsd > 0) {
    return asset.marketCapUsd;
  }

  if (asset.liquidityUsd > 0) {
    return asset.liquidityUsd * 4;
  }

  if (asset.volume24hUsd > 0) {
    return asset.volume24hUsd * 2;
  }

  return Math.max(asset.holderCount * 20, 1);
}

function logRatio(value: number, maxValue: number) {
  if (maxValue <= 1) {
    return 0;
  }

  return Math.log10(value + 1) / Math.log10(maxValue + 1);
}

function buildMapModel(assets: EnrichedAsset[]): MapModel {
  const maxSignal = Math.max(...assets.map(sizeSignal), 1);
  const centerX = WORLD_WIDTH / 2;
  const centerY = WORLD_HEIGHT / 2;
  const byStatus = {
    "full-access": assets.filter((asset) => asset.status === "full-access").sort((left, right) => sizeSignal(right) - sizeSignal(left)),
    "collateral-only": assets
      .filter((asset) => asset.status === "collateral-only")
      .sort((left, right) => sizeSignal(right) - sizeSignal(left)),
    "borrow-only": assets.filter((asset) => asset.status === "borrow-only").sort((left, right) => sizeSignal(right) - sizeSignal(left)),
    excluded: assets.filter((asset) => asset.status === "excluded").sort((left, right) => sizeSignal(right) - sizeSignal(left)),
  } satisfies Record<AccessStatus, EnrichedAsset[]>;

  const nodes: MapNode[] = [];

  function placeGroup(
    group: EnrichedAsset[],
    {
      startRadius,
      radiusStep,
      scaleX,
      scaleY,
      opacityBase,
    }: {
      startRadius: number;
      radiusStep: number;
      scaleX: number;
      scaleY: number;
      opacityBase: number;
    },
  ) {
    group.forEach((asset, index) => {
      const signal = sizeSignal(asset);
      const ratio = logRatio(signal, maxSignal);
      const seedA = hashUnit(asset.address, 11);
      const seedB = hashUnit(asset.address, 29);
      const seedC = hashUnit(asset.address, 41);
      const angle = index * GOLDEN_ANGLE + seedA * Math.PI * 2;
      const orbit = startRadius + Math.sqrt(index + 1) * radiusStep + seedB * 22;
      const x = clamp(centerX + Math.cos(angle) * orbit * scaleX, 28, WORLD_WIDTH - 28);
      const y = clamp(
        centerY + Math.sin(angle) * orbit * scaleY + Math.cos(angle * 1.8 + seedC) * 12,
        28,
        WORLD_HEIGHT - 28,
      );
      const radius = clamp(
        MIN_RADIUS + ratio * (asset.status === "excluded" ? 20 : MAX_RADIUS - MIN_RADIUS),
        asset.status === "excluded" ? 2.4 : 2.8,
        asset.status === "excluded" ? 22 : MAX_RADIUS,
      );

      nodes.push({
        asset,
        x,
        y,
        radius,
        opacity: opacityBase + ratio * (asset.status === "excluded" ? 0.2 : 0.38),
        drift: 0.6 + Math.min(radius * 0.08, asset.status === "excluded" ? 1.2 : 2.6),
        phaseX: seedA * Math.PI * 2,
        phaseY: seedB * Math.PI * 2,
      });
    });
  }

  placeGroup(byStatus["full-access"], {
    startRadius: 30,
    radiusStep: 26,
    scaleX: 1.04,
    scaleY: 0.84,
    opacityBase: 0.7,
  });
  placeGroup(byStatus["collateral-only"], {
    startRadius: 220,
    radiusStep: 22,
    scaleX: 1.08,
    scaleY: 0.88,
    opacityBase: 0.62,
  });
  placeGroup(byStatus["borrow-only"], {
    startRadius: 320,
    radiusStep: 20,
    scaleX: 1.1,
    scaleY: 0.9,
    opacityBase: 0.58,
  });
  placeGroup(byStatus.excluded, {
    startRadius: 480,
    radiusStep: 13,
    scaleX: 1.15,
    scaleY: 0.96,
    opacityBase: 0.16,
  });

  return { width: WORLD_WIDTH, height: WORLD_HEIGHT, nodes };
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReducedMotion(media.matches);

    update();

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }

    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  return prefersReducedMotion;
}

function matchesQuery(asset: EnrichedAsset, query: string) {
  if (!query) {
    return true;
  }

  const normalized = query.toLowerCase();
  return (
    asset.symbol.toLowerCase().includes(normalized) ||
    asset.name.toLowerCase().includes(normalized) ||
    asset.address.toLowerCase().includes(normalized)
  );
}

function copyAddress(address: string) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(address);
  }

  window.prompt("Copy mint address:", address);
  return Promise.resolve();
}

function SnapshotBootSplash({ message }: { message: string }) {
  return (
    <main className="boot-splash" aria-live="polite">
      <section className="boot-splash-card">
        <span className="mini-badge">tokens.loans</span>
        <div className="boot-splash-status" role="status" aria-label={message}>
          <div className="boot-splash-loader" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <span>{message}</span>
        </div>
      </section>
    </main>
  );
}

export default function MapPage() {
  const { snapshot, status: snapshotStatus, isRefreshing, error } = useAssetSnapshot();
  const prefersReducedMotion = usePrefersReducedMotion();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sectorFilter, setSectorFilter] = useState<SectorFilter>("all");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim());
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [hoveredAddress, setHoveredAddress] = useState<string | null>(null);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState<Viewport>({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const imageCacheRef = useRef<Map<string, ImageState>>(new Map());
  const lastFrameRef = useRef(0);
  const redrawRef = useRef(0);
  const allAssets = useMemo(() => (snapshot ? createEnrichedAssets(snapshot) : []), [snapshot]);
  const snapshotMeta = snapshot?.meta;

  const mapModel = useMemo(() => buildMapModel(allAssets), [allAssets]);
  const summary = useMemo(() => {
    const statusCounts = allAssets.reduce<Record<AccessStatus, number>>(
      (accumulator, asset) => {
        accumulator[asset.status] += 1;
        return accumulator;
      },
      {
        "full-access": 0,
        "collateral-only": 0,
        "borrow-only": 0,
        excluded: 0,
      },
    );

    return {
      supported: allAssets.length - statusCounts.excluded,
      excluded: statusCounts.excluded,
      statusCounts,
    };
  }, [allAssets]);

  const filteredAddresses = useMemo(() => {
    return new Set(
      allAssets
        .filter((asset) => {
          if (statusFilter !== "all" && asset.status !== statusFilter) {
            return false;
          }

          if (sectorFilter !== "all" && asset.sector !== sectorFilter) {
            return false;
          }

          return matchesQuery(asset, deferredQuery);
        })
        .map((asset) => asset.address),
    );
  }, [deferredQuery, sectorFilter, statusFilter]);

  const filteredCount = filteredAddresses.size;

  const selectedNode = useMemo(
    () => mapModel.nodes.find((node) => node.asset.address === (hoveredAddress ?? selectedAddress)) ?? null,
    [hoveredAddress, mapModel.nodes, selectedAddress],
  );

  useLayoutEffect(() => {
    if (!stageRef.current) {
      return;
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      const nextWidth = Math.round(entry.contentRect.width);
      const nextHeight = Math.round(entry.contentRect.height);
      setViewportSize({ width: nextWidth, height: nextHeight });
    });

    resizeObserver.observe(stageRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    if (!viewportSize.width || !viewportSize.height) {
      return;
    }

    setViewport((current) => {
      if (current.width && current.height) {
        return {
          ...current,
          width: viewportSize.width,
          height: viewportSize.height,
          x: clamp(current.x, 0, Math.max(0, mapModel.width - viewportSize.width)),
          y: clamp(current.y, 0, Math.max(0, mapModel.height - viewportSize.height)),
        };
      }

      return {
        width: viewportSize.width,
        height: viewportSize.height,
        x: Math.max(0, (mapModel.width - viewportSize.width) / 2),
        y: Math.max(0, (mapModel.height - viewportSize.height) / 2),
      };
    });
  }, [mapModel.height, mapModel.width, viewportSize.height, viewportSize.width]);

  useEffect(() => {
    if (!copiedAddress) {
      return;
    }

    const timeoutId = window.setTimeout(() => setCopiedAddress(null), 1800);
    return () => window.clearTimeout(timeoutId);
  }, [copiedAddress]);

  useEffect(() => {
    if (!deferredQuery) {
      return;
    }

    const firstMatch = allAssets.find((asset) => filteredAddresses.has(asset.address));

    if (!firstMatch) {
      return;
    }

    setSelectedAddress(firstMatch.address);
  }, [deferredQuery, filteredAddresses]);

  useEffect(() => {
    if (!selectedAddress || !viewport.width || !viewport.height) {
      return;
    }

    const target = mapModel.nodes.find((node) => node.asset.address === selectedAddress);

    if (!target) {
      return;
    }

    setViewport((current) => ({
      ...current,
      x: clamp(target.x - current.width / 2, 0, Math.max(0, mapModel.width - current.width)),
      y: clamp(target.y - current.height / 2, 0, Math.max(0, mapModel.height - current.height)),
    }));
  }, [mapModel.height, mapModel.nodes, mapModel.width, selectedAddress, viewport.height, viewport.width]);

  function scheduleRedraw() {
    redrawRef.current += 1;
  }

  function ensureImage(url: string | null | undefined) {
    if (!url) {
      return null;
    }

    const existing = imageCacheRef.current.get(url);

    if (existing?.status === "loaded") {
      return existing.img;
    }

    if (existing?.status === "loading" || existing?.status === "error") {
      return existing?.img ?? null;
    }

    const image = new Image();
    image.decoding = "async";
    image.loading = "lazy";
    image.src = url;

    imageCacheRef.current.set(url, {
      img: image,
      status: "loading",
    });

    image.onload = () => {
      imageCacheRef.current.set(url, { img: image, status: "loaded" });
      scheduleRedraw();
    };

    image.onerror = () => {
      imageCacheRef.current.set(url, { img: null, status: "error" });
      scheduleRedraw();
    };

    return null;
  }

  function getDrift(node: MapNode, now: number) {
    if (prefersReducedMotion) {
      return { x: 0, y: 0 };
    }

    return {
      x: Math.sin(now / 3400 + node.phaseX) * node.drift,
      y: Math.cos(now / 4200 + node.phaseY) * node.drift,
    };
  }

  useEffect(() => {
    if (!canvasRef.current || !viewport.width || !viewport.height) {
      return;
    }

    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");

    if (!context) {
      return;
    }

    let frameId = 0;

    const render = (now: number) => {
      const frameInterval = prefersReducedMotion ? 1000 / 12 : 1000 / 24;

      if (now - lastFrameRef.current < frameInterval) {
        frameId = window.requestAnimationFrame(render);
        return;
      }

      lastFrameRef.current = now;

      const dpr = window.devicePixelRatio || 1;
      const width = viewport.width;
      const height = viewport.height;

      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);

      const left = viewport.x - 80;
      const top = viewport.y - 80;
      const right = viewport.x + width + 80;
      const bottom = viewport.y + height + 80;

      const visibleNodes = mapModel.nodes.filter(
        (node) =>
          node.x + node.radius > left &&
          node.x - node.radius < right &&
          node.y + node.radius > top &&
          node.y - node.radius < bottom,
      );

      const activeAddress = hoveredAddress ?? selectedAddress;

      visibleNodes
        .slice()
        .sort((leftNode, rightNode) => leftNode.radius - rightNode.radius)
        .forEach((node) => {
          const drift = getDrift(node, now);
          const screenX = node.x - viewport.x + drift.x;
          const screenY = node.y - viewport.y + drift.y;
          const isActive = node.asset.address === activeAddress;
          const matches =
            filteredAddresses.size === allAssets.length || filteredAddresses.has(node.asset.address);
          const baseAlpha = matches ? node.opacity : node.opacity * 0.12;
          const alpha = isActive ? 1 : baseAlpha;

          if (alpha <= 0.02) {
            return;
          }

          const statusColor = statusMeta[node.asset.status].color;

          context.save();
          context.globalAlpha = alpha;

          if (node.asset.status !== "excluded") {
            context.shadowColor = `${statusColor}33`;
            context.shadowBlur = node.radius * 1.4;
          }

          context.beginPath();
          context.arc(screenX, screenY, node.radius, 0, Math.PI * 2);
          context.closePath();

          const canDrawImage = node.radius >= 4.5 && !!node.asset.iconUrl;
          const image = canDrawImage ? ensureImage(node.asset.iconUrl) : null;

          if (image) {
            context.save();
            context.clip();
            context.drawImage(image, screenX - node.radius, screenY - node.radius, node.radius * 2, node.radius * 2);
            context.restore();
          } else {
            context.fillStyle = node.asset.status === "excluded" ? "rgba(29, 42, 39, 0.82)" : statusColor;
            context.fill();

            if (node.radius >= 9) {
              context.fillStyle = node.asset.status === "excluded" ? "rgba(255,255,255,0.86)" : "#07110d";
              context.font = `600 ${Math.max(8, node.radius * 0.72)}px Aeonik, sans-serif`;
              context.textAlign = "center";
              context.textBaseline = "middle";
              context.fillText(getAssetFallback(node.asset.symbol), screenX, screenY + 0.5);
            }
          }

          context.lineWidth = isActive ? Math.max(2, node.radius * 0.14) : Math.max(1, node.radius * 0.08);
          context.strokeStyle =
            node.asset.status === "excluded"
              ? isActive
                ? "rgba(255,255,255,0.9)"
                : "rgba(255,255,255,0.26)"
              : isActive
                ? "rgba(255,255,255,0.96)"
                : "rgba(255,255,255,0.48)";
          context.stroke();
          context.restore();
        });

      frameId = window.requestAnimationFrame(render);
    };

    frameId = window.requestAnimationFrame(render);
    return () => window.cancelAnimationFrame(frameId);
  }, [filteredAddresses, hoveredAddress, mapModel.nodes, prefersReducedMotion, selectedAddress, viewport]);

  function findNodeAt(clientX: number, clientY: number) {
    if (!stageRef.current) {
      return null;
    }

    const rect = stageRef.current.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const now = performance.now();

    for (let index = mapModel.nodes.length - 1; index >= 0; index -= 1) {
      const node = mapModel.nodes[index];
      const drift = getDrift(node, now);
      const screenX = node.x - viewport.x + drift.x;
      const screenY = node.y - viewport.y + drift.y;
      const dx = localX - screenX;
      const dy = localY - screenY;

      if (dx * dx + dy * dy <= (node.radius + 2) * (node.radius + 2)) {
        return node;
      }
    }

    return null;
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: viewport.x,
      originY: viewport.y,
    };

    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) {
      const nextX = dragRef.current.originX - (event.clientX - dragRef.current.startX);
      const nextY = dragRef.current.originY - (event.clientY - dragRef.current.startY);

      setViewport((current) => ({
        ...current,
        x: clamp(nextX, 0, Math.max(0, mapModel.width - current.width)),
        y: clamp(nextY, 0, Math.max(0, mapModel.height - current.height)),
      }));
      return;
    }

    const hoveredNode = findNodeAt(event.clientX, event.clientY);
    setHoveredAddress(hoveredNode?.asset.address ?? null);
  }

  function handlePointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleClick(event: React.MouseEvent<HTMLDivElement>) {
    const targetNode = findNodeAt(event.clientX, event.clientY);

    if (targetNode) {
      setSelectedAddress(targetNode.asset.address);
      return;
    }

    setSelectedAddress(null);
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault();

    const speed = event.shiftKey ? 1.4 : 1;

    setViewport((current) => ({
      ...current,
      x: clamp(current.x + event.deltaX * speed, 0, Math.max(0, mapModel.width - current.width)),
      y: clamp(current.y + event.deltaY * speed, 0, Math.max(0, mapModel.height - current.height)),
    }));
  }

  const activeAsset = selectedNode?.asset ?? null;
  const supportingShare = allAssets.length ? (summary.supported / allAssets.length) * 100 : 0;
  const runtimeStatus = snapshotStatusLabel(snapshotStatus);

  if (!snapshot || !snapshotMeta) {
    return <SnapshotBootSplash message={error ? "Retrying live token map" : "Loading token map"} />;
  }

  return (
    <div className="map-page">
      <header className="map-page-header">
        <div>
          <a className="map-back-link" href="/">
            tokens.loans overview
          </a>
          <h1>Token Map</h1>
          <p>
            Separate full-screen map view. Node size scales with market cap, the field is pannable, and the inspector stays
            pinned so nothing clips out of frame.
          </p>
        </div>
        <div className="map-header-stats">
          <span className="map-stat-chip">{formatCount(allAssets.length)} active tokens</span>
          <span className="map-stat-chip subtle">{formatCount(summary.supported)} supported anywhere</span>
          <span className="map-stat-chip subtle">{formatShare(supportingShare)} of active tokens</span>
          <span className={`map-stat-chip subtle status-badge status-${snapshotStatus}`}>{runtimeStatus}</span>
          <span className="map-stat-chip subtle">Updated {formatDate(snapshotMeta.generatedAt)}</span>
          {isRefreshing ? <span className="map-stat-chip subtle">Syncing live data</span> : null}
        </div>
      </header>

      <section className="map-toolbar">
        <label className="map-search">
          <span className="visually-hidden">Find token</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find token by symbol, name, or mint"
          />
        </label>

        <div className="map-chip-row">
          <button
            type="button"
            className={`map-filter-chip ${statusFilter === "all" ? "active" : ""}`}
            onClick={() =>
              startTransition(() => {
                setStatusFilter("all");
              })
            }
          >
            All statuses
          </button>
          {(Object.keys(statusMeta) as AccessStatus[]).map((status) => (
            <button
              key={status}
              type="button"
              className={`map-filter-chip ${statusFilter === status ? "active" : ""}`}
              onClick={() =>
                startTransition(() => {
                  setStatusFilter(status);
                })
              }
            >
              {statusMeta[status].label}
            </button>
          ))}
        </div>

        <div className="map-chip-row">
          <button
            type="button"
            className={`map-filter-chip ${sectorFilter === "all" ? "active" : ""}`}
            onClick={() =>
              startTransition(() => {
                setSectorFilter("all");
              })
            }
          >
            All sectors
          </button>
          {(Object.keys(sectorLabels) as SectorKey[]).map((sector) => (
            <button
              key={sector}
              type="button"
              className={`map-filter-chip ${sectorFilter === sector ? "active" : ""}`}
              onClick={() =>
                startTransition(() => {
                  setSectorFilter(sector);
                })
              }
            >
              {sectorLabels[sector]}
            </button>
          ))}
        </div>

        <span className="map-toolbar-note">
          Showing {formatCount(filteredCount)} highlighted tokens. Drag to move the field or use your trackpad / wheel.
        </span>
      </section>

      <section className="map-layout">
        <div className="map-canvas-wrap">
          <div
            ref={stageRef}
            className="map-stage"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
            onPointerLeave={() => {
              setHoveredAddress(null);
            }}
            onClick={handleClick}
            onWheel={handleWheel}
          >
            <canvas ref={canvasRef} />

            <div className="map-stage-overlay map-stage-top">
              <span className="map-overlay-chip">All active Solana tokens</span>
              <span className="map-overlay-chip subtle">Faded nodes are outside the current filter or excluded everywhere</span>
            </div>

            <div className="map-stage-overlay map-stage-bottom">
              <span className="map-overlay-chip subtle">Node radius follows market cap. Tokens with missing market cap fall back to liquidity and activity.</span>
            </div>
          </div>
        </div>

        <aside className="map-inspector">
          {activeAsset ? (
            <>
              <div className="map-inspector-head">
                <div className="map-inspector-mark">
                  {activeAsset.iconUrl ? (
                    <img src={activeAsset.iconUrl} alt={`${activeAsset.symbol} token logo`} loading="lazy" decoding="async" />
                  ) : (
                    <span>{getAssetFallback(activeAsset.symbol)}</span>
                  )}
                </div>
                <div>
                  <p className="eyebrow">Focused token</p>
                  <h2>{activeAsset.symbol}</h2>
                  <p>{activeAsset.name}</p>
                </div>
              </div>

              <div className="map-inspector-grid">
                <div>
                  <span>Status</span>
                  <strong>{statusMeta[activeAsset.status].label}</strong>
                </div>
                <div>
                  <span>Sector</span>
                  <strong>{sectorLabels[activeAsset.sector]}</strong>
                </div>
                <div>
                  <span>Market cap</span>
                  <strong>{formatCompactUsd(activeAsset.marketCapUsd)}</strong>
                </div>
                <div>
                  <span>Liquidity</span>
                  <strong>{formatCompactUsd(activeAsset.liquidityUsd)}</strong>
                </div>
                <div>
                  <span>Price</span>
                  <strong>{formatTokenPrice(activeAsset.priceUsd)}</strong>
                </div>
                <div>
                  <span>Presence</span>
                  <strong>{activeAsset.marketPresence}</strong>
                </div>
              </div>

              <div className="map-address-row">
                <code>{shortAddress(activeAsset.address)}</code>
                <button
                  type="button"
                  className={`map-copy-button ${copiedAddress === activeAsset.address ? "copied" : ""}`}
                  onClick={() => {
                    void copyAddress(activeAsset.address).then(() => setCopiedAddress(activeAsset.address));
                  }}
                >
                  {copiedAddress === activeAsset.address ? "Copied" : "Copy mint"}
                </button>
              </div>

              <div className="map-protocol-block">
                <span>Collateral</span>
                <div className="map-pill-row">
                  {activeAsset.collateralProtocols.length ? (
                    activeAsset.collateralProtocols.map((protocol) => <span key={protocol} className="map-protocol-pill">{protocol}</span>)
                  ) : (
                    <span className="map-protocol-empty">None tracked</span>
                  )}
                </div>
              </div>

              <div className="map-protocol-block">
                <span>Borrow</span>
                <div className="map-pill-row">
                  {activeAsset.borrowableProtocols.length ? (
                    activeAsset.borrowableProtocols.map((protocol) => <span key={protocol} className="map-protocol-pill">{protocol}</span>)
                  ) : (
                    <span className="map-protocol-empty">None tracked</span>
                  )}
                </div>
              </div>

              <p className="map-inspector-note">{activeAsset.note}</p>
            </>
          ) : (
            <>
              <p className="eyebrow">Inspector</p>
              <h2>Hover or click any node</h2>
              <p className="map-inspector-note">
                The map now renders on canvas instead of thousands of DOM elements, so the field can take the whole page
                without the old lag. Supported assets stay brighter and excluded assets drift out toward the edges.
              </p>
              <div className="map-inspector-grid">
                <div>
                  <span>Indexed</span>
                  <strong>{formatCount(snapshotMeta.indexedTokenCount)}</strong>
                </div>
                <div>
                  <span>Active</span>
                  <strong>{formatCount(allAssets.length)}</strong>
                </div>
                <div>
                  <span>Supported</span>
                  <strong>{formatCount(summary.supported)}</strong>
                </div>
                <div>
                  <span>Excluded</span>
                  <strong>{formatCount(summary.excluded)}</strong>
                </div>
              </div>
            </>
          )}
        </aside>
      </section>
    </div>
  );
}
