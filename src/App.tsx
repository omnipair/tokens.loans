import {
  startTransition,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type CSSProperties,
} from "react";
import { createEnrichedAssets, protocolNames, sectorLabels, statusMeta, tierOrder } from "./data";
import type { AccessStatus, EnrichedAsset, ProtocolName, SectorKey } from "./types";
import { snapshotStatusLabel, useAssetSnapshot } from "./useAssetSnapshot";

type StatusFilter = AccessStatus | "all";
type SectorFilter = SectorKey | "all";

const INITIAL_VISIBLE_ASSETS = 300;

function formatPercent(value: number, digits = 0) {
  return `${value.toFixed(digits)}%`;
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

function formatCount(value: number) {
  return new Intl.NumberFormat("en").format(value);
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: value >= 100 ? 0 : 1,
  }).format(value);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function pluralize(value: number, singular: string, plural = `${singular}s`) {
  return `${formatCount(value)} ${value === 1 ? singular : plural}`;
}

function statusShare(count: number, total: number) {
  return total === 0 ? 0 : (count / total) * 100;
}

function shortAddress(address: string) {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function formatTokenPrice(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return null;
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

function formatSignedPercent(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return null;
  }

  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function formatCompactUsd(value: number | null | undefined) {
  if (value === null || value === undefined) {
    return null;
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

  return formatTokenPrice(value);
}

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

type TokenClusterBackgroundNode = {
  key: string;
  status: AccessStatus;
  x: number;
  y: number;
  radius: number;
  opacity: number;
  delay: number;
};

type TokenClusterLogoNode = {
  key: string;
  symbol: string;
  name: string;
  address: string;
  iconUrl?: string | null;
  status: AccessStatus;
  tier: "featured" | "ambient";
  priceUsd?: number | null;
  liquidityUsd: number;
  marketPresence: number;
  collateralProtocols: ProtocolName[];
  borrowableProtocols: ProtocolName[];
  x: number;
  y: number;
  size: number;
  opacity: number;
  delay: number;
  floatX: number;
  floatY: number;
  floatRotate: number;
  floatDuration: number;
  floatDelay: number;
};

type TokenClusterModel = {
  width: number;
  height: number;
  backgroundNodes: TokenClusterBackgroundNode[];
  logoNodes: TokenClusterLogoNode[];
};

type TokenClusterTooltipLayout = {
  left: number;
  top: number;
  maxWidth: number;
};

function logRatio(value: number, maxValue: number) {
  if (maxValue <= 0) {
    return 0;
  }

  return Math.log10(value + 10) / Math.log10(maxValue + 10);
}

function nodesOverlap(
  candidate: {
    x: number;
    y: number;
    size: number;
  },
  placed: Array<{
    x: number;
    y: number;
    size: number;
  }>,
  padding: number,
) {
  return placed.some((node) => {
    const distance = Math.hypot(candidate.x - node.x, candidate.y - node.y);
    return distance < candidate.size / 2 + node.size / 2 + padding;
  });
}

function buildTokenClusterModel(assets: EnrichedAsset[]): TokenClusterModel {
  const FEATURED_SUPPORTED_LIMIT = 68;
  const FEATURED_EXCLUDED_LIMIT = 18;
  const AMBIENT_EXCLUDED_LIMIT = 420;
  const width = 1320;
  const height = 780;
  const centerX = width / 2;
  const centerY = height / 2;
  const sorted = [...assets].sort(
    (left, right) => right.liquidityUsd - left.liquidityUsd || right.marketPresence - left.marketPresence,
  );
  const maxLiquidity = Math.max(...sorted.map((asset) => asset.liquidityUsd), 1);
  const supportedAssets = sorted.filter((asset) => asset.status !== "excluded");
  const excludedAssets = sorted.filter((asset) => asset.status === "excluded");
  const supportedFeatured = supportedAssets.slice(0, FEATURED_SUPPORTED_LIMIT);
  const excludedFeatured = excludedAssets.slice(0, FEATURED_EXCLUDED_LIMIT);
  const featuredKeys = new Set([...supportedFeatured, ...excludedFeatured].map((asset) => asset.address));
  const placedLogos: Array<{ x: number; y: number; size: number }> = [];

  function placeLogoNodes(
    logoAssets: EnrichedAsset[],
    {
      tier,
      startOrbit,
      orbitStep,
      maxOrbit,
      padding,
      horizontalScale,
      verticalScale,
      minSize,
      maxSize,
      baseOpacity,
      opacityRange,
      delayStep,
    }: {
      tier: "featured" | "ambient";
      startOrbit: number;
      orbitStep: number;
      maxOrbit: number;
      padding: number;
      horizontalScale: number;
      verticalScale: number;
      minSize: number;
      maxSize: number;
      baseOpacity: number;
      opacityRange: number;
      delayStep: number;
    },
  ): TokenClusterLogoNode[] {
    return logoAssets.map((asset, index) => {
      const liquidity = logRatio(asset.liquidityUsd, maxLiquidity);
      const presence = clamp(asset.marketPresence / 100, 0, 1);
      const size = clamp(minSize + liquidity * (maxSize - minSize) + presence * 5, minSize, maxSize);
      const seedA = hashUnit(asset.address, 13);
      const seedB = hashUnit(asset.address, 31);
      const seedFloatX = hashUnit(asset.address, 59);
      const seedFloatY = hashUnit(asset.address, 71);
      const seedRotate = hashUnit(asset.address, 83);
      const seedDuration = hashUnit(asset.address, 97);
      const floatRange = tier === "featured" ? 11 : 8;
      let chosenX = centerX;
      let chosenY = centerY;

      for (let attempt = 0; attempt < 240; attempt += 1) {
        const angle = index * 2.2 + attempt * 0.58 + seedA * Math.PI * 2;
        const orbit = Math.min(maxOrbit, startOrbit + Math.sqrt(index + 1) * orbitStep + seedB * 10 + attempt * 1.15);
        const x = clamp(centerX + Math.cos(angle) * orbit * horizontalScale, 26 + size / 2, width - 26 - size / 2);
        const y = clamp(centerY + Math.sin(angle) * orbit * verticalScale, 24 + size / 2, height - 24 - size / 2);

        if (!nodesOverlap({ x, y, size }, placedLogos, padding)) {
          chosenX = x;
          chosenY = y;
          break;
        }
      }

      placedLogos.push({ x: chosenX, y: chosenY, size });

      return {
        key: asset.address,
        symbol: asset.symbol,
        name: asset.name,
        address: asset.address,
        iconUrl: asset.iconUrl,
        status: asset.status,
        tier,
        priceUsd: asset.priceUsd,
        liquidityUsd: asset.liquidityUsd,
        marketPresence: asset.marketPresence,
        collateralProtocols: asset.collateralProtocols,
        borrowableProtocols: asset.borrowableProtocols,
        x: chosenX,
        y: chosenY,
        size,
        opacity: clamp(baseOpacity + liquidity * opacityRange + presence * 0.08, 0.18, 1),
        delay: Math.min(index * delayStep, 1100),
        floatX: (seedFloatX - 0.5) * floatRange,
        floatY: (seedFloatY - 0.5) * floatRange * 1.2,
        floatRotate: (seedRotate - 0.5) * (tier === "featured" ? 4 : 3),
        floatDuration: (tier === "featured" ? 13 : 16) + seedDuration * 6,
        floatDelay: -(seedDuration * 12),
      };
    });
  }

  const featuredNodes = [
    ...placeLogoNodes(supportedFeatured, {
      tier: "featured",
      startOrbit: 38,
      orbitStep: 25,
      maxOrbit: 250,
      padding: 6,
      horizontalScale: 1.02,
      verticalScale: 0.84,
      minSize: 22,
      maxSize: 56,
      baseOpacity: 0.92,
      opacityRange: 0.08,
      delayStep: 28,
    }),
    ...placeLogoNodes(excludedFeatured, {
      tier: "featured",
      startOrbit: 312,
      orbitStep: 10,
      maxOrbit: 470,
      padding: 4,
      horizontalScale: 1.05,
      verticalScale: 0.82,
      minSize: 16,
      maxSize: 30,
      baseOpacity: 0.48,
      opacityRange: 0.12,
      delayStep: 28,
    }),
  ];

  const ambientSupported = supportedAssets.filter((asset) => !featuredKeys.has(asset.address));
  const ambientExcluded = excludedAssets
    .filter((asset) => !featuredKeys.has(asset.address))
    .slice(0, AMBIENT_EXCLUDED_LIMIT);
  const ambientNodes = [
    ...placeLogoNodes(ambientSupported, {
      tier: "ambient",
      startOrbit: 192,
      orbitStep: 9.4,
      maxOrbit: 470,
      padding: 2.6,
      horizontalScale: 1.04,
      verticalScale: 0.86,
      minSize: 12,
      maxSize: 22,
      baseOpacity: 0.56,
      opacityRange: 0.2,
      delayStep: 9,
    }),
    ...placeLogoNodes(ambientExcluded, {
      tier: "ambient",
      startOrbit: 278,
      orbitStep: 5.8,
      maxOrbit: 640,
      padding: 1.4,
      horizontalScale: 1.09,
      verticalScale: 0.88,
      minSize: 8,
      maxSize: 15,
      baseOpacity: 0.18,
      opacityRange: 0.16,
      delayStep: 5,
    }),
  ];
  const logoKeys = new Set([...featuredNodes, ...ambientNodes].map((node) => node.key));
  const supportedBackgroundAssets = supportedAssets.filter((asset) => !logoKeys.has(asset.address));
  const excludedBackgroundAssets = excludedAssets.filter((asset) => !logoKeys.has(asset.address));

  const backgroundNodes = [
    ...supportedBackgroundAssets.map((asset, index) => {
      const liquidity = logRatio(asset.liquidityUsd, maxLiquidity);
      const presence = clamp(asset.marketPresence / 100, 0, 1);
      const seedA = hashUnit(asset.address, 11);
      const seedB = hashUnit(asset.address, 29);
      const seedC = hashUnit(asset.address, 47);
      const angle = index * 2.399963229728653 + seedA * Math.PI * 2;
      const radiusFromCenter = 96 + Math.sqrt(index + 1) * 10.6 + seedB * 12;
      const x = clamp(centerX + Math.cos(angle) * radiusFromCenter * 1.04, 18, width - 18);
      const y = clamp(centerY + Math.sin(angle) * radiusFromCenter * 0.82 + Math.cos(angle * 1.7 + seedC) * 8, 20, height - 20);

      return {
        key: asset.address,
        status: asset.status,
        x,
        y,
        radius: clamp(1.4 + liquidity * 2.1 + presence * 0.8, 1.4, 4.6),
        opacity: 0.12 + liquidity * 0.14,
        delay: Math.min(index, 900),
      };
    }),
    ...excludedBackgroundAssets.map((asset, index) => {
      const liquidity = logRatio(asset.liquidityUsd, maxLiquidity);
      const presence = clamp(asset.marketPresence / 100, 0, 1);
      const seedA = hashUnit(asset.address, 7);
      const seedB = hashUnit(asset.address, 19);
      const seedC = hashUnit(asset.address, 37);
      const angle = index * 2.399963229728653 + seedA * Math.PI * 2;
      const radiusFromCenter = 214 + Math.sqrt(index + 1) * 8.1 + seedB * 18;
      const x = clamp(centerX + Math.cos(angle) * radiusFromCenter * 1.08, 14, width - 14);
      const y = clamp(centerY + Math.sin(angle) * radiusFromCenter * 0.86 + Math.sin(angle * 1.4 + seedC) * 10, 16, height - 16);

      return {
        key: asset.address,
        status: asset.status,
        x,
        y,
        radius: clamp(1.1 + liquidity * 1.5 + presence * 0.55, 1.1, 3.5),
        opacity: 0.045 + liquidity * 0.08,
        delay: Math.min(index, 900),
      };
    }),
  ];

  return { width, height, backgroundNodes, logoNodes: [...ambientNodes, ...featuredNodes] };
}

function getAssetFallback(symbol: string) {
  const cleaned = symbol.replace(/[^a-z0-9]/gi, "");
  return cleaned.slice(0, 2).toUpperCase() || "?";
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

function useAnimatedNumber(value: number, duration = 1100) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [displayValue, setDisplayValue] = useState(prefersReducedMotion ? value : 0);
  const previousValueRef = useRef(prefersReducedMotion ? value : 0);

  useEffect(() => {
    if (prefersReducedMotion) {
      previousValueRef.current = value;
      setDisplayValue(value);
      return;
    }

    const from = previousValueRef.current;
    const to = value;

    if (Math.abs(to - from) < 0.001) {
      previousValueRef.current = to;
      setDisplayValue(to);
      return;
    }

    let animationFrame = 0;
    const startedAt = performance.now();

    const tick = (now: number) => {
      const progress = clamp((now - startedAt) / duration, 0, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const nextValue = from + (to - from) * eased;
      setDisplayValue(nextValue);

      if (progress < 1) {
        animationFrame = window.requestAnimationFrame(tick);
        return;
      }

      previousValueRef.current = to;
    };

    animationFrame = window.requestAnimationFrame(tick);

    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, [duration, prefersReducedMotion, value]);

  return displayValue;
}

const protocolBrandMeta: Record<
  ProtocolName,
  {
    logoUrl: string;
    tone: string;
  }
> = {
  Kamino: {
    logoUrl: "/protocols/kamino.png",
    tone: "linear-gradient(145deg, rgba(127, 255, 137, 0.22), rgba(56, 226, 154, 0.14))",
  },
  marginfi: {
    logoUrl: "/protocols/marginfi.png",
    tone: "linear-gradient(145deg, rgba(255, 236, 184, 0.32), rgba(255, 204, 102, 0.14))",
  },
  Save: {
    logoUrl: "/protocols/save.png",
    tone: "linear-gradient(145deg, rgba(129, 227, 255, 0.24), rgba(59, 168, 255, 0.12))",
  },
  Drift: {
    logoUrl: "/protocols/drift.svg",
    tone: "linear-gradient(145deg, rgba(173, 255, 236, 0.26), rgba(82, 215, 211, 0.14))",
  },
  Loopscale: {
    logoUrl: "/protocols/loopscale.png",
    tone: "linear-gradient(145deg, rgba(218, 255, 142, 0.24), rgba(184, 255, 55, 0.12))",
  },
  Omnipair: {
    logoUrl: "/protocols/omnipair.png",
    tone: "linear-gradient(145deg, rgba(231, 244, 255, 0.9), rgba(205, 225, 255, 0.64))",
  },
};

function getProtocolFallback(protocol: ProtocolName) {
  return protocol.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase();
}

async function writeToClipboard(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "absolute";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();

  const copied = document.execCommand("copy");
  textarea.remove();

  if (!copied) {
    throw new Error("Clipboard copy failed");
  }
}

function ClipboardIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="M9 6.75H7.75A1.75 1.75 0 0 0 6 8.5v9.75C6 19.216 6.784 20 7.75 20h8.5A1.75 1.75 0 0 0 18 18.25V8.5A1.75 1.75 0 0 0 16.25 6.75H15"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M9.75 4h4.5C15.216 4 16 4.784 16 5.75v1.5C16 8.216 15.216 9 14.25 9h-4.5C8.784 9 8 8.216 8 7.25v-1.5C8 4.784 8.784 4 9.75 4Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
      <path
        d="m6.75 12.5 3.5 3.5 7-7"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function AssetMark({ symbol, iconUrl }: { symbol: string; iconUrl?: string | null }) {
  const [imageFailed, setImageFailed] = useState(false);

  if (iconUrl && !imageFailed) {
    return (
      <div className="asset-mark asset-mark-image">
        <img
          src={iconUrl}
          alt={`${symbol} token logo`}
          loading="lazy"
          decoding="async"
          width="40"
          height="40"
          onError={() => setImageFailed(true)}
        />
      </div>
    );
  }

  return <div className="asset-mark">{getAssetFallback(symbol)}</div>;
}

function TokenClusterLogoNode({
  node,
  onHover,
  onLeave,
}: {
  node: TokenClusterLogoNode;
  onHover: (node: TokenClusterLogoNode, anchor: HTMLButtonElement) => void;
  onLeave: () => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);

  return (
    <button
      type="button"
      className={`token-cluster-logo token-cluster-logo-${node.status} token-cluster-logo-${node.tier}`}
      style={
        {
          left: `${node.x}px`,
          top: `${node.y}px`,
          width: `${node.size}px`,
          height: `${node.size}px`,
          opacity: node.opacity,
          animationDelay: `${node.delay}ms`,
          "--float-x": `${node.floatX}px`,
          "--float-y": `${node.floatY}px`,
          "--float-rotate": `${node.floatRotate}deg`,
          "--float-duration": `${node.floatDuration}s`,
          "--float-delay": `${node.floatDelay}s`,
        } as CSSProperties
      }
      aria-label={`${node.symbol}, ${node.name}, ${statusMeta[node.status].label}`}
      tabIndex={node.tier === "ambient" ? -1 : 0}
      onMouseEnter={(event) => onHover(node, event.currentTarget)}
      onMouseLeave={onLeave}
      onFocus={(event) => onHover(node, event.currentTarget)}
      onBlur={onLeave}
      onClick={(event) => onHover(node, event.currentTarget)}
    >
      <span className="token-cluster-logo-float">
        {node.iconUrl && !imageFailed ? (
          <img
            src={node.iconUrl}
            alt={`${node.symbol} token logo`}
            loading="lazy"
            decoding="async"
            fetchPriority="low"
            draggable={false}
            width={Math.round(node.size)}
            height={Math.round(node.size)}
            onError={() => setImageFailed(true)}
          />
        ) : (
          <span>{getAssetFallback(node.symbol)}</span>
        )}
      </span>
    </button>
  );
}

function TokenClusterTooltip({
  node,
  layout,
  tooltipRef,
  onEnter,
  onLeave,
}: {
  node: TokenClusterLogoNode;
  layout: TokenClusterTooltipLayout;
  tooltipRef: RefObject<HTMLDivElement | null>;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const price = formatTokenPrice(node.priceUsd);
  const liquidity = formatCompactUsd(node.liquidityUsd);

  return (
    <div
      ref={tooltipRef}
      className="token-cluster-tooltip"
      style={
        {
          left: `${layout.left}px`,
          top: `${layout.top}px`,
          maxWidth: `${layout.maxWidth}px`,
        } satisfies CSSProperties
      }
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div className="token-cluster-tooltip-head">
        <AssetMark symbol={node.symbol} iconUrl={node.iconUrl} />
        <div className="token-cluster-tooltip-copy">
          <strong>{node.symbol}</strong>
          <span>{node.name}</span>
        </div>
        <span className={`status-pill status-${node.status}`}>{statusMeta[node.status].label}</span>
      </div>

      <div className="token-cluster-tooltip-metrics">
        <div>
          <span>Price</span>
          <strong>{price ?? "—"}</strong>
        </div>
        <div>
          <span>Liquidity</span>
          <strong>{liquidity ?? "—"}</strong>
        </div>
        <div>
          <span>Presence</span>
          <strong>{node.marketPresence}</strong>
        </div>
      </div>

      <div className="token-cluster-tooltip-list">
        <span>Collateral</span>
        <strong>{node.collateralProtocols.length ? node.collateralProtocols.join(", ") : "None tracked"}</strong>
      </div>
      <div className="token-cluster-tooltip-list">
        <span>Borrow</span>
        <strong>{node.borrowableProtocols.length ? node.borrowableProtocols.join(", ") : "None tracked"}</strong>
      </div>
    </div>
  );
}

function ProtocolMark({ protocol, size = "md" }: { protocol: ProtocolName; size?: "sm" | "md" | "lg" }) {
  const [imageFailed, setImageFailed] = useState(false);
  const brand = protocolBrandMeta[protocol];

  return (
    <span className={`protocol-mark protocol-mark-${size}`} style={{ background: brand.tone }}>
      {!imageFailed ? (
        <img
          src={brand.logoUrl}
          alt={`${protocol} logo`}
          loading="lazy"
          decoding="async"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span>{getProtocolFallback(protocol)}</span>
      )}
    </span>
  );
}

function ProtocolBadgeList({ items }: { items: ProtocolName[] }) {
  if (!items.length) {
    return <span className="protocol-empty">—</span>;
  }

  return (
    <div className="protocol-badge-list">
      {items.map((protocol) => (
        <span key={protocol} className="protocol-badge">
          <ProtocolMark protocol={protocol} size="sm" />
          <span>{protocol}</span>
        </span>
      ))}
    </div>
  );
}

function rankAssets(assets: EnrichedAsset[]) {
  return [...assets].sort((left, right) => {
    if (left.status !== right.status) {
      const order: AccessStatus[] = ["full-access", "collateral-only", "borrow-only", "excluded"];
      return order.indexOf(left.status) - order.indexOf(right.status);
    }

    return right.coverageScore - left.coverageScore || right.marketPresence - left.marketPresence;
  });
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

function App() {
  const { snapshot, status: snapshotStatus, isRefreshing, error } = useAssetSnapshot();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sectorFilter, setSectorFilter] = useState<SectorFilter>("all");
  const [query, setQuery] = useState("");
  const [hoveredStatus, setHoveredStatus] = useState<AccessStatus | null>(null);
  const [hoveredClusterNode, setHoveredClusterNode] = useState<TokenClusterLogoNode | null>(null);
  const [hoveredClusterAnchor, setHoveredClusterAnchor] = useState<HTMLButtonElement | null>(null);
  const [clusterTooltipLayout, setClusterTooltipLayout] = useState<TokenClusterTooltipLayout | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_ASSETS);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const [isClusterDragging, setIsClusterDragging] = useState(false);
  const deferredQuery = useDeferredValue(query);
  const clusterViewportRef = useRef<HTMLDivElement | null>(null);
  const clusterScrollRef = useRef<HTMLDivElement | null>(null);
  const clusterTooltipRef = useRef<HTMLDivElement | null>(null);
  const clusterDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const clusterHideTimeoutRef = useRef<number | null>(null);
  const allAssets = useMemo(() => (snapshot ? createEnrichedAssets(snapshot) : []), [snapshot]);
  const snapshotMeta = snapshot?.meta;

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

    const collateralReach = allAssets.filter((asset) => asset.collateralProtocols.length > 0).length;
    const borrowReach = allAssets.filter((asset) => asset.borrowableProtocols.length > 0).length;
    const protocolCoverage = protocolNames.map((protocol) => {
      const collateralCount = allAssets.filter((asset) => asset.collateralProtocols.includes(protocol)).length;
      const borrowCount = allAssets.filter((asset) => asset.borrowableProtocols.includes(protocol)).length;
      const reachableCount = allAssets.filter(
        (asset) => asset.collateralProtocols.includes(protocol) || asset.borrowableProtocols.includes(protocol),
      ).length;

      return {
        protocol,
        collateralCount,
        borrowCount,
        reachableCount,
      };
    });

    const tierCoverage = tierOrder.map((tier) => {
      const assets = allAssets.filter((asset) => asset.tier === tier);
      const total = assets.length;

      return {
        tier,
        total,
        counts: {
          "full-access": assets.filter((asset) => asset.status === "full-access").length,
          "collateral-only": assets.filter((asset) => asset.status === "collateral-only").length,
          "borrow-only": assets.filter((asset) => asset.status === "borrow-only").length,
          excluded: assets.filter((asset) => asset.status === "excluded").length,
        },
      };
    });

    return {
      statusCounts,
      collateralReach,
      borrowReach,
      protocolCoverage,
      tierCoverage,
    };
  }, [allAssets]);

  const stackEntries = useMemo(() => {
    return (Object.keys(statusMeta) as AccessStatus[]).map((status) => {
      const count = summary.statusCounts[status];

      return {
        status,
        count,
        share: statusShare(count, allAssets.length),
      };
    });
  }, [summary.statusCounts, allAssets.length]);

  const supportedCount = allAssets.length - summary.statusCounts.excluded;
  const supportedShare = statusShare(supportedCount, allAssets.length);

  const supportedEntries = useMemo(
    () =>
      stackEntries
        .filter((entry) => entry.status !== "excluded")
        .map((entry) => ({
          ...entry,
          supportedShare: statusShare(entry.count, supportedCount),
        })),
    [stackEntries, supportedCount],
  );
  const protocolRows = useMemo(
    () =>
      [...summary.protocolCoverage].sort(
        (left, right) =>
          right.reachableCount - left.reachableCount ||
          right.collateralCount - left.collateralCount ||
          right.borrowCount - left.borrowCount,
      ),
    [summary.protocolCoverage],
  );

  const protocolMaxCollateral = useMemo(
    () => Math.max(...protocolRows.map((item) => item.collateralCount), 1),
    [protocolRows],
  );
  const protocolMaxBorrow = useMemo(() => Math.max(...protocolRows.map((item) => item.borrowCount), 1), [protocolRows]);

  const focusedStatus = hoveredStatus ?? (statusFilter === "all" ? "excluded" : statusFilter);

  const filteredAssets = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLowerCase();

    return rankAssets(
      allAssets.filter((asset) => {
        if (statusFilter !== "all" && asset.status !== statusFilter) {
          return false;
        }

        if (sectorFilter !== "all" && asset.sector !== sectorFilter) {
          return false;
        }

        if (!normalizedQuery) {
          return true;
        }

        return (
          asset.symbol.toLowerCase().includes(normalizedQuery) ||
          asset.name.toLowerCase().includes(normalizedQuery) ||
          asset.address.toLowerCase().includes(normalizedQuery) ||
          sectorLabels[asset.sector].toLowerCase().includes(normalizedQuery)
        );
      }),
    );
  }, [allAssets, deferredQuery, sectorFilter, statusFilter]);

  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE_ASSETS);
  }, [deferredQuery, sectorFilter, statusFilter]);

  useEffect(() => {
    if (!copiedAddress) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCopiedAddress(null);
    }, 1800);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [copiedAddress]);

  useEffect(() => {
    const scrollElement = clusterScrollRef.current;

    if (!scrollElement) {
      return;
    }

    scrollElement.scrollLeft = Math.max(0, (scrollElement.scrollWidth - scrollElement.clientWidth) / 2);
    scrollElement.scrollTop = Math.max(0, (scrollElement.scrollHeight - scrollElement.clientHeight) / 2);
  }, []);

  useEffect(() => {
    return () => {
      if (clusterHideTimeoutRef.current !== null) {
        window.clearTimeout(clusterHideTimeoutRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    if (!hoveredClusterNode || !hoveredClusterAnchor || !clusterViewportRef.current) {
      setClusterTooltipLayout(null);
      return;
    }

    const viewportElement = clusterViewportRef.current;
    const scrollElement = clusterScrollRef.current;

    const updateTooltipLayout = () => {
      const viewportRect = viewportElement.getBoundingClientRect();
      const anchorRect = hoveredClusterAnchor.getBoundingClientRect();
      const fallbackWidth = Math.min(340, viewportRect.width - 28);
      const tooltipWidth = Math.min(clusterTooltipRef.current?.offsetWidth ?? fallbackWidth, viewportRect.width - 28);
      const tooltipHeight = Math.min(clusterTooltipRef.current?.offsetHeight ?? 224, viewportRect.height - 28);
      const anchorCenterX = anchorRect.left - viewportRect.left + anchorRect.width / 2;
      const anchorTop = anchorRect.top - viewportRect.top;
      const anchorBottom = anchorRect.bottom - viewportRect.top;
      const preferredAbove = anchorTop > tooltipHeight + 20;
      const preferredBelow = viewportRect.height - anchorBottom > tooltipHeight + 20;
      const top = preferredAbove
        ? anchorTop - tooltipHeight - 14
        : preferredBelow
          ? anchorBottom + 14
          : clamp((viewportRect.height - tooltipHeight) / 2, 14, viewportRect.height - tooltipHeight - 14);
      const left = clamp(anchorCenterX - tooltipWidth / 2, 14, viewportRect.width - tooltipWidth - 14);

      setClusterTooltipLayout({
        left,
        top,
        maxWidth: fallbackWidth,
      });
    };

    updateTooltipLayout();
    scrollElement?.addEventListener("scroll", updateTooltipLayout, { passive: true });
    window.addEventListener("resize", updateTooltipLayout);

    return () => {
      scrollElement?.removeEventListener("scroll", updateTooltipLayout);
      window.removeEventListener("resize", updateTooltipLayout);
    };
  }, [hoveredClusterAnchor, hoveredClusterNode]);

  const visibleAssets = filteredAssets.slice(0, visibleCount);
  const activeStatusCount = summary.statusCounts[focusedStatus];
  const excludedShare = statusShare(summary.statusCounts.excluded, allAssets.length);
  const activeStatusShare = statusShare(activeStatusCount, allAssets.length);
  const filteredShare = statusShare(allAssets.length, snapshotMeta?.indexedTokenCount ?? 0);
  const featuredAssets = rankAssets(allAssets.filter((asset) => asset.status === focusedStatus))
    .slice(0, 4)
    .map((asset) => asset.symbol);
  const runtimeStatus = snapshotStatusLabel(snapshotStatus);

  if (!snapshot || !snapshotMeta) {
    return <SnapshotBootSplash message={error ? "Retrying live token coverage" : "Loading token coverage"} />;
  }

  async function handleCopyAddress(address: string) {
    try {
      await writeToClipboard(address);
      setCopiedAddress(address);
    } catch {
      window.prompt("Copy mint address:", address);
    }
  }

  function clearClusterHideTimer() {
    if (clusterHideTimeoutRef.current !== null) {
      window.clearTimeout(clusterHideTimeoutRef.current);
      clusterHideTimeoutRef.current = null;
    }
  }

  function hideClusterTooltip() {
    clearClusterHideTimer();
    setHoveredClusterNode(null);
    setHoveredClusterAnchor(null);
    setClusterTooltipLayout(null);
  }

  function scheduleClusterHide() {
    clearClusterHideTimer();
    clusterHideTimeoutRef.current = window.setTimeout(() => {
      hideClusterTooltip();
    }, 120);
  }

  function handleClusterHover(node: TokenClusterLogoNode, anchor: HTMLButtonElement) {
    clearClusterHideTimer();
    setHoveredClusterNode(node);
    setHoveredClusterAnchor(anchor);
  }

  function handleClusterPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    const scrollElement = clusterScrollRef.current;

    if (!scrollElement) {
      return;
    }

    clusterDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: scrollElement.scrollLeft,
      scrollTop: scrollElement.scrollTop,
    };
    setIsClusterDragging(true);
    scrollElement.setPointerCapture(event.pointerId);
  }

  function handleClusterPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const dragState = clusterDragRef.current;
    const scrollElement = clusterScrollRef.current;

    if (!dragState || !scrollElement || dragState.pointerId !== event.pointerId) {
      return;
    }

    const deltaX = event.clientX - dragState.startX;
    const deltaY = event.clientY - dragState.startY;
    scrollElement.scrollLeft = dragState.scrollLeft - deltaX;
    scrollElement.scrollTop = dragState.scrollTop - deltaY;
  }

  function handleClusterPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const scrollElement = clusterScrollRef.current;

    if (clusterDragRef.current?.pointerId === event.pointerId) {
      clusterDragRef.current = null;
    }

    if (scrollElement?.hasPointerCapture(event.pointerId)) {
      scrollElement.releasePointerCapture(event.pointerId);
    }

    setIsClusterDragging(false);
  }

  return (
    <div className="page-shell">
      <div className="page-orb page-orb-a" />
      <div className="page-orb page-orb-b" />

      <main className="app-shell">
        <section className="hero-panel surface surface-hero">
          <div className="hero-copy">
            <div className="hero-badges">
              <span className="mini-badge">tokens.loans</span>
              <span className={`mini-badge subtle status-badge status-${snapshotStatus}`}>{runtimeStatus}</span>
              <span className="mini-badge subtle">Updated {formatDate(snapshotMeta.generatedAt)}</span>
              {isRefreshing ? <span className="mini-badge subtle">Syncing live data</span> : null}
            </div>

            <p className="eyebrow">Solana credit coverage</p>
            <h1>Most active Solana tokens are still unavailable in lending markets.</h1>
            <p className="hero-description">
              tokens.loans starts from {formatCount(snapshotMeta.indexedTokenCount)} Jupiter-indexed tokens, filters out
              inactive assets, and tracks how many of the remaining {formatCount(allAssets.length)} tokens are listed for
              collateral or borrowing on Kamino, marginfi, Save, Drift, Loopscale, and Omnipair.
            </p>

            <div className="hero-actions">
              <div className="hero-button-row">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    const table = document.getElementById("asset-table");
                    table?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                >
                  Explore the coverage table
                </button>
              </div>
              <div className="hero-signal">
                <strong>
                  <AnimatedNumber value={excludedShare} formatter={(current) => formatPercent(current, 1)} />
                </strong>
                <span>of active Solana tokens are excluded everywhere</span>
              </div>
            </div>
          </div>

          <aside className="hero-aside">
            <article className="signal-card strong surface-signal surface-signal-strong">
              <span className="signal-label">Focused status</span>
              <strong>{statusMeta[focusedStatus].label}</strong>
              <p>{statusMeta[focusedStatus].description}</p>
              <div className="signal-value-row">
                <div>
                  <span>Assets</span>
                  <strong>
                    <AnimatedNumber value={activeStatusCount} formatter={(current) => formatCount(Math.round(current))} />
                  </strong>
                </div>
                <div>
                  <span>Share</span>
                  <strong>
                    <AnimatedNumber value={activeStatusShare} formatter={(current) => formatPercent(current, 1)} />
                  </strong>
                </div>
              </div>
              <span className="signal-footnote">Examples: {featuredAssets.join(", ") || "No assets in this slice yet"}</span>
            </article>

            <article className="signal-card surface-signal surface-signal-muted">
              <span className="signal-label">Active token filter</span>
              <strong>
                <AnimatedNumber value={allAssets.length} formatter={(current) => `${formatCount(Math.round(current))} active tokens retained`} />
              </strong>
              <p>
                {formatPercent(filteredShare, 1)} of the {formatCount(snapshotMeta.indexedTokenCount)} indexed tokens
                survived the dead-token filter.
              </p>
            </article>
          </aside>
        </section>

        <section className="stats-grid">
          <StatCard
            className="stat-card-indexed"
            label="Indexed tokens"
            value={snapshotMeta.indexedTokenCount}
            formatter={(current) => formatCompactNumber(Math.round(current))}
            detail="Full Jupiter Solana token cache"
          />
          <StatCard
            className="stat-card-active"
            label="Active after filter"
            value={allAssets.length}
            formatter={(current) => formatCompactNumber(Math.round(current))}
            detail="Dead or inactive tokens removed"
          />
          <StatCard
            className="stat-card-collateral"
            label="Accepted as collateral"
            value={summary.collateralReach}
            formatter={(current) => formatCount(Math.round(current))}
            detail={`${formatPercent(statusShare(summary.collateralReach, allAssets.length), 1)} of active tokens`}
          />
          <StatCard
            className="stat-card-borrow"
            label="Borrowable anywhere"
            value={summary.borrowReach}
            formatter={(current) => formatCount(Math.round(current))}
            detail={`${formatPercent(statusShare(summary.borrowReach, allAssets.length), 1)} of active tokens`}
          />
          <StatCard
            className="stat-card-excluded"
            label="Excluded everywhere"
            value={summary.statusCounts.excluded}
            formatter={(current) => formatCount(Math.round(current))}
            detail={`${formatPercent(excludedShare, 1)} of active tokens`}
          />
        </section>

        <section className="story-grid">
          <article className="surface chart-panel surface-chart">
            <div className="panel-topline">
              <div>
                <p className="eyebrow">Coverage split</p>
                <h2>Most active tokens still sit outside tracked lending markets</h2>
              </div>
              <button
                type="button"
                className={`ghost-button ${statusFilter === "all" ? "active" : ""}`}
                onClick={() =>
                  startTransition(() => {
                    setStatusFilter("all");
                  })
                }
              >
                Reset filter
              </button>
            </div>

            <div className="coverage-grid">
              <div className="coverage-exact">
                <div className="coverage-snapshot">
                  <article className="coverage-stat-card coverage-stat-card-dark coverage-stat-card-excluded">
                    <span className="signal-label">Excluded everywhere</span>
                    <strong>
                      <AnimatedNumber
                        value={summary.statusCounts.excluded}
                        formatter={(current) => formatCount(Math.round(current))}
                      />
                    </strong>
                    <p>{formatShare(excludedShare)} of active Solana tokens still sit outside every tracked venue.</p>
                  </article>
                  <article className="coverage-stat-card coverage-stat-card-light coverage-stat-card-supported">
                    <span className="signal-label">Supported anywhere</span>
                    <strong>
                      <AnimatedNumber value={supportedCount} formatter={(current) => formatCount(Math.round(current))} />
                    </strong>
                    <p>{formatShare(supportedShare)} make it into at least one collateral or borrow market.</p>
                  </article>
                </div>

                <div className="coverage-scale-card surface-lucid">
                  <div className="coverage-scale-head">
                    <div>
                      <p className="eyebrow">Exact share of all active tokens</p>
                      <h3>The top bar stays honest at full token-set scale.</h3>
                    </div>
                    <span className="coverage-total">
                      <AnimatedNumber value={allAssets.length} formatter={(current) => `${formatCount(Math.round(current))} tokens`} />
                    </span>
                  </div>

                  <div className="coverage-track" role="img" aria-label="Exact share of all active tokens by lending coverage status">
                    {stackEntries.map((entry, index) => (
                      <span
                        key={entry.status}
                        className={`coverage-track-segment ${focusedStatus === entry.status ? "active" : ""}`}
                        style={
                          {
                            width: `${entry.share}%`,
                            background: statusMeta[entry.status].color,
                            "--segment-delay": `${index * 95}ms`,
                          } as CSSProperties
                        }
                        title={`${statusMeta[entry.status].label}: ${formatCount(entry.count)} tokens (${formatShare(entry.share)})`}
                      />
                    ))}
                  </div>

                  <p className="stack-caption">
                    Exact widths above. Use the filters below to inspect rare categories without inflating them.
                  </p>

                  <div className="stack-legend">
                    {stackEntries.map((entry) => (
                      <button
                        key={entry.status}
                        type="button"
                        className={`legend-chip ${focusedStatus === entry.status ? "active" : ""}`}
                        onMouseEnter={() => setHoveredStatus(entry.status)}
                        onMouseLeave={() => setHoveredStatus(null)}
                        onFocus={() => setHoveredStatus(entry.status)}
                        onBlur={() => setHoveredStatus(null)}
                        onClick={() =>
                          startTransition(() => {
                            setStatusFilter((current) => (current === entry.status ? "all" : entry.status));
                          })
                        }
                      >
                        <span className="legend-dot" style={{ background: statusMeta[entry.status].color }} />
                        {statusMeta[entry.status].label}
                        <span className="legend-metric">
                          {formatCount(entry.count)} · {formatShare(entry.share)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <article className="coverage-zoom-card surface-nebula">
                <div className="coverage-scale-head">
                  <div>
                    <p className="eyebrow">Zoom on the supported slice</p>
                    <h3>Most supported tokens still cluster into a very small pool.</h3>
                  </div>
                  <span className="coverage-total">
                    <AnimatedNumber value={supportedCount} formatter={(current) => `${formatCount(Math.round(current))} tokens`} />
                  </span>
                </div>

                <div className="coverage-breakout-list">
                  {supportedEntries.map((entry, index) => (
                    <button
                      key={entry.status}
                      type="button"
                      className={`coverage-breakout-row ${focusedStatus === entry.status ? "active" : ""} ${statusFilter === entry.status ? "selected" : ""}`}
                      onMouseEnter={() => setHoveredStatus(entry.status)}
                      onMouseLeave={() => setHoveredStatus(null)}
                      onFocus={() => setHoveredStatus(entry.status)}
                      onBlur={() => setHoveredStatus(null)}
                      onClick={() =>
                        startTransition(() => {
                          setStatusFilter((current) => (current === entry.status ? "all" : entry.status));
                        })
                      }
                    >
                      <div className="coverage-breakout-head">
                        <div className="coverage-breakout-label">
                          <span className="legend-dot" style={{ background: statusMeta[entry.status].color }} />
                          <strong>{statusMeta[entry.status].label}</strong>
                        </div>
                        <div className="coverage-breakout-metrics">
                          <span>{formatCount(entry.count)} tokens</span>
                          <span>{formatShare(entry.supportedShare)} of supported</span>
                        </div>
                      </div>
                      <div className="coverage-breakout-track" aria-hidden="true">
                        <span
                          className="coverage-breakout-fill"
                          style={
                            {
                              width: `${entry.supportedShare}%`,
                              background: statusMeta[entry.status].color,
                              "--segment-delay": `${180 + index * 110}ms`,
                            } as CSSProperties
                          }
                        />
                      </div>
                      <span className="coverage-breakout-foot">{formatShare(entry.share)} of all active tokens</span>
                    </button>
                  ))}
                </div>
              </article>
            </div>
          </article>

          <article className="surface detail-panel surface-detail">
            <div className="panel-topline compact">
              <div>
                <p className="eyebrow">Tier gradient</p>
                <h2>Support falls off fast once you leave the core asset set</h2>
              </div>
            </div>

            <div className="tier-list">
              {summary.tierCoverage.map((group) => (
                <div key={group.tier} className="tier-row">
                  <div className="tier-copy">
                    <strong>{group.tier}</strong>
                    <span>{pluralize(group.total, "asset")}</span>
                  </div>
                  <div className="tier-bar">
                    {(Object.keys(statusMeta) as AccessStatus[]).map((status, index) => {
                      const count = group.counts[status];
                      const share = statusShare(count, group.total);

                      return (
                        <span
                          key={status}
                          className={`tier-segment ${focusedStatus === status ? "active" : ""}`}
                          style={
                            {
                              width: `${share}%`,
                              background: statusMeta[status].color,
                              "--segment-delay": `${index * 85}ms`,
                            } as CSSProperties
                          }
                          title={`${group.tier}: ${count} ${statusMeta[status].label.toLowerCase()}`}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </article>
        </section>

        <section className="surface protocol-panel surface-protocol">
          <div className="panel-topline">
            <div>
              <p className="eyebrow">Protocol view</p>
              <h2>Even the most permissive venues support only a tiny slice of live tokens</h2>
            </div>
          </div>

          <div className="protocol-list">
            {protocolRows.map((item, index) => (
              <article key={item.protocol} className="protocol-row protocol-row-chromatic">
                <div className="protocol-row-head">
                  <span className="protocol-rank">{String(index + 1).padStart(2, "0")}</span>
                  <ProtocolMark protocol={item.protocol} size="lg" />
                  <div className="protocol-copy">
                    <strong>{item.protocol}</strong>
                    <p>
                      <AnimatedNumber value={item.reachableCount} formatter={(current) => formatCount(Math.round(current))} />{" "}
                      supported tokens in snapshot ·{" "}
                      <AnimatedNumber
                        value={statusShare(item.reachableCount, allAssets.length)}
                        formatter={(current) => formatShare(current)}
                      />{" "}
                      of active tokens
                    </p>
                  </div>
                </div>

                <div className="protocol-metric-grid">
                  <div className="protocol-metric">
                    <div className="protocol-metric-head">
                      <span>Collateral</span>
                      <strong>
                        <AnimatedNumber value={item.collateralCount} formatter={(current) => formatCount(Math.round(current))} />
                      </strong>
                      <span>
                        <AnimatedNumber
                          value={statusShare(item.collateralCount, allAssets.length)}
                          formatter={(current) => formatShare(current)}
                        />
                      </span>
                    </div>
                    <div className="protocol-meter" aria-hidden="true">
                      <span
                        className="protocol-meter-fill collateral"
                        style={
                          {
                            width: `${statusShare(item.collateralCount, protocolMaxCollateral)}%`,
                            "--segment-delay": `${120 + index * 70}ms`,
                          } as CSSProperties
                        }
                      />
                    </div>
                  </div>

                  <div className="protocol-metric">
                    <div className="protocol-metric-head">
                      <span>Borrow</span>
                      <strong>
                        <AnimatedNumber value={item.borrowCount} formatter={(current) => formatCount(Math.round(current))} />
                      </strong>
                      <span>
                        <AnimatedNumber
                          value={statusShare(item.borrowCount, allAssets.length)}
                          formatter={(current) => formatShare(current)}
                        />
                      </span>
                    </div>
                    <div className="protocol-meter" aria-hidden="true">
                      <span
                        className="protocol-meter-fill borrow"
                        style={
                          {
                            width: `${statusShare(item.borrowCount, protocolMaxBorrow)}%`,
                            "--segment-delay": `${200 + index * 70}ms`,
                          } as CSSProperties
                        }
                      />
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>

          <p className="protocol-note">
            Bar lengths are normalized to the most permissive venue in each column. Percentages stay anchored to active tokens.
          </p>
        </section>

        <section className="surface table-panel surface-table" id="asset-table">
          <div className="panel-topline">
            <div>
              <p className="eyebrow">Coverage table</p>
              <h2>Every active token that survived the dead-token filter</h2>
            </div>
            <span className="table-count">
              Showing <AnimatedNumber value={visibleAssets.length} formatter={(current) => formatCount(Math.round(current))} /> of{" "}
              <AnimatedNumber value={filteredAssets.length} formatter={(current) => formatCount(Math.round(current))} /> assets
            </span>
          </div>

          <div className="filters-bar">
            <label className="search-field">
              <span className="visually-hidden">Search assets</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search symbol, name, mint, or sector"
              />
            </label>

            <div className="chip-row">
              <button
                type="button"
                className={`filter-chip ${sectorFilter === "all" ? "active" : ""}`}
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
                  className={`filter-chip ${sectorFilter === sector ? "active" : ""}`}
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
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Tier</th>
                  <th>Status</th>
                  <th>Collateral on</th>
                  <th>Borrowable on</th>
                  <th>Presence</th>
                  <th>Why it matters</th>
                </tr>
              </thead>
              <tbody>
                {visibleAssets.map((asset) => (
                  <tr key={asset.address}>
                    <td data-label="Asset">
                      <div className="asset-cell">
                        <AssetMark symbol={asset.symbol} iconUrl={asset.iconUrl} />
                        <div className="asset-copy">
                          <strong>{asset.symbol}</strong>
                          <span>{asset.name}</span>
                          {asset.priceUsd !== null && asset.priceUsd !== undefined ? (
                            <div className="asset-price-row">
                              <span className="asset-price">{formatTokenPrice(asset.priceUsd)}</span>
                              {asset.priceChange24h !== null && asset.priceChange24h !== undefined ? (
                                <span className={`asset-price-change ${asset.priceChange24h >= 0 ? "up" : "down"}`}>
                                  {formatSignedPercent(asset.priceChange24h)}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                          <div className="asset-meta-row">
                            <div className={`address-inline ${copiedAddress === asset.address ? "copied" : ""}`} title={asset.address}>
                              <code className="asset-address">{shortAddress(asset.address)}</code>
                              <button
                                type="button"
                                className={`copy-icon-button ${copiedAddress === asset.address ? "copied" : ""}`}
                                onClick={() => {
                                  void handleCopyAddress(asset.address);
                                }}
                                aria-label={copiedAddress === asset.address ? "Mint copied" : `Copy ${asset.symbol} mint address`}
                                title={copiedAddress === asset.address ? "Copied" : "Copy mint address"}
                              >
                                {copiedAddress === asset.address ? <CheckIcon /> : <ClipboardIcon />}
                              </button>
                            </div>
                            <span className={`verification-pill ${asset.isVerified ? "verified" : "unverified"}`}>
                              {asset.isVerified ? "Verified" : "Unverified"}
                            </span>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td data-label="Tier">{asset.tier}</td>
                    <td data-label="Status">
                      <span className={`status-pill status-${asset.status}`}>{statusMeta[asset.status].label}</span>
                    </td>
                    <td data-label="Collateral on">
                      <ProtocolBadgeList items={asset.collateralProtocols} />
                    </td>
                    <td data-label="Borrowable on">
                      <ProtocolBadgeList items={asset.borrowableProtocols} />
                    </td>
                    <td data-label="Presence">{asset.marketPresence}</td>
                    <td data-label="Why it matters" className="note-cell">{asset.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {visibleCount < filteredAssets.length ? (
            <div className="table-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() =>
                  startTransition(() => {
                    setVisibleCount((current) => current + INITIAL_VISIBLE_ASSETS);
                  })
                }
              >
                Load {formatCount(Math.min(INITIAL_VISIBLE_ASSETS, filteredAssets.length - visibleCount))} more
              </button>
            </div>
          ) : null}
        </section>

        <section className="method-grid">
          <article className="surface method-card surface-method surface-method-a">
            <p className="eyebrow">Methodology</p>
            <h2>tokens.loans starts with the full Jupiter-indexed token set, not a handpicked watchlist.</h2>
            <p>
              <AnimatedNumber value={snapshotMeta.indexedTokenCount} formatter={(current) => formatCount(Math.round(current))} />{" "}
              indexed tokens flowed into the pipeline.{" "}
              <AnimatedNumber value={snapshotMeta.candidateTokenCount} formatter={(current) => formatCount(Math.round(current))} />{" "}
              passed routeability, verification, or recent activity checks, and{" "}
              <AnimatedNumber value={allAssets.length} formatter={(current) => formatCount(Math.round(current))} /> remained
              after the inactive-token filter.
            </p>
          </article>

          <article className="surface method-card surface-method surface-method-b">
            <p className="eyebrow">Filter logic</p>
            <h2>Dead tokens are removed using current market activity, not manual taste.</h2>
            <p>{snapshotMeta.methodology}</p>
          </article>
        </section>
      </main>
    </div>
  );
}

function StatCard({
  className = "",
  label,
  value,
  formatter,
  detail,
}: {
  className?: string;
  label: string;
  value: number;
  formatter: (value: number) => string;
  detail: string;
}) {
  return (
    <article className={`surface stat-card ${className}`.trim()}>
      <span>{label}</span>
      <strong>
        <AnimatedNumber value={value} formatter={formatter} />
      </strong>
      <p>{detail}</p>
    </article>
  );
}

function AnimatedNumber({
  value,
  formatter,
  duration,
}: {
  value: number;
  formatter: (value: number) => string;
  duration?: number;
}) {
  const animatedValue = useAnimatedNumber(value, duration);
  return <>{formatter(animatedValue)}</>;
}

export default App;
