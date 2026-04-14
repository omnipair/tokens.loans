import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const outputPath = path.join(projectRoot, "src", "generated", "solana-active-universe.json");
const DEFAULT_JUPITER_PRICE_URL = "https://api.jup.ag/price/v3";
const DEFAULT_JUPITER_LITE_PRICE_URL = "https://lite-api.jup.ag/price/v3";
const DEFAULT_HELIUS_RPC_URL = "https://mainnet.helius-rpc.com/";
const JUPITER_PRICE_CHUNK_SIZE = 50;
const HELIUS_ASSET_CHUNK_SIZE = 100;

const protocolNames = ["Kamino", "marginfi", "Save", "Drift", "Loopscale", "Omnipair"];

const manualProtocolOverrides = {
  SOL: { Kamino: "both", marginfi: "both", Save: "both", Drift: "both" },
  USDC: { Kamino: "both", marginfi: "both", Save: "both", Drift: "both" },
  USDT: { Kamino: "both", marginfi: "both", Save: "both", Drift: "borrow" },
  JITOSOL: { Kamino: "both", marginfi: "both", Save: "collateral" },
  MSOL: { Kamino: "both", marginfi: "both", Save: "collateral" },
  BSOL: { Kamino: "both", marginfi: "collateral" },
  JLP: { Kamino: "both", Drift: "borrow" },
  JUP: { Kamino: "both", marginfi: "collateral", Drift: "borrow" },
  PYTH: { Kamino: "both", marginfi: "collateral" },
  PYUSD: { Kamino: "collateral", Save: "collateral" },
  USDY: { Kamino: "collateral", Save: "collateral" },
  JTO: { Kamino: "collateral", marginfi: "collateral" },
  KMNO: { Kamino: "collateral", Drift: "borrow" },
  BONK: { Kamino: "collateral" },
  WIF: { Kamino: "collateral" },
  RAY: { Kamino: "collateral" },
  HNT: { Kamino: "collateral" },
  MNGO: { Drift: "borrow" },
};

const stableKeywords = /(^|[^a-z])(usd|usdc|usdt|eurc|pyusd|fdusd|usdx|usdh|dollar|euro)([^a-z]|$)/i;
const stakingKeywords = /(staked|staking|liquid staking|lst)/i;
const memeKeywords = /(bonk|wif|dog|cat|pepe|fart|ponke|mew|popcat|goat|chill|wojak|moodeng|memecoin|pnut|fwog|hamster|harambe)/i;
const infraKeywords = /(pyth|render|helium|mobile|grass|shadow|io\.net|sanctum|tensor|cloud|depin|oracle|network|infra)/i;
const defiKeywords = /(jupiter|jito|kamino|raydium|orca|drift|parcl|marinade|meteora|dex|swap|finance|yield|protocol)/i;

const majorSymbols = new Set([
  "SOL",
  "USDC",
  "USDT",
  "JITOSOL",
  "MSOL",
  "BSOL",
  "JUP",
  "JLP",
  "BONK",
  "WIF",
  "PYTH",
  "JTO",
  "KMNO",
  "RAY",
  "RENDER",
  "HNT",
  "DRIFT",
  "ORCA",
  "PYUSD",
]);

function emptyProtocols() {
  return {
    Kamino: "none",
    marginfi: "none",
    Save: "none",
    Drift: "none",
    Loopscale: "none",
    Omnipair: "none",
  };
}

function compactNumber(value) {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: value >= 100 ? 0 : 1,
  }).format(value);
}

function compactUsd(value) {
  if (!value || value < 1) {
    return "$0";
  }

  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: value >= 100 ? 0 : 1,
  }).format(value);
}

function chunk(items, size) {
  const batches = [];

  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }

  return batches;
}

function normalizeSymbol(symbol) {
  return symbol.trim().toUpperCase().replace(/^\$/, "");
}

function optionalNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeImageUrl(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}

