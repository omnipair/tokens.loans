import { startTransition, useDeferredValue, useEffect, useMemo, useState } from "react";
import { assetUniverse, enrichAsset, protocolNames, sectorLabels, statusMeta, tierOrder, universeMeta } from "./data";
import type { AccessStatus, EnrichedAsset, ProtocolName, SectorKey } from "./types";

type StatusFilter = AccessStatus | "all";
type SectorFilter = SectorKey | "all";

const INITIAL_VISIBLE_ASSETS = 300;
const allAssets = assetUniverse.map(enrichAsset);

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

function getAssetFallback(symbol: string) {
  const cleaned = symbol.replace(/[^a-z0-9]/gi, "");
  return cleaned.slice(0, 2).toUpperCase() || "?";
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
    logoUrl: "/protocols/marginfi.svg",
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
    logoUrl: "/protocols/loopscale.ico",
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

function App() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sectorFilter, setSectorFilter] = useState<SectorFilter>("all");
  const [query, setQuery] = useState("");
  const [hoveredStatus, setHoveredStatus] = useState<AccessStatus | null>(null);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_ASSETS);
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const deferredQuery = useDeferredValue(query);

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
  }, []);

  const stackEntries = useMemo(() => {
    return (Object.keys(statusMeta) as AccessStatus[]).map((status) => {
      const count = summary.statusCounts[status];

      return {
        status,
        count,
        share: statusShare(count, allAssets.length),
      };
    });
  }, [summary.statusCounts]);

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
  }, [deferredQuery, sectorFilter, statusFilter]);

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

  const visibleAssets = filteredAssets.slice(0, visibleCount);
  const activeStatusCount = summary.statusCounts[focusedStatus];
  const excludedShare = statusShare(summary.statusCounts.excluded, allAssets.length);
  const activeStatusShare = statusShare(activeStatusCount, allAssets.length);
  const filteredShare = statusShare(allAssets.length, universeMeta.indexedTokenCount);
  const featuredAssets = rankAssets(allAssets.filter((asset) => asset.status === focusedStatus))
    .slice(0, 4)
    .map((asset) => asset.symbol);

  async function handleCopyAddress(address: string) {
    try {
      await writeToClipboard(address);
      setCopiedAddress(address);
    } catch {
      window.prompt("Copy mint address:", address);
    }
  }

  return (
    <div className="page-shell">
      <div className="page-orb page-orb-a" />
      <div className="page-orb page-orb-b" />

      <main className="app-shell">
        <section className="hero-panel surface">
          <div className="hero-copy">
            <div className="hero-badges">
              <span className="mini-badge">tokens.loans</span>
              <span className="mini-badge subtle">Updated {formatDate(universeMeta.generatedAt)}</span>
            </div>

            <p className="eyebrow">Solana credit coverage</p>
            <h1>Most live Solana tokens still never make it into lending markets.</h1>
            <p className="hero-description">
              tokens.loans now starts from {formatCount(universeMeta.indexedTokenCount)} Jupiter-indexed Solana tokens,
              filters out dead or inactive assets, and uses the surviving {formatCount(allAssets.length)}-token universe
              as the real denominator for Kamino, marginfi, Save, Drift, Loopscale, and Omnipair coverage.
            </p>

            <div className="hero-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  const table = document.getElementById("asset-table");
                  table?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              >
                Explore the asset map
              </button>
              <div className="hero-signal">
                <strong>{formatPercent(excludedShare, 1)}</strong>
                <span>of active Solana tokens are excluded everywhere</span>
              </div>
            </div>
          </div>

          <aside className="hero-aside">
            <article className="signal-card strong">
              <span className="signal-label">Focused status</span>
              <strong>{statusMeta[focusedStatus].label}</strong>
              <p>{statusMeta[focusedStatus].description}</p>
              <div className="signal-value-row">
                <div>
                  <span>Assets</span>
                  <strong>{formatCount(activeStatusCount)}</strong>
                </div>
                <div>
                  <span>Share</span>
                  <strong>{formatPercent(activeStatusShare, 1)}</strong>
                </div>
              </div>
              <span className="signal-footnote">Examples: {featuredAssets.join(", ") || "No assets in this slice yet"}</span>
            </article>

            <article className="signal-card">
              <span className="signal-label">Universe filter</span>
              <strong>{formatCount(allAssets.length)} active tokens retained</strong>
              <p>
                {formatPercent(filteredShare, 1)} of the {formatCount(universeMeta.indexedTokenCount)} indexed tokens
                survived the dead-token filter.
              </p>
            </article>
          </aside>
        </section>

        <section className="stats-grid">
          <StatCard label="Indexed tokens" value={formatCompactNumber(universeMeta.indexedTokenCount)} detail="Full Jupiter Solana token cache" />
          <StatCard label="Active after filter" value={formatCompactNumber(allAssets.length)} detail="Dead or inactive tokens removed" />
          <StatCard
            label="Accepted as collateral"
            value={formatCount(summary.collateralReach)}
            detail={`${formatPercent(statusShare(summary.collateralReach, allAssets.length), 1)} of the active universe`}
          />
          <StatCard
            label="Borrowable anywhere"
            value={formatCount(summary.borrowReach)}
            detail={`${formatPercent(statusShare(summary.borrowReach, allAssets.length), 1)} of the active universe`}
          />
          <StatCard
            label="Excluded everywhere"
            value={formatCount(summary.statusCounts.excluded)}
            detail={`${formatPercent(excludedShare, 1)} of active tokens`}
          />
        </section>

        <section className="story-grid">
          <article className="surface chart-panel">
            <div className="panel-topline">
              <div>
                <p className="eyebrow">Coverage split</p>
                <h2>The exclusion story gets much sharper once the denominator is real</h2>
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
                  <article className="coverage-stat-card coverage-stat-card-dark">
                    <span className="signal-label">Excluded everywhere</span>
                    <strong>{formatCount(summary.statusCounts.excluded)}</strong>
                    <p>{formatShare(excludedShare)} of active Solana tokens still sit outside every tracked venue.</p>
                  </article>
                  <article className="coverage-stat-card coverage-stat-card-light">
                    <span className="signal-label">Supported anywhere</span>
                    <strong>{formatCount(supportedCount)}</strong>
                    <p>{formatShare(supportedShare)} make it into at least one collateral or borrow market.</p>
                  </article>
                </div>

                <div className="coverage-scale-card">
                  <div className="coverage-scale-head">
                    <div>
                      <p className="eyebrow">Exact share of all active tokens</p>
                      <h3>The top bar stays honest at full-universe scale.</h3>
                    </div>
                    <span className="coverage-total">{formatCount(allAssets.length)} tokens</span>
                  </div>

                  <div className="coverage-track" role="img" aria-label="Exact share of all active tokens by lending coverage status">
                    {stackEntries.map((entry) => (
                      <span
                        key={entry.status}
                        className={`coverage-track-segment ${focusedStatus === entry.status ? "active" : ""}`}
                        style={{
                          width: `${entry.share}%`,
                          background: statusMeta[entry.status].color,
                        }}
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

              <article className="coverage-zoom-card">
                <div className="coverage-scale-head">
                  <div>
                    <p className="eyebrow">Zoom on the supported slice</p>
                    <h3>Most supported tokens still cluster into a very small pool.</h3>
                  </div>
                  <span className="coverage-total">{formatCount(supportedCount)} tokens</span>
                </div>

                <div className="coverage-breakout-list">
                  {supportedEntries.map((entry) => (
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
                          style={{
                            width: `${entry.supportedShare}%`,
                            background: statusMeta[entry.status].color,
                          }}
                        />
                      </div>
                      <span className="coverage-breakout-foot">{formatShare(entry.share)} of all active tokens</span>
                    </button>
                  ))}
                </div>
              </article>
            </div>
          </article>

          <article className="surface detail-panel">
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
                    {(Object.keys(statusMeta) as AccessStatus[]).map((status) => {
                      const count = group.counts[status];
                      const share = statusShare(count, group.total);

                      return (
                        <span
                          key={status}
                          className={`tier-segment ${focusedStatus === status ? "active" : ""}`}
                          style={{
                            width: `${share}%`,
                            background: statusMeta[status].color,
                          }}
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

        <section className="surface protocol-panel">
          <div className="panel-topline">
            <div>
              <p className="eyebrow">Protocol view</p>
              <h2>Even the most permissive venues support only a tiny slice of live tokens</h2>
            </div>
          </div>

          <div className="protocol-list">
            {protocolRows.map((item, index) => (
              <article key={item.protocol} className="protocol-row">
                <div className="protocol-row-head">
                  <span className="protocol-rank">{String(index + 1).padStart(2, "0")}</span>
                  <ProtocolMark protocol={item.protocol} size="lg" />
                  <div className="protocol-copy">
                    <strong>{item.protocol}</strong>
                    <p>
                      {formatCount(item.reachableCount)} supported tokens in snapshot ·{" "}
                      {formatShare(statusShare(item.reachableCount, allAssets.length))} of active universe
                    </p>
                  </div>
                </div>

                <div className="protocol-metric-grid">
                  <div className="protocol-metric">
                    <div className="protocol-metric-head">
                      <span>Collateral</span>
                      <strong>{formatCount(item.collateralCount)}</strong>
                      <span>{formatShare(statusShare(item.collateralCount, allAssets.length))}</span>
                    </div>
                    <div className="protocol-meter" aria-hidden="true">
                      <span
                        className="protocol-meter-fill collateral"
                        style={{ width: `${statusShare(item.collateralCount, protocolMaxCollateral)}%` }}
                      />
                    </div>
                  </div>

                  <div className="protocol-metric">
                    <div className="protocol-metric-head">
                      <span>Borrow</span>
                      <strong>{formatCount(item.borrowCount)}</strong>
                      <span>{formatShare(statusShare(item.borrowCount, allAssets.length))}</span>
                    </div>
                    <div className="protocol-meter" aria-hidden="true">
                      <span
                        className="protocol-meter-fill borrow"
                        style={{ width: `${statusShare(item.borrowCount, protocolMaxBorrow)}%` }}
                      />
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>

          <p className="protocol-note">
            Bar lengths are normalized to the most permissive venue in each column. The percentages stay anchored to the active universe.
          </p>
        </section>

        <section className="surface table-panel" id="asset-table">
          <div className="panel-topline">
            <div>
              <p className="eyebrow">Coverage table</p>
              <h2>Every active token that survived the dead-token filter</h2>
            </div>
            <span className="table-count">
              Showing {formatCount(visibleAssets.length)} of {formatCount(filteredAssets.length)} assets
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
          <article className="surface method-card">
            <p className="eyebrow">Methodology</p>
            <h2>tokens.loans starts with the full Jupiter-indexed token universe, not a handpicked watchlist.</h2>
            <p>
              {formatCount(universeMeta.indexedTokenCount)} indexed tokens flowed into the pipeline. {formatCount(universeMeta.candidateTokenCount)} made the live candidate set through verification, routeability, trending, traded, organic, or recent surfaces, and {formatCount(allAssets.length)} remained after the dead-token filter.
            </p>
          </article>

          <article className="surface method-card">
            <p className="eyebrow">Filter logic</p>
            <h2>Dead tokens are removed using current market activity, not manual taste.</h2>
            <p>{universeMeta.methodology}</p>
          </article>
        </section>
      </main>
    </div>
  );
}

function StatCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="surface stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
    </article>
  );
}

export default App;
