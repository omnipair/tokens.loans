import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "@vercel/og";
import { getSnapshot } from "./assets";
import type { AssetSnapshotPayload } from "../src/types";

export const runtime = "nodejs";
export const contentType = "image/png";

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const OG_CACHE_CONTROL = "public, max-age=0, s-maxage=300, stale-while-revalidate=3600";
const BRAND_LOGO_SVG = `<svg width="150" height="150" viewBox="0 0 150 150" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="150" height="150" fill="#06130F"/><path d="M59 37H71.544L74.104 47.7295H91V60.9836H75.96V91.468C75.96 97.6533 78.6693 100.746 84.088 100.746H91V114H75.896C64.632 114 59 108.046 59 96.1385V37Z" fill="#B8FF37"/></svg>`;
const BRAND_LOGO_DATA_URL = `data:image/svg+xml;base64,${Buffer.from(BRAND_LOGO_SVG).toString("base64")}`;
let fontPromise: Promise<NonNullable<ConstructorParameters<typeof ImageResponse>[1]>["fonts"]> | null = null;

function hasBorrowAccess(asset: AssetSnapshotPayload["assets"][number]) {
  return Object.values(asset.protocols).some((value) => value === "borrow" || value === "both");
}

function hasCollateralAccess(asset: AssetSnapshotPayload["assets"][number]) {
  return Object.values(asset.protocols).some((value) => value === "collateral" || value === "both");
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function bufferToArrayBuffer(buffer: Buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

async function loadOgFonts() {
  if (!fontPromise) {
    fontPromise = (async () => {
      const publicDir = path.join(process.cwd(), "public", "fonts");
      const [regular, medium, semibold] = await Promise.all([
        readFile(path.join(publicDir, "aeonik-regular.woff2")),
        readFile(path.join(publicDir, "aeonik-medium.woff2")),
        readFile(path.join(publicDir, "aeonik-semibold.woff2")),
      ]);

      return [
        { name: "Aeonik", data: bufferToArrayBuffer(regular), weight: 400, style: "normal" as const },
        { name: "Aeonik", data: bufferToArrayBuffer(medium), weight: 500, style: "normal" as const },
        { name: "Aeonik", data: bufferToArrayBuffer(semibold), weight: 700, style: "normal" as const },
      ];
    })();
  }

  return fontPromise;
}

function buildOgModel(snapshot: AssetSnapshotPayload) {
  const activeCount = snapshot.meta.activeTokenCount || snapshot.assets.length;
  const borrowableAssets = snapshot.assets.filter(hasBorrowAccess);
  const collateralAssets = snapshot.assets.filter(hasCollateralAccess);
  const supportedAssets = snapshot.assets.filter((asset) => hasBorrowAccess(asset) || hasCollateralAccess(asset));
  const excludedCount = Math.max(0, activeCount - supportedAssets.length);

  return {
    activeCount,
    borrowableCount: borrowableAssets.length,
    supportedCount: supportedAssets.length,
    collateralCount: collateralAssets.length,
    excludedCount,
  };
}

async function buildImageResponse(snapshot: AssetSnapshotPayload, cacheStatus?: string, ageSeconds?: number) {
  const model = buildOgModel(snapshot);
  const headlineLead = "tokens have lending";
  const headlineTail = "access on Solana";
  const fonts = await loadOgFonts();

  const response = new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          position: "relative",
          overflow: "hidden",
          padding: "56px 64px 42px",
          background: "linear-gradient(135deg, #06130f 0%, #0b1e17 58%, #10291f 100%)",
          color: "#f7fff8",
          fontFamily: "Aeonik",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            backgroundImage:
              "linear-gradient(rgba(184, 255, 55, 0.075) 1px, transparent 1px), linear-gradient(90deg, rgba(184, 255, 55, 0.075) 1px, transparent 1px)",
            backgroundSize: "36px 36px",
            opacity: 0.42,
          }}
        />
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: 18,
            background: "linear-gradient(90deg, #b8ff37 0%, #7ff0ce 54%, #f7fff8 100%)",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: -80,
            right: -80,
            bottom: 120,
            height: 130,
            transform: "rotate(-4deg)",
            background: "linear-gradient(90deg, rgba(184,255,55,0.18), rgba(127,240,206,0.06), rgba(255,255,255,0))",
          }}
        />

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", position: "relative" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <img
              src={BRAND_LOGO_DATA_URL}
              alt="tokens.loans"
              width={56}
              height={56}
              style={{ width: 56, height: 56, display: "flex", objectFit: "contain" }}
            />
            <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 4, height: 56 }}>
              <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: 0 }}>tokens.loans</div>
              <div style={{ fontSize: 18, fontWeight: 400, color: "#9bad9f", letterSpacing: 0 }}>
                Solana lending coverage
              </div>
            </div>
          </div>
          <div style={{ fontSize: 22, fontWeight: 500, color: "#9bad9f", letterSpacing: 0 }}>
            Updated {formatDate(snapshot.meta.generatedAt)}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 26, position: "relative" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 28 }}>
            <div style={{ fontSize: 224, lineHeight: 0.86, fontWeight: 700, letterSpacing: 0, color: "#b8ff37" }}>
              {formatInteger(model.supportedCount)}
            </div>
            <div style={{ fontSize: 88, lineHeight: 1, fontWeight: 700, letterSpacing: 0, color: "#f7fff8" }}>
              / {formatInteger(model.activeCount)}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <div style={{ fontSize: 78, lineHeight: 1.02, fontWeight: 700, letterSpacing: 0, color: "#f7fff8" }}>
              {headlineLead}
            </div>
            <div style={{ fontSize: 78, lineHeight: 1.02, fontWeight: 700, letterSpacing: 0, color: "#f7fff8" }}>
              {headlineTail}
            </div>
          </div>
        </div>

        <div />
      </div>
    ),
    {
      width: OG_WIDTH,
      height: OG_HEIGHT,
      fonts,
    },
  );

  response.headers.set("Cache-Control", OG_CACHE_CONTROL);
  if (cacheStatus) {
    response.headers.set("X-Data-Cache", cacheStatus);
  }
  if (typeof ageSeconds === "number") {
    response.headers.set("X-Data-Age-Seconds", String(ageSeconds));
  }
  return response;
}