function decodeHtml(text) {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function mergeProtocolAccess(current, incoming) {
  if (!incoming || incoming === "none") {
    return current;
  }

  if (!current || current === "none") {
    return incoming;
  }

  if (current === incoming || current === "both" || incoming === "both") {
    return current === "both" || incoming === "both" ? "both" : current;
  }

  return "both";
}

function mergeProtocolMaps(base, patch) {
  const merged = { ...base };

  for (const [protocol, access] of Object.entries(patch)) {
    merged[protocol] = mergeProtocolAccess(merged[protocol], access);
  }

  return merged;
}

function logScore(value, min, max) {
  if (!value || value <= 0) {
    return 0;
  }

  const safeMin = Math.log10(min);
  const safeMax = Math.log10(max);
  const normalized = (Math.log10(value) - safeMin) / (safeMax - safeMin);
  return Math.min(Math.max(normalized, 0), 1);
}

function routeabilityScore(isRouteable) {
  return isRouteable ? 12 : 0;
}

function classifySector(token) {
  const symbol = token.symbol.toUpperCase();
  const text = `${token.symbol} ${token.name}`.trim();

  if (stableKeywords.test(text)) {
    return "stables";
  }

  if (token.tags.includes("lst") || stakingKeywords.test(text) || /SOL$/i.test(token.symbol) && /staked|stake/i.test(token.name)) {
    return "staking";
  }

  if (token.tags.includes("major") || majorSymbols.has(symbol)) {
    return "majors";
  }

  if (memeKeywords.test(text) || (!token.isVerified && token.liquidityUsd < 5_000_000 && token.holderCount < 200_000)) {
    return "memes";
  }

  if (infraKeywords.test(text)) {
    return "infrastructure";
  }

  if (defiKeywords.test(text)) {
    return "defi";
  }

  return "long-tail";
}

function classifyTier(token) {
  if (
    token.marketPresence >= 92 ||
    token.liquidityUsd >= 25_000_000 ||
    token.marketCapUsd >= 2_000_000_000 ||
    token.holderCount >= 250_000
  ) {
    return "Core";
  }

  if (
    token.marketPresence >= 72 ||
    token.liquidityUsd >= 1_000_000 ||
    token.marketCapUsd >= 100_000_000 ||
    token.holderCount >= 15_000
  ) {
    return "Liquid";
  }

  if (
    token.marketPresence >= 40 ||
    token.liquidityUsd >= 50_000 ||
    token.marketCapUsd >= 1_500_000 ||
    token.holderCount >= 400
  ) {
    return "Emerging";
  }

  return "Long Tail";
}

function deriveStatus(protocols) {
  const collateral = protocolNames.filter((protocol) => protocols[protocol] === "collateral" || protocols[protocol] === "both");
  const borrow = protocolNames.filter((protocol) => protocols[protocol] === "borrow" || protocols[protocol] === "both");

  if (collateral.length && borrow.length) {
    return "full-access";
  }

  if (collateral.length) {
    return "collateral-only";
  }

  if (borrow.length) {
    return "borrow-only";
  }

  return "excluded";
}

async function loadEnvFile(filename) {
  try {
    const file = await readFile(path.join(projectRoot, filename), "utf8");

    for (const rawLine of file.split(/\r?\n/)) {
      const line = rawLine.trim();

      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = line.indexOf("=");

      if (separatorIndex < 0) {
        continue;
      }

      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");

      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function loadLocalEnv() {
  await loadEnvFile(".env.local");
  await loadEnvFile(".env");
}

function buildNote(token, protocols) {
  const collateral = protocolNames.filter((protocol) => protocols[protocol] === "collateral" || protocols[protocol] === "both");
  const borrow = protocolNames.filter((protocol) => protocols[protocol] === "borrow" || protocols[protocol] === "both");
  const status = deriveStatus(protocols);
  const marketSentence = `${compactNumber(token.holderCount)} holders and ${compactUsd(token.liquidityUsd)} liquidity`;

  if (status === "full-access") {
    return `${marketSentence}; one of the rare Solana assets accepted in both collateral and borrow flows across tracked venues.`;
  }

  if (status === "collateral-only") {
    return `${marketSentence}; accepted as collateral on ${collateral.join(", ")}, but still not broadly borrowable.`;
  }

  if (status === "borrow-only") {
    return `${marketSentence}; visible in isolated borrow venues on ${borrow.join(", ")}, but not accepted as collateral.`;
  }

  return `${marketSentence}; active on Solana, but excluded from every tracked lending venue.`;
}

function canonicalScore(meta, details) {
  const liquidity = details?.liquidity ?? 0;
  const holders = details?.holderCount ?? 0;
  const mcap = details?.mcap ?? 0;
  const verified = details?.isVerified ? 1 : 0;
  const routeable = details?.routeable ? 1 : 0;

  return (
    verified * 50_000 +
    routeable * 25_000 +
    Math.round(logScore(liquidity, 1_000, 1_000_000_000) * 10_000) +
    Math.round(logScore(holders, 10, 5_000_000) * 5_000) +
    Math.round(logScore(mcap, 50_000, 10_000_000_000) * 8_000) +
    (meta?.name?.length ? 100 : 0)
  );
}

function isRecentDate(dateString) {
  if (!dateString) {
    return false;
  }

  const age = Date.now() - new Date(dateString).getTime();
  return Number.isFinite(age) && age <= 1000 * 60 * 60 * 24 * 30;
}

async function fetchJson(url) {
  let response = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(url);

    if (response.ok) {
      return response.json();
    }

    if (response.status !== 429 && response.status < 500) {
      break;
    }

    await sleep(800 * 2 ** attempt);
  }

  if (!response?.ok) {
    throw new Error(`Failed to fetch ${url}: ${response?.status ?? "unknown"}`);
  }
}

async function fetchText(url) {
  let response = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(url);

    if (response.ok) {
      return response.text();
    }

    if (response.status !== 429 && response.status < 500) {
      break;
    }

    await sleep(800 * 2 ** attempt);
  }

  if (!response?.ok) {
    throw new Error(`Failed to fetch ${url}: ${response?.status ?? "unknown"}`);
  }
}

function getHeliusAssetImage(asset) {
  return normalizeImageUrl(
    asset?.content?.links?.image ??
      asset?.content?.files?.find((file) => file?.mime?.startsWith?.("image/"))?.uri ??
      null,
  );
}

function extractLoopscaleSectionSymbols(html, sectionId) {
  const sectionIndex = html.indexOf(`id="${sectionId}"`);

  if (sectionIndex < 0) {
    return new Set();
  }

  const tbodyStart = html.indexOf("<tbody>", sectionIndex);
  const tbodyEnd = html.indexOf("</tbody>", tbodyStart);

  if (tbodyStart < 0 || tbodyEnd < 0) {
    return new Set();
  }

  const sectionHtml = html.slice(tbodyStart, tbodyEnd);
  const rowMatches = sectionHtml.matchAll(/<tr>(.*?)<\/tr>/gs);
  const symbols = new Set();

  for (const match of rowMatches) {
    const firstCell = match[1].match(/<td[^>]*>(.*?)<\/td>/s);

    if (!firstCell) {
      continue;
    }

    const symbol = normalizeSymbol(decodeHtml(firstCell[1]));

    if (symbol) {
      symbols.add(symbol);
    }
  }

  return symbols;
}

async function fetchLoopscaleSupport() {
  const html = await fetchText("https://docs.loopscale.com/resources/asset-parameters");

  return {
    debtSymbols: extractLoopscaleSectionSymbols(html, "debt-assets"),
    collateralSymbols: extractLoopscaleSectionSymbols(html, "collateral-assets"),
  };
}

async function fetchOmnipairSupport() {
  const response = await fetchJson("https://api.indexer.omnipair.fi/api/v1/pools?limit=1000");
  const pools = response?.data?.pools ?? [];
  const addresses = new Set();

  for (const pool of pools) {
    for (const side of ["token0", "token1"]) {
      const token = pool[side];

      if (!token) {
        continue;
      }

      if (token.address) {
        addresses.add(token.address);
      }
    }
  }

  return { addresses };
}

async function fetchHeliusTokenMetadata(tokenAddresses, { heliusApiKey, heliusRpcUrl }) {
  const metadata = new Map();

  if (!heliusApiKey || !tokenAddresses.length) {
    return metadata;
  }

  const endpoint = new URL(heliusRpcUrl);
  endpoint.searchParams.set("api-key", heliusApiKey);

  const assetBatches = await Promise.all(
    chunk(tokenAddresses, HELIUS_ASSET_CHUNK_SIZE).map(async (tokenChunk) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "borrowables-token-metadata",
          method: "getAssetBatch",
          params: { ids: tokenChunk },
        }),
      });

      if (!response.ok) {
        throw new Error(`Helius token metadata request failed with ${response.status}`);
      }

      const payload = await response.json();

      if (payload.error) {
        throw new Error(payload.error.message ?? "Helius returned an unknown token metadata error.");
      }

      return payload.result ?? [];
    }),
  );

  for (const asset of assetBatches.flat()) {
    if (!asset?.id) {
      continue;
    }

    metadata.set(asset.id, {
      iconUrl: getHeliusAssetImage(asset),
    });
  }

  return metadata;
}

