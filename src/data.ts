import rawSnapshot from "./generated/solana-active-universe.json";
import type {
  AccessStatus,
  AssetRecord,
  EnrichedAsset,
  ProtocolAccess,
  ProtocolName,
  SectorKey,
  TierKey,
  UniverseSnapshot,
} from "./types";

export const protocolNames: ProtocolName[] = ["Kamino", "marginfi", "Save", "Drift", "Loopscale", "Omnipair"];

export const sectorLabels: Record<SectorKey, string> = {
  majors: "Majors",
  stables: "Stables",
  staking: "Liquid Staking",
  defi: "DeFi",
  memes: "Memes",
  infrastructure: "Infrastructure",
  "long-tail": "Long Tail",
};

export const tierOrder: TierKey[] = ["Core", "Liquid", "Emerging", "Long Tail"];

export const statusMeta: Record<
  AccessStatus,
  {
    label: string;
    short: string;
    color: string;
    description: string;
  }
> = {
  "full-access": {
    label: "Borrow + collateral",
    short: "Both",
    color: "#7af0be",
    description: "These assets have at least one borrow market and at least one collateral listing.",
  },
  "collateral-only": {
    label: "Collateral only",
    short: "Collateral",
    color: "#42c4ff",
    description: "Listed as collateral somewhere, but not yet broadly borrowable.",
  },
  "borrow-only": {
    label: "Borrow only",
    short: "Borrow",
    color: "#ffc969",
    description: "Available as debt in isolated markets, but not accepted as collateral in this snapshot.",
  },
  excluded: {
    label: "Excluded",
    short: "Excluded",
    color: "#1d2a27",
    description: "Active on Solana, but still outside every tracked lending venue in this snapshot.",
  },
};

const snapshot = rawSnapshot as UniverseSnapshot;

export const universeMeta = snapshot.meta;

function normalizeProtocols(protocols: Partial<Record<ProtocolName, ProtocolAccess>>): Record<ProtocolName, ProtocolAccess> {
  return {
    Kamino: protocols.Kamino ?? "none",
    marginfi: protocols.marginfi ?? "none",
    Save: protocols.Save ?? "none",
    Drift: protocols.Drift ?? "none",
    Loopscale: protocols.Loopscale ?? "none",
    Omnipair: protocols.Omnipair ?? "none",
  };
}

export const assetUniverse: AssetRecord[] = snapshot.assets.map((asset) => ({
  ...asset,
  protocols: normalizeProtocols(asset.protocols),
}));

function accessHasCollateral(access: ProtocolAccess) {
  return access === "collateral" || access === "both";
}

function accessHasBorrow(access: ProtocolAccess) {
  return access === "borrow" || access === "both";
}

function deriveStatus(collateralProtocols: ProtocolName[], borrowableProtocols: ProtocolName[]): AccessStatus {
  if (collateralProtocols.length && borrowableProtocols.length) {
    return "full-access";
  }

  if (collateralProtocols.length) {
    return "collateral-only";
  }

  if (borrowableProtocols.length) {
    return "borrow-only";
  }

  return "excluded";
}

export function enrichAsset(assetRecord: AssetRecord): EnrichedAsset {
  const protocols = normalizeProtocols(assetRecord.protocols);
  const collateralProtocols = protocolNames.filter((protocol) => accessHasCollateral(protocols[protocol]));
  const borrowableProtocols = protocolNames.filter((protocol) => accessHasBorrow(protocols[protocol]));
  const bothCount = protocolNames.filter((protocol) => protocols[protocol] === "both").length;
  const collateralCount = protocolNames.filter((protocol) => protocols[protocol] === "collateral").length;
  const borrowCount = protocolNames.filter((protocol) => protocols[protocol] === "borrow").length;
  const status = deriveStatus(collateralProtocols, borrowableProtocols);
  const coverageScore = Math.min(
    100,
    bothCount * 28 + collateralCount * 18 + borrowCount * 16 + Math.round(assetRecord.marketPresence * 0.38),
  );

  return {
    ...assetRecord,
    protocols,
    collateralProtocols,
    borrowableProtocols,
    protocolDepth: collateralProtocols.length + borrowableProtocols.length,
    status,
    coverageScore,
  };
}