async function buildFallbackResponse(message: string) {
  const fonts = await loadOgFonts();
  const response = new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "56px 64px",
          background: "linear-gradient(135deg, #06130f 0%, #0b1e17 58%, #10291f 100%)",
          color: "#f7fff8",
          fontFamily: "Aeonik",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <img src={BRAND_LOGO_DATA_URL} alt="tokens.loans" width={56} height={56} style={{ width: 56, height: 56, display: "flex", objectFit: "contain" }} />
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 4, height: 56 }}>
            <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: 0 }}>tokens.loans</div>
            <div style={{ fontSize: 18, color: "#9bad9f" }}>Solana lending coverage</div>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: 0, color: "#b8ff37" }}>
            LIVE SHARE PREVIEW
          </div>
          <div style={{ fontSize: 92, fontWeight: 700, letterSpacing: 0, lineHeight: 0.96 }}>
            Current lending snapshot is temporarily unavailable.
          </div>
          <div style={{ fontSize: 30, color: "#9bad9f", lineHeight: 1.35 }}>{message}</div>
        </div>

        <div style={{ fontSize: 22, color: "#9bad9f" }}>tokens.loans</div>
      </div>
    ),
    { width: OG_WIDTH, height: OG_HEIGHT, fonts },
  );

  response.headers.set("Cache-Control", OG_CACHE_CONTROL);
  return response;
}

export async function GET() {
  try {
    const { payload, cacheStatus, ageSeconds } = await getSnapshot();
    return await buildImageResponse(payload, cacheStatus, ageSeconds);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown OG image error.";
    return await buildFallbackResponse(message);
  }
}