async function fetchJupiterTokenPrices(tokenAddresses, { jupiterApiKey, jupiterPriceUrl }) {
  const prices = new Map();

  if (!tokenAddresses.length) {
    return prices;
  }

  const priceBatches = [];
  const tokenChunks = chunk(tokenAddresses, jupiterApiKey ? JUPITER_PRICE_CHUNK_SIZE : 20);

  async function fetchPriceBatch(tokenChunk) {
    const endpoint = new URL(jupiterPriceUrl);
    endpoint.searchParams.set("ids", tokenChunk.join(","));

    const headers = jupiterApiKey ? { "x-api-key": jupiterApiKey } : {};
    let response = null;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      response = await fetch(endpoint, { headers });

      if (response.ok) {
        break;
      }

      if (!jupiterApiKey && jupiterPriceUrl !== DEFAULT_JUPITER_LITE_PRICE_URL) {
        const fallbackEndpoint = new URL(DEFAULT_JUPITER_LITE_PRICE_URL);
        fallbackEndpoint.searchParams.set("ids", tokenChunk.join(","));
        response = await fetch(fallbackEndpoint);

        if (response.ok) {
          break;
        }
      }

      if (response.status !== 429 && response.status < 500) {
        break;
      }

      await sleep(800 * 2 ** attempt);
    }

    if (!response?.ok) {
      throw new Error(`Jupiter price request failed with ${response?.status ?? "unknown"}`);
    }

    return response.json();
  }

  if (jupiterApiKey) {
    priceBatches.push(...(await Promise.all(tokenChunks.map((tokenChunk) => fetchPriceBatch(tokenChunk)))));
  } else {
    for (const tokenChunk of tokenChunks) {
      priceBatches.push(await fetchPriceBatch(tokenChunk));
    }
  }

  for (const payload of priceBatches) {
    for (const [address, quote] of Object.entries(payload)) {
      prices.set(address, {
        priceUsd: optionalNumber(quote?.usdPrice),
        priceChange24h: optionalNumber(quote?.priceChange24h),
        priceBlockId: optionalNumber(quote?.blockId),
      });
    }
  }

  return prices;
}

