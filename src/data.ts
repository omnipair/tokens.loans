import type {
  AccessStatus,
  AssetRecord,
  AssetSnapshotPayload,
  EnrichedAsset,
  ProtocolAccess,
  ProtocolName,
  SectorKey,
  TierKey,
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
    description: "Listed for both collateral and borrowing on at least one tracked protocol.",
  },
  "collateral-only": {
    label: "Collateral only",
    short: "Collateral",
    color: "#42c4ff",
    description: "Accepted as collateral somewhere, without a tracked borrow listing in this snapshot.",
  },
  "borrow-only": {
    label: "Borrow only",
    short: "Borrow",
    color: "#ffc969",
    description: "Borrowable somewhere, without a tracked collateral listing in this snapshot.",
  },
  excluded: {
    label: "Excluded",
    short: "Excluded",
    color: "#1d2a27",
    description: "Active on Solana, but outside every tracked lending protocol in this snapshot.",
  },
};

export function normalizeProtocols(protocols: Partial<Record<ProtocolName, ProtocolAccess>>): Record<ProtocolName, ProtocolAccess> {
  return {
    Kamino: protocols.Kamino ?? "none",
    marginfi: protocols.marginfi ?? "none",
    Save: protocols.Save ?? "none",
    Drift: protocols.Drift ?? "none",
    Loopscale: protocols.Loopscale ?? "none",
    Omnipair: protocols.Omnipair ?? "none",
  };
}

function accessHasCollateral(access: ProtocolAccess) {
  return access === "collateral" || access === "both";
}

function accessHasBorrow(access: ProtocolAccess) {
  return access === "borrow" || access === "both";
}

export function deriveStatus(collateralProtocols: ProtocolName[], borrowableProtocols: ProtocolName[]): AccessStatus {
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

export function normalizeAssetRecord(asset: AssetRecord): AssetRecord {
  return {
    ...asset,
    protocols: normalizeProtocols(asset.protocols),
  };
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

export function createEnrichedAssets(snapshot: AssetSnapshotPayload): EnrichedAsset[] {
  return snapshot.assets.map((asset) => enrichAsset(normalizeAssetRecord(asset)));
}
