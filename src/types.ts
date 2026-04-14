export type ProtocolName = "Kamino" | "marginfi" | "Save" | "Drift" | "Loopscale" | "Omnipair";

export type ProtocolAccess = "none" | "collateral" | "borrow" | "both";

export type AccessStatus = "full-access" | "collateral-only" | "borrow-only" | "excluded";

export type SectorKey =
  | "majors"
  | "stables"
  | "staking"
  | "defi"
  | "memes"
  | "infrastructure"
  | "long-tail";

export type TierKey = "Core" | "Liquid" | "Emerging" | "Long Tail";

export type AssetRecord = {
  address: string;
  symbol: string;
  name: string;
  iconUrl?: string | null;
  iconSource?: "helius" | null;
  priceUsd?: number | null;
  priceChange24h?: number | null;
  priceBlockId?: number | null;
  priceSource?: "jupiter" | null;
  sector: SectorKey;
  tier: TierKey;
  marketRank: number;
  marketPresence: number;
  liquidityUsd: number;
  marketCapUsd: number;
  holderCount: number;
  volume24hUsd: number;
  organicScore: number;
  isVerified: boolean;
  tags: string[];
  protocols: Record<ProtocolName, ProtocolAccess>;
  note: string;
};

export type EnrichedAsset = AssetRecord & {
  collateralProtocols: ProtocolName[];
  borrowableProtocols: ProtocolName[];
  protocolDepth: number;
  status: AccessStatus;
  coverageScore: number;
};

export type UniverseSnapshot = {
  meta: {
    generatedAt: string;
    indexedTokenCount: number;
    candidateTokenCount: number;
    activeTokenCount: number;
    sources: string[];
    methodology: string;
  };
  assets: AssetRecord[];
};