async function fetchTokenEnrichments(tokenAddresses, options) {
  const uniqueAddresses = Array.from(new Set(tokenAddresses.filter(Boolean)));
  const [heliusResult, jupiterResult] = await Promise.allSettled([
    fetchHeliusTokenMetadata(uniqueAddresses, options),
    fetchJupiterTokenPrices(uniqueAddresses, options),
  ]);

  if (!options.heliusApiKey) {
    console.warn("HELIUS_API_KEY is not configured, so token icons will fall back to symbol marks.");
  } else if (heliusResult.status === "rejected") {
    console.warn(
      `Helius token metadata unavailable: ${heliusResult.reason instanceof Error ? heliusResult.reason.message : "unknown error"}.`,
    );
  }

  if (jupiterResult.status === "rejected") {
    console.warn(
      `Jupiter token prices unavailable: ${jupiterResult.reason instanceof Error ? jupiterResult.reason.message : "unknown error"}.`,
    );
  }

  return {
    metadataByAddress: heliusResult.status === "fulfilled" ? heliusResult.value : new Map(),
    pricesByAddress: jupiterResult.status === "fulfilled" ? jupiterResult.value : new Map(),
  };
}

async function main() {
  await loadLocalEnv();

  const heliusApiKey = process.env.HELIUS_API_KEY;
  const heliusRpcUrl = process.env.HELIUS_RPC_URL || DEFAULT_HELIUS_RPC_URL;
  const jupiterApiKey = process.env.JUPITER_API_KEY;
  const jupiterPriceUrl = process.env.JUPITER_PRICE_URL || DEFAULT_JUPITER_PRICE_URL;
  const [indexedTokens, routeMap, loopscaleSupport, omnipairSupport] = await Promise.all([
    fetchJson("https://cache.jup.ag/tokens"),
    fetchJson("https://cache.jup.ag/indexed-route-map"),
    fetchLoopscaleSupport(),
    fetchOmnipairSupport(),
  ]);
  const verifiedTokens = await fetchJson("https://lite-api.jup.ag/tokens/v2/tag?query=verified");
  const topTraded = await fetchJson("https://lite-api.jup.ag/tokens/v2/toptraded/24h?limit=100");
  const topOrganic = await fetchJson("https://lite-api.jup.ag/tokens/v2/toporganicscore/24h?limit=100");
  const topTrending = await fetchJson("https://lite-api.jup.ag/tokens/v2/toptrending/24h?limit=100");
  const recentTokens = await fetchJson("https://lite-api.jup.ag/tokens/v2/recent?limit=100");

  const indexedById = new Map(indexedTokens.map((token) => [token.address, token]));
  const indexedBySymbol = new Map();

  for (const token of indexedTokens) {
    const key = normalizeSymbol(token.symbol || "");
    if (!key) {
      continue;
    }

    const list = indexedBySymbol.get(key) ?? [];
    list.push(token);
    indexedBySymbol.set(key, list);
  }

  const routeableIds = new Set(routeMap.mintKeys);
  const topTradedIds = new Set(topTraded.map((token) => token.id));
  const topOrganicIds = new Set(topOrganic.map((token) => token.id));
  const topTrendingIds = new Set(topTrending.map((token) => token.id));
  const recentIds = new Set(recentTokens.map((token) => token.id));

  const candidateIds = new Set(routeMap.mintKeys);
  const detailById = new Map(verifiedTokens.map((token) => [token.id, token]));

  for (const collection of [verifiedTokens, topTraded, topOrganic, topTrending, recentTokens]) {
    for (const token of collection) {
      candidateIds.add(token.id);
      detailById.set(token.id, token);
    }
  }

  const protocolOverridesBySymbol = new Map();
  const protocolOverridesById = new Map();

  for (const [symbol, protocols] of Object.entries(manualProtocolOverrides)) {
    protocolOverridesBySymbol.set(normalizeSymbol(symbol), mergeProtocolMaps(emptyProtocols(), protocols));
  }

  for (const symbol of loopscaleSupport.debtSymbols) {
    protocolOverridesBySymbol.set(
      symbol,
      mergeProtocolMaps(protocolOverridesBySymbol.get(symbol) ?? emptyProtocols(), { Loopscale: "borrow" }),
    );
  }

  for (const symbol of loopscaleSupport.collateralSymbols) {
    protocolOverridesBySymbol.set(
      symbol,
      mergeProtocolMaps(protocolOverridesBySymbol.get(symbol) ?? emptyProtocols(), { Loopscale: "collateral" }),
    );
  }

  for (const symbol of protocolOverridesBySymbol.keys()) {
    const matches = indexedBySymbol.get(symbol) ?? [];

    for (const match of matches) {
      candidateIds.add(match.address);
    }
  }

  for (const address of omnipairSupport.addresses) {
    candidateIds.add(address);
    protocolOverridesById.set(
      address,
      mergeProtocolMaps(protocolOverridesById.get(address) ?? emptyProtocols(), { Omnipair: "both" }),
    );
  }

  const unresolvedIds = [...candidateIds].filter((id) => !detailById.has(id));

  for (let index = 0; index < unresolvedIds.length; index += 50) {
    const batch = unresolvedIds.slice(index, index + 50);
    const query = encodeURIComponent(batch.join(","));
    const results = await fetchJson(`https://lite-api.jup.ag/tokens/v2/search?query=${query}`);

    for (const token of results) {
      detailById.set(token.id, token);
    }
  }

  const canonicalOverrideById = new Map();

  for (const [address, protocols] of protocolOverridesById.entries()) {
    canonicalOverrideById.set(address, protocols);
  }

  for (const [symbol, protocols] of protocolOverridesBySymbol.entries()) {
    const matches = indexedBySymbol.get(symbol) ?? [];

    if (!matches.length) {
      continue;
    }

    const winner = matches.reduce((best, current) => {
      const bestScore = canonicalScore(best, detailById.get(best.address));
      const currentScore = canonicalScore(current, detailById.get(current.address));
      return currentScore > bestScore ? current : best;
    });

    canonicalOverrideById.set(
      winner.address,
      mergeProtocolMaps(canonicalOverrideById.get(winner.address) ?? emptyProtocols(), protocols),
    );
  }

  const filteredAssets = [];

  for (const id of candidateIds) {
    const indexed = indexedById.get(id);
    const details = detailById.get(id);

    if (!indexed && !details) {
      continue;
    }

    const symbol = (details?.symbol || indexed?.symbol || "").trim();
    const name = (details?.name || indexed?.name || "").trim();

    if (!symbol || !name) {
      continue;
    }

    const liquidityUsd = details?.liquidity ?? 0;
    const marketCapUsd = details?.mcap ?? 0;
    const holderCount = details?.holderCount ?? 0;
    const volume24hUsd = (details?.stats24h?.buyVolume ?? 0) + (details?.stats24h?.sellVolume ?? 0);
    const organicScore = details?.organicScore ?? 0;
    const isVerified = Boolean(details?.isVerified);
    const routeable = routeableIds.has(id);
    const onHotList = topTradedIds.has(id) || topOrganicIds.has(id) || topTrendingIds.has(id) || recentIds.has(id);
    const recentPool = isRecentDate(details?.firstPool?.createdAt) || isRecentDate(details?.createdAt);
    const protocols = mergeProtocolMaps(emptyProtocols(), canonicalOverrideById.get(id) ?? {});
    const hasProtocolListing = protocolNames.some((protocol) => protocols[protocol] !== "none");
    const keepVerified =
      isVerified &&
      (
        liquidityUsd >= 1_000 ||
        holderCount >= 50 ||
        marketCapUsd >= 50_000 ||
        volume24hUsd >= 1_000 ||
        organicScore >= 1 ||
        recentPool
      );
    const keepUnverified =
      !isVerified &&
      (
        routeable ||
        onHotList ||
        (liquidityUsd >= 5_000 && holderCount >= 50) ||
        marketCapUsd >= 250_000 ||
        volume24hUsd >= 10_000 ||
        organicScore >= 10 ||
        recentPool
      );

    if (!(hasProtocolListing || keepVerified || keepUnverified)) {
      continue;
    }

    const marketPresence = Math.min(
      100,
      Math.round(
        logScore(liquidityUsd, 1_000, 1_000_000_000) * 38 +
          logScore(marketCapUsd, 50_000, 10_000_000_000) * 28 +
          logScore(holderCount, 10, 5_000_000) * 18 +
          logScore(volume24hUsd, 1_000, 5_000_000_000) * 12 +
          Math.min(organicScore, 100) * 0.04 +
          routeabilityScore(routeable),
      ),
    );

    const tags = Array.from(new Set(details?.tags ?? indexed?.tags ?? [])).filter(Boolean);
    const provisional = {
      address: id,
      symbol,
      name,
      liquidityUsd,
      marketCapUsd,
      holderCount,
      volume24hUsd,
      organicScore,
      isVerified,
      tags,
      marketPresence,
    };
    const sector = classifySector(provisional);
    const tier = classifyTier(provisional);

    filteredAssets.push({
      ...provisional,
      sector,
      tier,
      protocols,
      note: buildNote(provisional, protocols),
    });
  }

  filteredAssets.sort((left, right) => {
    return (
      right.marketPresence - left.marketPresence ||
      right.liquidityUsd - left.liquidityUsd ||
      right.marketCapUsd - left.marketCapUsd ||
      right.holderCount - left.holderCount ||
      left.symbol.localeCompare(right.symbol)
    );
  });

  const { metadataByAddress, pricesByAddress } = await fetchTokenEnrichments(
    filteredAssets.map((asset) => asset.address),
    { heliusApiKey, heliusRpcUrl, jupiterApiKey, jupiterPriceUrl },
  );

  const assets = filteredAssets.map((asset, index) => {
    const tokenMetadata = metadataByAddress.get(asset.address);
    const tokenPrice = pricesByAddress.get(asset.address);

    return {
      address: asset.address,
      symbol: asset.symbol,
      name: asset.name,
      iconUrl: tokenMetadata?.iconUrl ?? null,
      iconSource: tokenMetadata?.iconUrl ? "helius" : null,
      priceUsd: tokenPrice?.priceUsd ?? null,
      priceChange24h: tokenPrice?.priceChange24h ?? null,
      priceBlockId: tokenPrice?.priceBlockId ?? null,
      priceSource: tokenPrice?.priceUsd !== null && tokenPrice?.priceUsd !== undefined ? "jupiter" : null,
      sector: asset.sector,
      tier: asset.tier,
      marketRank: index + 1,
      marketPresence: asset.marketPresence,
      liquidityUsd: Math.round(asset.liquidityUsd),
      marketCapUsd: Math.round(asset.marketCapUsd),
      holderCount: asset.holderCount,
      volume24hUsd: Math.round(asset.volume24hUsd),
      organicScore: Number(asset.organicScore.toFixed(2)),
      isVerified: asset.isVerified,
      tags: asset.tags,
      protocols: asset.protocols,
      note: asset.note,
    };
  });

  const payload = {
    meta: {
      generatedAt: new Date().toISOString(),
      indexedTokenCount: indexedTokens.length,
      candidateTokenCount: candidateIds.size,
      activeTokenCount: assets.length,
      sources: [
        "https://cache.jup.ag/tokens",
        "https://cache.jup.ag/indexed-route-map",
        "https://lite-api.jup.ag/tokens/v2/tag?query=verified",
        "https://lite-api.jup.ag/tokens/v2/toptraded/24h?limit=100",
        "https://lite-api.jup.ag/tokens/v2/toporganicscore/24h?limit=100",
        "https://lite-api.jup.ag/tokens/v2/toptrending/24h?limit=100",
        "https://lite-api.jup.ag/tokens/v2/recent?limit=100",
        jupiterPriceUrl,
        "https://docs.loopscale.com/resources/asset-parameters",
        "https://api.indexer.omnipair.fi/api/v1/pools?limit=1000",
        ...(heliusApiKey ? [heliusRpcUrl] : []),
      ],
      methodology:
        "Start from Jupiter's full Solana token cache, keep tokens that remain routeable, verified, recent, or visibly active on Jupiter surfaces, add assets supported by tracked protocols including Loopscale and Omnipair, then drop dead or inactive tokens using liquidity, holder, market-cap, and trading-activity thresholds. Surviving assets are enriched with Jupiter spot prices and Helius token imagery when configured.",
    },
    assets,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);

  console.log(
    `Wrote ${assets.length.toLocaleString()} active Solana tokens from ${indexedTokens.length.toLocaleString()} indexed Jupiter tokens to ${outputPath}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
