"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Map, Marker, NavigationControl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  Archive,
  Bell,
  BellOff,
  BellRing,
  Check,
  CircleAlert,
  Clock,
  Copy,
  Download,
  ExternalLink,
  Flame,
  ImageDown,
  Layers3,
  Link2,
  LoaderCircle,
  MapPin,
  Play,
  RefreshCw,
  Satellite,
  Settings,
  ShieldAlert,
  Thermometer,
  TrendingUp,
  Video,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Toaster } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Position = [number, number];
type Geometry = {
  type: "Point" | "Polygon" | "MultiPolygon";
  coordinates: unknown;
};
type Feature = {
  type: "Feature";
  geometry: Geometry | null;
  properties: Record<string, unknown>;
};
type FeatureCollection = { type: "FeatureCollection"; features: Feature[] };
type DashboardData = {
  fires: FeatureCollection;
  perimeters: FeatureCollection;
  evacuations: FeatureCollection;
  hotspots: FeatureCollection;
  fetchedAt: number;
  feedStatus?: Record<string, boolean>;
  sources?: Record<string, string>;
  error?: string;
};
type Snapshot = {
  incidentName: string;
  capturedAt: number;
  perimeterDate: number | null;
  acres: number | null;
  contained: number | null;
  state: string | null;
  county: string | null;
  geometry: Geometry;
};
type DmaPreference = { id: string; name: string; state: string; abbreviation: string };
type DmaFeature = { type: "Feature"; geometry: Geometry; properties: Record<string, unknown> };
type AlertPreferences = {
  coverageNewFires: boolean;
  evacuationChanges: boolean;
  growthThresholdAcres: number;
  containmentThresholdPoints: number;
};
type FollowedFire = {
  id: string;
  name: string;
  acres: number | null;
  contained: number | null;
  evacuationHash: string;
  updatedAt: number;
};
type NearbyCamera = {
  name: string;
  cameraId: string;
  county: string | null;
  distanceMiles: number;
  url: string;
};
type MetricId = "tracked" | "new" | "perimeters" | "evacuations" | "hotspots" | "following" | "acres" | "updated";
type FireConditions = {
  updatedAt: number;
  weather: {
    temperatureF: number | null;
    humidityPercent: number | null;
    precipitationIn: number | null;
    windMph: number | null;
    windGustMph: number | null;
    windDirectionDegrees: number | null;
    windDirection: string | null;
  };
  airQuality: { aqi: number | null; pm25: number | null; pm10: number | null; smokeSignal: boolean };
  alerts: Array<{
    id: string | null;
    event: string;
    severity: string;
    urgency: string;
    headline: string | null;
    effective: string | null;
    ends: string | null;
    instruction: string | null;
    web: string | null;
  }>;
  sources: { weather: string | null; airQuality: string | null; alerts: string | null };
  feedStatus: { weather: boolean; airQuality: boolean; alerts: boolean };
  error?: string;
};

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const DMA_STORAGE_KEY = "fire-growth-tracker-dma";
const ALERT_STORAGE_KEY = "fire-growth-tracker-alert-preferences";
const FOLLOWED_FIRES_KEY = "fire-growth-tracker-followed-fires";
const METRICS_STORAGE_KEY = "fire-growth-tracker-metrics";
const DEFAULT_METRICS: MetricId[] = ["tracked", "new", "perimeters", "evacuations", "hotspots"];
const DEFAULT_ALERTS: AlertPreferences = {
  coverageNewFires: true,
  evacuationChanges: true,
  growthThresholdAcres: 100,
  containmentThresholdPoints: 10,
};

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatAcres(value: unknown) {
  const acres = numberValue(value);
  return acres === null ? "Size unavailable" : `${Math.round(acres).toLocaleString()} acres`;
}

function formatDate(value: unknown, compact = false) {
  const dateValue = numberValue(value);
  if (!dateValue) return "Time unavailable";
  return new Date(dateValue).toLocaleString(undefined, compact
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function relativeTime(value: number) {
  const minutes = Math.round((Date.now() - value) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

function formatHours(hours: number) {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10}h`;
  return `${Math.round(hours / 24)}d`;
}

function discoveryTime(feature: Feature) {
  const candidates = [
    feature.properties.FireDiscoveryDateTime,
    feature.properties.CreatedOnDateTime,
    feature.properties.ModifiedOnDateTime_dt,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

const SEEN_FIRES_KEY = "fire-growth-tracker-seen-fires";

function loadSeenFires(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SEEN_FIRES_KEY) ?? "{}") as Record<string, number>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function loadAlertPreferences(): AlertPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(ALERT_STORAGE_KEY) ?? "null") as Partial<AlertPreferences> | null;
    return stored ? { ...DEFAULT_ALERTS, ...stored } : DEFAULT_ALERTS;
  } catch {
    return DEFAULT_ALERTS;
  }
}

function loadFollowedFires(): FollowedFire[] {
  try {
    const stored = JSON.parse(localStorage.getItem(FOLLOWED_FIRES_KEY) ?? "[]") as FollowedFire[];
    return Array.isArray(stored) ? stored.filter((fire) => fire && typeof fire.id === "string") : [];
  } catch {
    return [];
  }
}

function loadMetricPreferences(): MetricId[] {
  try {
    const stored = JSON.parse(localStorage.getItem(METRICS_STORAGE_KEY) ?? "null") as MetricId[] | null;
    const allowed = new Set<MetricId>(["tracked", "new", "perimeters", "evacuations", "hotspots", "following", "acres", "updated"]);
    return Array.isArray(stored) ? stored.filter((id) => allowed.has(id)).slice(0, 5) : DEFAULT_METRICS;
  } catch {
    return DEFAULT_METRICS;
  }
}

function browserNotify(title: string, body: string) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body, icon: "/favicon.svg", tag: `${title}-${body}` });
  }
}

function safeFileName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "wildfire";
}

function updateFireParam(id: string | null) {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("fire", id);
  else url.searchParams.delete("fire");
  window.history.replaceState(null, "", url);
}

function distanceKm(a: Position, b: Position) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = radians(b[1] - a[1]);
  const dLon = radians(b[0] - a[0]);
  const lat1 = radians(a[1]);
  const lat2 = radians(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function locationLabel(properties: Record<string, unknown>) {
  const county = textValue(properties.POOCounty) ?? textValue(properties.attr_POOCounty);
  const state = (textValue(properties.POOState) ?? textValue(properties.attr_POOState))?.replace("US-", "");
  return [county, state].filter(Boolean).join(", ") || "Location unavailable";
}

function featureId(feature: Feature | null) {
  if (!feature) return null;
  return (
    textValue(feature.properties.IrwinID) ??
    textValue(feature.properties.poly_IRWINID) ??
    textValue(feature.properties.attr_IrwinID) ??
    textValue(feature.properties.CanonicalID)
  );
}

function comparableId(value: string | null) {
  return value?.replace(/[{}]/g, "").toUpperCase() ?? null;
}

function normalizedIncidentName(value: unknown) {
  return (textValue(value) ?? "")
    .toUpperCase()
    .replace(/\b(FIRE|WILDFIRE|INCIDENT)\b/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function evacuationId(feature: Feature | null) {
  if (!feature) return null;
  return textValue(feature.properties.ZONE_ID)
    ?? textValue(feature.properties.GlobalID)
    ?? String(feature.properties.OBJECTID ?? "");
}

function perimeterFor(fire: Feature | null, perimeters: FeatureCollection) {
  const id = featureId(fire);
  const comparable = comparableId(id);
  const idMatch = comparable
    ? perimeters.features.find((feature) => comparableId(featureId(feature)) === comparable)
    : null;
  if (idMatch) return idMatch;
  const fireName = normalizedIncidentName(fire?.properties.IncidentName);
  return fireName
    ? perimeters.features.find((feature) => normalizedIncidentName(feature.properties.attr_IncidentName ?? feature.properties.poly_IncidentName) === fireName) ?? null
    : null;
}

function satelliteStillUrl(fire: Feature | null) {
  if (!fire?.geometry || fire.geometry.type !== "Point") return null;
  const [longitude, latitude] = fire.geometry.coordinates as Position;
  const span = 1.7;
  const layer = longitude < -100 ? "GOES-West_ABI_FireTemp" : "GOES-East_ABI_FireTemp";
  const params = new URLSearchParams({
    SERVICE: "WMS",
    REQUEST: "GetMap",
    VERSION: "1.1.1",
    LAYERS: layer,
    STYLES: "",
    FORMAT: "image/png",
    TRANSPARENT: "false",
    HEIGHT: "520",
    WIDTH: "820",
    SRS: "EPSG:4326",
    BBOX: `${longitude - span},${latitude - span},${longitude + span},${latitude + span}`,
  });
  return `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?${params}`;
}

function walkPositions(value: unknown, callback: (position: Position) => void) {
  if (!Array.isArray(value)) return;
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
    callback([value[0], value[1]]);
    return;
  }
  for (const child of value) walkPositions(child, callback);
}

function pointInRing([x, y]: Position, ring: Position[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point: Position, polygon: Position[][]) {
  if (!polygon.length || !pointInRing(point, polygon[0])) return false;
  return !polygon.slice(1).some((hole) => pointInRing(point, hole));
}

function pointInGeometry(point: Position, geometry: Geometry) {
  if (geometry.type === "Polygon") return pointInPolygon(point, geometry.coordinates as Position[][]);
  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates as Position[][][]).some((polygon) => pointInPolygon(point, polygon));
  }
  return false;
}

function geometryBounds(geometry: Geometry) {
  let west = 180, east = -180, south = 90, north = -90;
  walkPositions(geometry.coordinates, ([longitude, latitude]) => {
    west = Math.min(west, longitude); east = Math.max(east, longitude);
    south = Math.min(south, latitude); north = Math.max(north, latitude);
  });
  return [[west, south], [east, north]] as [Position, Position];
}

function collectionsBounds(collections: FeatureCollection[]) {
  let west = 180, east = -180, south = 90, north = -90;
  let found = false;
  for (const collection of collections) {
    for (const feature of collection.features) {
      if (!feature.geometry) continue;
      walkPositions(feature.geometry.coordinates, ([longitude, latitude]) => {
        found = true;
        west = Math.min(west, longitude); east = Math.max(east, longitude);
        south = Math.min(south, latitude); north = Math.max(north, latitude);
      });
    }
  }
  return found ? [[west, south], [east, north]] as [Position, Position] : null;
}

function geometryIntersectsCoverage(geometry: Geometry, coverage: Geometry) {
  if (geometry.type === "Point") return pointInGeometry(geometry.coordinates as Position, coverage);
  let intersects = false;
  walkPositions(geometry.coordinates, (position) => {
    if (!intersects && pointInGeometry(position, coverage)) intersects = true;
  });
  if (intersects) return true;
  walkPositions(coverage.coordinates, (position) => {
    if (!intersects && pointInGeometry(position, geometry)) intersects = true;
  });
  return intersects;
}

function evacuationHashForFire(fire: Feature, perimeter: Feature | null, data: DashboardData) {
  const origin = fire.geometry?.type === "Point" ? fire.geometry.coordinates as Position : null;
  return data.evacuations.features
    .filter((zone) => zone.geometry && (
      (origin ? pointInGeometry(origin, zone.geometry) : false)
      || (perimeter?.geometry ? geometryIntersectsCoverage(perimeter.geometry, zone.geometry) : false)
    ))
    .map((zone) => `${evacuationId(zone)}:${textValue(zone.properties.evacuationClass) ?? "other"}:${numberValue(zone.properties.EDIT_DATE ?? zone.properties.EditDate) ?? 0}`)
    .sort()
    .join("|");
}

function evacuationLabel(feature: Feature) {
  return textValue(feature.properties.ZONE_NAME)
    ?? textValue(feature.properties.ZONE_ID)
    ?? "Evacuation zone";
}

function worldPixel([longitude, latitude]: Position, zoom: number): Position {
  const scale = 256 * 2 ** zoom;
  const clamped = Math.max(-85.0511, Math.min(85.0511, latitude));
  const sin = Math.sin(clamped * Math.PI / 180);
  return [
    (longitude + 180) / 360 * scale,
    (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale,
  ];
}

async function drawBaseMap(
  context: CanvasRenderingContext2D,
  zoom: number,
  worldWest: number,
  worldNorth: number,
  plot: { left: number; top: number; right: number; bottom: number },
) {
  const firstX = Math.floor(worldWest / 256);
  const firstY = Math.floor(worldNorth / 256);
  const lastX = Math.floor((worldWest + plot.right - plot.left) / 256);
  const lastY = Math.floor((worldNorth + plot.bottom - plot.top) / 256);
  const tiles: Promise<void>[] = [];
  for (let x = firstX; x <= lastX; x += 1) {
    for (let y = firstY; y <= lastY; y += 1) {
      tiles.push((async () => {
        try {
          const response = await fetch(`/api/map-tile?z=${zoom}&x=${x}&y=${y}`);
          if (!response.ok) return;
          const image = await createImageBitmap(await response.blob());
          context.drawImage(image, plot.left + x * 256 - worldWest, plot.top + y * 256 - worldNorth, 256, 256);
          image.close();
        } catch { /* A missing tile never blocks the perimeter graphic. */ }
      })());
    }
  }
  await Promise.all(tiles);
}

async function frameCanvas(snapshots: Snapshot[], activeIndex: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas is unavailable");

  let west = 180;
  let east = -180;
  let south = 90;
  let north = -90;
  for (const snapshot of snapshots) {
    walkPositions(snapshot.geometry.coordinates, ([longitude, latitude]) => {
      west = Math.min(west, longitude);
      east = Math.max(east, longitude);
      south = Math.min(south, latitude);
      north = Math.max(north, latitude);
    });
  }
  const longitudeSpan = Math.max(east - west, 0.02);
  const latitudeSpan = Math.max(north - south, 0.02);
  west -= longitudeSpan * 0.12;
  east += longitudeSpan * 0.12;
  south -= latitudeSpan * 0.16;
  north += latitudeSpan * 0.16;
  const plot = { left: 84, top: 92, right: 1196, bottom: 566 };
  let zoom = 14;
  for (; zoom > 2; zoom -= 1) {
    const northwest = worldPixel([west, north], zoom);
    const southeast = worldPixel([east, south], zoom);
    if (southeast[0] - northwest[0] <= plot.right - plot.left && southeast[1] - northwest[1] <= plot.bottom - plot.top) break;
  }
  const northwest = worldPixel([west, north], zoom);
  const southeast = worldPixel([east, south], zoom);
  const worldWest = (northwest[0] + southeast[0] - (plot.right - plot.left)) / 2;
  const worldNorth = (northwest[1] + southeast[1] - (plot.bottom - plot.top)) / 2;
  const project = (position: Position) => {
    const [x, y] = worldPixel(position, zoom);
    return [plot.left + x - worldWest, plot.top + y - worldNorth] as Position;
  };

  context.fillStyle = "#0d1113";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await drawBaseMap(context, zoom, worldWest, worldNorth, plot);
  context.fillStyle = "rgba(6,10,12,.22)";
  context.fillRect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top);

  const draw = (geometry: Geometry, fill: string, stroke: string, width: number) => {
    if (geometry.type === "Point") return;
    const polygons = geometry.type === "Polygon"
      ? [geometry.coordinates as Position[][]]
      : (geometry.coordinates as Position[][][]);
    context.fillStyle = fill;
    context.strokeStyle = stroke;
    context.lineWidth = width;
    for (const polygon of polygons) {
      for (const ring of polygon) {
        context.beginPath();
        ring.forEach((position, index) => {
          const [x, y] = project(position);
          if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
        });
        context.closePath();
        context.fill();
        context.stroke();
      }
    }
  };

  for (let index = 0; index < activeIndex; index += 1) {
    draw(snapshots[index].geometry, "rgba(247,136,47,.04)", "rgba(247,136,47,.35)", 2);
  }
  const active = snapshots[activeIndex];
  draw(active.geometry, "rgba(239,67,43,.55)", "#ffb15c", 3.5);

  // Header bug
  context.fillStyle = "#ffb15c";
  context.font = "800 17px Arial";
  context.fillText("FIRE GROWTH TRACKER", 84, 46);
  context.fillStyle = "#8d9691";
  context.font = "700 13px Arial";
  context.fillText("PERIMETER GROWTH \u2022 CAL FIRE / FIRIS / NIFC", 84, 68);
  context.textAlign = "right";
  context.fillText(`FRAME ${activeIndex + 1} OF ${snapshots.length}`, 1196, 46);
  context.textAlign = "left";

  // Broadcast lower third
  const barTop = 596;
  context.fillStyle = "#ef432b";
  context.fillRect(0, barTop, canvas.width, 5);
  const gradient = context.createLinearGradient(0, barTop, 0, canvas.height);
  gradient.addColorStop(0, "#151b1e");
  gradient.addColorStop(1, "#0b0e10");
  context.fillStyle = gradient;
  context.fillRect(0, barTop + 5, canvas.width, canvas.height - barTop - 5);

  const state = active.state?.replace("US-", "");
  const contained = active.contained !== null ? `${Math.round(active.contained)}% contained` : null;
  const place = [
    active.county ? `${active.county} County${state ? `, ${state}` : ""}` : state ?? "California",
    contained,
  ].filter(Boolean).join(" \u2022 ");
  context.fillStyle = "#f7f4ea";
  context.font = "800 44px Arial";
  context.fillText(active.incidentName.toUpperCase(), 84, barTop + 62);
  context.fillStyle = "#96a09a";
  context.font = "700 16px Arial";
  context.fillText(place, 84, barTop + 94);
  context.textAlign = "right";
  context.fillStyle = "#ffb15c";
  context.font = "800 40px Arial";
  context.fillText(formatAcres(active.acres).toUpperCase(), 1196, barTop + 62);
  context.fillStyle = "#96a09a";
  context.font = "700 16px Arial";
  context.fillText(formatDate(active.perimeterDate ?? active.capturedAt), 1196, barTop + 94);
  context.textAlign = "left";
  context.fillStyle = "#5d6763";
  context.font = "12px Arial";
  context.fillText("Operational data \u2014 perimeters may be revised as mapping improves.", 84, canvas.height - 12);
  return canvas;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipNumber(target: number[], value: number, width: 2 | 4) {
  for (let index = 0; index < width; index += 1) target.push((value >>> (index * 8)) & 0xff);
}

async function createStoredZip(files: Array<{ name: string; blob: Blob }>) {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = new Uint8Array(await file.blob.arrayBuffer());
    const checksum = crc32(data);
    const local: number[] = [];
    zipNumber(local, 0x04034b50, 4); zipNumber(local, 20, 2); zipNumber(local, 0, 2); zipNumber(local, 0, 2);
    zipNumber(local, 0, 2); zipNumber(local, 0, 2); zipNumber(local, 0, 2); zipNumber(local, checksum, 4);
    zipNumber(local, data.length, 4); zipNumber(local, data.length, 4); zipNumber(local, name.length, 2); zipNumber(local, 0, 2);
    const localHeader = new Uint8Array([...local, ...name]);
    localParts.push(localHeader, data);

    const central: number[] = [];
    zipNumber(central, 0x02014b50, 4); zipNumber(central, 20, 2); zipNumber(central, 20, 2); zipNumber(central, 0, 2);
    zipNumber(central, 0, 2); zipNumber(central, 0, 2); zipNumber(central, 0, 2); zipNumber(central, checksum, 4);
    zipNumber(central, data.length, 4); zipNumber(central, data.length, 4); zipNumber(central, name.length, 2);
    zipNumber(central, 0, 2); zipNumber(central, 0, 2); zipNumber(central, 0, 2); zipNumber(central, 0, 2);
    zipNumber(central, 0, 4); zipNumber(central, localOffset, 4);
    centralParts.push(new Uint8Array([...central, ...name]));
    localOffset += localHeader.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end: number[] = [];
  zipNumber(end, 0x06054b50, 4); zipNumber(end, 0, 2); zipNumber(end, 0, 2);
  zipNumber(end, files.length, 2); zipNumber(end, files.length, 2); zipNumber(end, centralSize, 4);
  zipNumber(end, localOffset, 4); zipNumber(end, 0, 2);
  const parts = [...localParts, ...centralParts, new Uint8Array(end)];
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
  return new Blob([output.buffer], { type: "application/zip" });
}

function canvasBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Image export failed")), "image/png"));
}

async function growthGifBlob(frames: Snapshot[]) {
  const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
  const gif = GIFEncoder();
  let palette: number[][] | undefined;
  for (let index = 0; index < frames.length; index += 1) {
    const canvas = await frameCanvas(frames, index);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) continue;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    palette ??= quantize(pixels, 128);
    gif.writeFrame(applyPalette(pixels, palette), canvas.width, canvas.height, {
      palette: index === 0 ? palette : undefined,
      delay: index === frames.length - 1 ? 1900 : 850,
      repeat: 0,
    });
  }
  gif.finish();
  const encoded = new Uint8Array(gif.bytes());
  return new Blob([encoded.buffer], { type: "image/gif" });
}

function AcresSparkline({ snapshots }: { snapshots: Snapshot[] }) {
  const points = snapshots
    .map((snapshot) => ({ time: snapshot.perimeterDate ?? snapshot.capturedAt, acres: snapshot.acres }))
    .filter((entry): entry is { time: number; acres: number } => entry.acres !== null && Number.isFinite(entry.time))
    .sort((a, b) => a.time - b.time);
  if (points.length < 2) return null;
  const width = 240;
  const height = 56;
  const pad = 4;
  const minTime = points[0].time;
  const timeSpan = Math.max(points[points.length - 1].time - minTime, 1);
  const acresValues = points.map((entry) => entry.acres);
  const minAcres = Math.min(...acresValues);
  const acresSpan = Math.max(Math.max(...acresValues) - minAcres, 1);
  const coords = points.map((entry) => [
    pad + ((entry.time - minTime) / timeSpan) * (width - pad * 2),
    height - pad - ((entry.acres - minAcres) / acresSpan) * (height - pad * 2),
  ] as const);
  const line = coords.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const last = coords[coords.length - 1];
  const area = `${line} L${last[0].toFixed(1)},${height - pad} L${coords[0][0].toFixed(1)},${height - pad} Z`;
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Reported acres over time">
      <path d={area} fill="rgba(255,138,61,.16)" />
      <path d={line} fill="none" stroke="#ff8a3d" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      <circle cx={last[0]} cy={last[1]} r="3" fill="#ffd166" />
    </svg>
  );
}

function GrowthMapPreview({ snapshots, activeIndex }: { snapshots: Snapshot[]; activeIndex: number }) {
  const previewRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    if (!snapshots.length) return;
    void frameCanvas(snapshots, Math.min(activeIndex, snapshots.length - 1)).then((rendered) => {
      const preview = previewRef.current;
      if (!preview || cancelled) return;
      preview.width = rendered.width;
      preview.height = rendered.height;
      preview.getContext("2d")?.drawImage(rendered, 0, 0);
    });
    return () => { cancelled = true; };
  }, [snapshots, activeIndex]);
  return <canvas ref={previewRef} className="growth-map-preview" aria-label="Fire perimeter map preview" />;
}

function OverviewFallbackMap({ data, coverage, perimetersOn, evacuationsOn }: {
  data: DashboardData | null;
  coverage: DmaFeature | null;
  perimetersOn: boolean;
  evacuationsOn: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let cancelled = false;
    if (!data) return;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    canvas.width = 1280;
    canvas.height = 720;
    const plot = { left: 0, top: 0, right: canvas.width, bottom: canvas.height };
    const bounds = coverage?.geometry
      ? geometryBounds(coverage.geometry)
      : collectionsBounds([data.fires, data.perimeters, data.evacuations]);
    if (!bounds) return;
    let [[west, south], [east, north]] = bounds;
    const longitudePad = Math.max((east - west) * 0.08, 0.08);
    const latitudePad = Math.max((north - south) * 0.08, 0.08);
    west -= longitudePad; east += longitudePad; south -= latitudePad; north += latitudePad;
    let zoom = 12;
    for (; zoom > 2; zoom -= 1) {
      const northwest = worldPixel([west, north], zoom);
      const southeast = worldPixel([east, south], zoom);
      if (southeast[0] - northwest[0] <= canvas.width && southeast[1] - northwest[1] <= canvas.height) break;
    }
    const northwest = worldPixel([west, north], zoom);
    const southeast = worldPixel([east, south], zoom);
    const worldWest = (northwest[0] + southeast[0] - canvas.width) / 2;
    const worldNorth = (northwest[1] + southeast[1] - canvas.height) / 2;
    const project = (position: Position) => {
      const [x, y] = worldPixel(position, zoom);
      return [x - worldWest, y - worldNorth] as Position;
    };
    const drawGeometry = (geometry: Geometry, fill: string, stroke: string, width: number) => {
      if (geometry.type === "Point") return;
      const shapes = geometry.type === "Polygon" ? [geometry.coordinates as Position[][]] : geometry.coordinates as Position[][][];
      for (const polygon of shapes) {
        for (const ring of polygon) {
          context.beginPath();
          ring.forEach((position, index) => {
            const [x, y] = project(position);
            if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
          });
          context.closePath(); context.fillStyle = fill; context.fill();
          context.strokeStyle = stroke; context.lineWidth = width; context.stroke();
        }
      }
    };
    context.fillStyle = "#dfe5e5";
    context.fillRect(0, 0, canvas.width, canvas.height);
    void drawBaseMap(context, zoom, worldWest, worldNorth, plot).then(() => {
      if (cancelled) return;
      context.fillStyle = "rgba(10,15,17,.16)";
      context.fillRect(0, 0, canvas.width, canvas.height);
      if (evacuationsOn) {
        for (const zone of data.evacuations.features) {
          if (!zone.geometry) continue;
          const classification = textValue(zone.properties.evacuationClass) ?? "other";
          const colors: Record<string, [string, string]> = {
            order: ["rgba(226,63,50,.26)", "#e23f32"],
            warning: ["rgba(244,197,66,.25)", "#f4c542"],
            shelter: ["rgba(165,109,226,.25)", "#a56de2"],
          };
          const [fill, stroke] = colors[classification] ?? ["rgba(138,164,177,.22)", "#8aa4b1"];
          drawGeometry(zone.geometry, fill, stroke, 2);
        }
      }
      if (perimetersOn) {
        for (const perimeter of data.perimeters.features) if (perimeter.geometry) drawGeometry(perimeter.geometry, "rgba(239,67,43,.34)", "#ff8a3d", 3);
      }
      for (const fire of data.fires.features) {
        if (fire.geometry?.type !== "Point") continue;
        const [x, y] = project(fire.geometry.coordinates as Position);
        context.beginPath(); context.arc(x, y, fire.properties.isNew === true ? 7 : 5, 0, Math.PI * 2);
        context.fillStyle = fire.properties.isNew === true ? "#ffd166" : "#ef432b"; context.fill();
        context.strokeStyle = "#fff4dc"; context.lineWidth = 1.5; context.stroke();
      }
    });
    return () => { cancelled = true; };
  }, [data, coverage, perimetersOn, evacuationsOn]);
  return <canvas ref={canvasRef} className="fallback-map" aria-hidden="true" />;
}

export default function FireDashboard() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<Map | null>(null);
  const fireMarkersRef = useRef<Marker[]>([]);
  const visibleFiresRef = useRef<Feature[]>([]);
  const visibleEvacuationsRef = useRef<Feature[]>([]);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Feature | null>(null);
  const [selectedEvacuation, setSelectedEvacuation] = useState<Feature | null>(null);
  const [hotspotsOn, setHotspotsOn] = useState(true);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [dmaPreference, setDmaPreference] = useState<DmaPreference | null>(null);
  const [dmaFeature, setDmaFeature] = useState<DmaFeature | null>(null);
  const [heatmapOn, setHeatmapOn] = useState(false);
  const [perimetersOn, setPerimetersOn] = useState(true);
  const [evacuationsOn, setEvacuationsOn] = useState(true);
  const [conditions, setConditions] = useState<FireConditions | null>(null);
  const [alertPreferences, setAlertPreferences] = useState<AlertPreferences>(DEFAULT_ALERTS);
  const [followedFires, setFollowedFires] = useState<FollowedFire[]>([]);
  const [newsroomExporting, setNewsroomExporting] = useState(false);
  const [breaking, setBreaking] = useState<Feature[]>([]);
  const [copied, setCopied] = useState<"link" | "summary" | null>(null);
  const [metricPreferences, setMetricPreferences] = useState<MetricId[]>(DEFAULT_METRICS);
  const [nearbyCameras, setNearbyCameras] = useState<NearbyCamera[]>([]);
  const [camerasLoading, setCamerasLoading] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const deepLinkAppliedRef = useRef(false);
  const seenFiresRef = useRef<Record<string, number> | null>(null);
  const feedStatusRef = useRef<Record<string, boolean> | null>(null);
  const dmaKeyRef = useRef<string | null>(null);
  const followedLoadedRef = useRef(false);

  useEffect(() => {
    setAlertPreferences(loadAlertPreferences());
    setFollowedFires(loadFollowedFires());
    setMetricPreferences(loadMetricPreferences());
    followedLoadedRef.current = true;
  }, []);

  const displayData = useMemo(() => {
    if (!data || !dmaFeature) return data;
    const fires = data.fires.features.filter((fire) =>
      fire.geometry?.type === "Point" && pointInGeometry(fire.geometry.coordinates as Position, dmaFeature.geometry),
    );
    const perimeters = data.perimeters.features.filter((perimeter) =>
      perimeter.geometry ? geometryIntersectsCoverage(perimeter.geometry, dmaFeature.geometry) : false,
    );
    const evacuations = data.evacuations.features.filter((evacuation) =>
      evacuation.geometry ? geometryIntersectsCoverage(evacuation.geometry, dmaFeature.geometry) : false,
    );
    const hotspots = data.hotspots.features.filter((hotspot) =>
      hotspot.geometry?.type === "Point" && pointInGeometry(hotspot.geometry.coordinates as Position, dmaFeature.geometry),
    );
    return {
      ...data,
      fires: { type: "FeatureCollection", features: fires } as FeatureCollection,
      perimeters: { type: "FeatureCollection", features: perimeters } as FeatureCollection,
      evacuations: { type: "FeatureCollection", features: evacuations } as FeatureCollection,
      hotspots: { type: "FeatureCollection", features: hotspots } as FeatureCollection,
    };
  }, [data, dmaFeature]);

  useEffect(() => {
    visibleFiresRef.current = displayData?.fires.features ?? [];
    visibleEvacuationsRef.current = displayData?.evacuations.features ?? [];
  }, [displayData]);

  const loadData = async () => {
    try {
      setError(null);
      const response = await fetch("/api/fires", { cache: "no-store" });
      const payload = (await response.json()) as DashboardData;
      if (!response.ok || payload.error) throw new Error(payload.error ?? "Fire data is unavailable");
      setData(payload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Fire data is unavailable");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
    const interval = window.setInterval(() => void loadData(), 300_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let saved: DmaPreference | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(DMA_STORAGE_KEY) ?? "null") as DmaPreference | null;
    } catch {
      localStorage.removeItem(DMA_STORAGE_KEY);
    }
    if (!saved?.id) return;
    setDmaPreference(saved);
    fetch(`/api/dmas?id=${encodeURIComponent(saved.id)}`)
      .then(async (response) => {
        const payload = await response.json() as { feature?: DmaFeature; error?: string };
        if (!response.ok || !payload.feature) throw new Error(payload.error ?? "DMA boundary unavailable");
        setDmaFeature(payload.feature);
      })
      .catch(() => {
        setDmaPreference(null);
        setDmaFeature(null);
      });
  }, []);

  useEffect(() => {
    if (!mapContainer.current || mapRef.current) return;
    const map = new Map({
      container: mapContainer.current,
      style: {
        version: 8 as const,
        sources: {
          "esri-streets": {
            type: "raster",
            tiles: ["/api/map-tile?z={z}&x={x}&y={y}"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors © CARTO",
          },
        },
        layers: [{ id: "esri-streets", type: "raster", source: "esri-streets" }],
      },
      center: [-119.45, 37.25],
      zoom: 5.15,
      minZoom: 4,
    });
    map.on("error", (event) => {
      const message = event.error?.message ?? "Map rendering failed";
      if (!message.toLowerCase().includes("tile")) setMapError(message);
    });
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    let pulseFrame = 0;
    map.on("load", () => {
      map.addSource("evacuations", { type: "geojson", data: EMPTY as never });
      map.addLayer({
        id: "evacuations-fill",
        type: "fill",
        source: "evacuations",
        paint: {
          "fill-color": ["match", ["get", "evacuationClass"], "order", "#e23f32", "warning", "#f4c542", "shelter", "#a56de2", "advisory", "#ee8b3a", "#8aa4b1"],
          "fill-opacity": 0.28,
        },
      });
      map.addLayer({
        id: "evacuations-line",
        type: "line",
        source: "evacuations",
        paint: {
          "line-color": ["match", ["get", "evacuationClass"], "order", "#ff5a4c", "warning", "#ffe07a", "shelter", "#c99bff", "advisory", "#ffab64", "#b8cbd3"],
          "line-width": 1.7,
          "line-opacity": 0.92,
        },
      });
      map.addSource("fire-perimeters", { type: "geojson", data: EMPTY as never });
      map.addLayer({
        id: "fire-perimeters-fill",
        type: "fill",
        source: "fire-perimeters",
        paint: { "fill-color": "#ef432b", "fill-opacity": 0.32 },
      });
      map.addLayer({
        id: "fire-perimeters-line",
        type: "line",
        source: "fire-perimeters",
        paint: { "line-color": "#ff8a3d", "line-width": 1.8 },
      });
      map.addSource("hotspots", { type: "geojson", data: EMPTY as never });
      map.addLayer({
        id: "viirs-hotspots",
        type: "circle",
        source: "hotspots",
        paint: {
          "circle-color": ["interpolate", ["linear"], ["coalesce", ["get", "hours_old"], 24], 0, "#fff3a0", 6, "#ffbf47", 12, "#ff702f", 24, "#d9271c"],
          "circle-radius": ["interpolate", ["linear"], ["coalesce", ["get", "frp"], 0], 0, 3, 20, 4.5, 100, 7, 500, 10],
          "circle-stroke-color": "#40130c",
          "circle-stroke-width": 1,
          "circle-opacity": 0.88,
        },
      });
      map.addLayer({
        id: "viirs-heatmap",
        type: "heatmap",
        source: "hotspots",
        layout: { visibility: "none" },
        paint: {
          "heatmap-weight": ["interpolate", ["linear"], ["coalesce", ["get", "frp"], 1], 0, 0.12, 25, 0.4, 150, 0.8, 500, 1],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 4, 0.9, 7, 1.6, 10, 2.4],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 4, 14, 7, 26, 10, 44],
          "heatmap-color": [
            "interpolate", ["linear"], ["heatmap-density"],
            0, "rgba(0,0,0,0)",
            0.15, "rgba(120,40,140,.45)",
            0.35, "#d9271c",
            0.6, "#ff702f",
            0.8, "#ffbf47",
            1, "#fff3a0",
          ],
          "heatmap-opacity": 0.78,
        },
      }, "viirs-hotspots");
      map.addSource("coverage-area", { type: "geojson", data: EMPTY as never });
      map.addLayer({
        id: "coverage-area-fill",
        type: "fill",
        source: "coverage-area",
        paint: { "fill-color": "#ffd166", "fill-opacity": 0.035 },
      });
      map.addLayer({
        id: "coverage-area-line",
        type: "line",
        source: "coverage-area",
        paint: { "line-color": "#ffd166", "line-width": 2, "line-opacity": 0.85 },
      });
      map.addSource("fires", { type: "geojson", data: EMPTY as never });
      map.addLayer({
        id: "fire-points",
        type: "circle",
        source: "fires",
        paint: {
          "circle-color": ["case", ["==", ["get", "isNew"], true], "#ffd166", "#ef432b"],
          "circle-radius": ["interpolate", ["linear"], ["coalesce", ["get", "IncidentSize"], 0], 0, 4, 1000, 7, 100000, 13],
          "circle-stroke-color": "#fff4dc",
          "circle-stroke-width": 1,
          "circle-opacity": 0.92,
        },
      });
      map.addLayer({
        id: "fire-points-pulse",
        type: "circle",
        source: "fires",
        filter: ["==", ["get", "isNew"], true],
        paint: {
          "circle-color": "#ffd166",
          "circle-radius": 8,
          "circle-opacity": 0.35,
          "circle-stroke-width": 0,
        },
      }, "fire-points");
      const choose = (event: { features?: Array<{ properties: Record<string, unknown> }> }) => {
        const properties = event.features?.[0]?.properties ?? {};
        const id = textValue(properties.IrwinID)
          ?? textValue(properties.poly_IRWINID)
          ?? textValue(properties.CanonicalID);
        const name = normalizedIncidentName(properties.attr_IncidentName ?? properties.poly_IncidentName);
        const match = visibleFiresRef.current.find((feature) => comparableId(featureId(feature)) === comparableId(id))
          ?? visibleFiresRef.current.find((feature) => name && normalizedIncidentName(feature.properties.IncidentName) === name);
        if (match) {
          const idMatch = comparableId(featureId(match));
          setSelected(match);
          setSelectedEvacuation(null);
          updateFireParam(idMatch);
        }
      };
      map.on("click", "fire-points", choose);
      map.on("click", "fire-perimeters-fill", choose);
      map.on("click", "evacuations-fill", (event) => {
        const properties = event.features?.[0]?.properties ?? {};
        const id = textValue(properties.ZONE_ID) ?? textValue(properties.GlobalID) ?? String(properties.OBJECTID ?? "");
        const match = visibleEvacuationsRef.current.find((feature) => evacuationId(feature) === id);
        if (match) { setSelectedEvacuation(match); setSelected(null); }
      });
      map.on("click", (event) => {
        const hits = map.queryRenderedFeatures(event.point, {
          layers: ["fire-points", "fire-perimeters-fill", "evacuations-fill"],
        });
        if (!hits.length) {
          setSelected(null);
          setSelectedEvacuation(null);
          updateFireParam(null);
        }
      });
      map.on("mouseenter", "fire-points", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "fire-points", () => { map.getCanvas().style.cursor = ""; });
      map.on("mouseenter", "evacuations-fill", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "evacuations-fill", () => { map.getCanvas().style.cursor = ""; });
      const animatePulse = (time: number) => {
        const phase = (time % 1800) / 1800;
        if (map.getLayer("fire-points-pulse")) {
          map.setPaintProperty("fire-points-pulse", "circle-radius", 7 + phase * 15);
          map.setPaintProperty("fire-points-pulse", "circle-opacity", 0.42 * (1 - phase));
        }
        pulseFrame = requestAnimationFrame(animatePulse);
      };
      pulseFrame = requestAnimationFrame(animatePulse);
      setMapReady(true);
    });
    mapRef.current = map;
    return () => {
      cancelAnimationFrame(pulseFrame);
      fireMarkersRef.current.forEach((marker) => marker.remove());
      fireMarkersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !displayData) return;
    const sync = () => {
      (map.getSource("fires") as GeoJSONSource | undefined)?.setData(displayData.fires as never);
      (map.getSource("fire-perimeters") as GeoJSONSource | undefined)?.setData(displayData.perimeters as never);
      (map.getSource("evacuations") as GeoJSONSource | undefined)?.setData(displayData.evacuations as never);
      (map.getSource("hotspots") as GeoJSONSource | undefined)?.setData(displayData.hotspots as never);

      fireMarkersRef.current.forEach((marker) => marker.remove());
      fireMarkersRef.current = displayData.fires.features.flatMap((fire) => {
        if (fire.geometry?.type !== "Point") return [];
        const [longitude, latitude] = fire.geometry.coordinates as Position;
        if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return [];
        const element = document.createElement("button");
        element.type = "button";
        element.className = `fire-map-marker${fire.properties.isNew === true ? " new" : ""}`;
        element.title = textValue(fire.properties.IncidentName) ?? "Active fire";
        element.setAttribute("aria-label", `Select ${element.title}`);
        element.addEventListener("click", (event) => {
          event.stopPropagation();
          setSelected(fire);
          setSelectedEvacuation(null);
          updateFireParam(comparableId(featureId(fire)));
        });
        return [new Marker({ element, anchor: "center" }).setLngLat([longitude, latitude]).addTo(map)];
      });
    };
    if (map.getSource("fires")) sync(); else map.once("load", sync);
  }, [displayData]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || selected?.geometry?.type !== "Point") return;
    const [longitude, latitude] = selected.geometry.coordinates as Position;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return;
    map.easeTo({ center: [longitude, latitude], zoom: Math.max(map.getZoom(), 9), duration: 700 });
  }, [selected]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !displayData || selected || selectedEvacuation) return;
    const bounds = dmaFeature?.geometry
      ? geometryBounds(dmaFeature.geometry)
      : collectionsBounds([displayData.fires, displayData.perimeters, displayData.evacuations]);
    if (!bounds) return;
    const timer = window.setTimeout(() => map.fitBounds(bounds, { padding: 36, duration: 700, maxZoom: 9 }), 80);
    return () => window.clearTimeout(timer);
  }, [displayData, dmaFeature, selected, selectedEvacuation]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !dmaFeature) return;
    const sync = () => {
      (map.getSource("coverage-area") as GeoJSONSource | undefined)?.setData(dmaFeature as never);
      map.fitBounds(geometryBounds(dmaFeature.geometry), { padding: 32, duration: 900, maxZoom: 8 });
    };
    if (map.getSource("coverage-area")) sync(); else map.once("load", sync);
  }, [dmaFeature]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer("viirs-hotspots")) return;
    map.setLayoutProperty("viirs-hotspots", "visibility", hotspotsOn ? "visible" : "none");
  }, [hotspotsOn]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer("viirs-heatmap")) return;
    map.setLayoutProperty("viirs-heatmap", "visibility", heatmapOn ? "visible" : "none");
  }, [heatmapOn]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer("fire-perimeters-fill")) return;
    for (const layer of ["fire-perimeters-fill", "fire-perimeters-line"]) {
      map.setLayoutProperty(layer, "visibility", perimetersOn ? "visible" : "none");
    }
  }, [perimetersOn, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer("evacuations-fill")) return;
    for (const layer of ["evacuations-fill", "evacuations-line"]) {
      map.setLayoutProperty(layer, "visibility", evacuationsOn ? "visible" : "none");
    }
  }, [evacuationsOn, mapReady]);

  useEffect(() => {
    const id = featureId(selected);
    if (!id) { setHistory([]); return; }
    setHistory([]);
    setHistoryIndex(0);
    fetch(`/api/history?irwin=${encodeURIComponent(id)}`)
      .then((response) => response.json())
      .then((payload: { snapshots?: Snapshot[] }) => {
        const snapshots = payload.snapshots ?? [];
        setHistory(snapshots);
        setHistoryIndex(Math.max(0, snapshots.length - 1));
      })
      .catch(() => setHistory([]));
  }, [selected]);

  useEffect(() => {
    if (selected?.geometry?.type !== "Point") {
      setConditions(null);
      return;
    }
    const [longitude, latitude] = selected.geometry.coordinates as Position;
    const controller = new AbortController();
    fetch(`/api/conditions?lat=${latitude}&lon=${longitude}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as FireConditions;
        if (!response.ok || payload.error) throw new Error(payload.error ?? "Conditions unavailable");
        setConditions(payload);
      })
      .catch((loadError) => {
        if ((loadError as Error).name !== "AbortError") setConditions(null);
      });
    return () => controller.abort();
  }, [selected]);

  useEffect(() => {
    if (selected?.geometry?.type !== "Point") {
      setNearbyCameras([]);
      return;
    }
    const [longitude, latitude] = selected.geometry.coordinates as Position;
    const controller = new AbortController();
    setCamerasLoading(true);
    fetch(`/api/cameras?lat=${latitude}&lon=${longitude}&limit=5`, { signal: controller.signal })
      .then((response) => response.json())
      .then((payload: { cameras?: NearbyCamera[] }) => setNearbyCameras(payload.cameras ?? []))
      .catch((loadError) => {
        if ((loadError as Error).name !== "AbortError") setNearbyCameras([]);
      })
      .finally(() => setCamerasLoading(false));
    return () => controller.abort();
  }, [selected]);

  const sortedFires = useMemo(() => {
    if (!displayData) return [];
    return [...displayData.fires.features].sort((a, b) => {
      const newDifference = Number(Boolean(b.properties.isNew)) - Number(Boolean(a.properties.isNew));
      return newDifference || (numberValue(b.properties.IncidentSize) ?? 0) - (numberValue(a.properties.IncidentSize) ?? 0);
    });
  }, [displayData]);
  const newFires = useMemo(
    () => sortedFires
      .filter((feature) => feature.properties.isNew === true)
      .sort((a, b) => (discoveryTime(b) ?? 0) - (discoveryTime(a) ?? 0)),
    [sortedFires],
  );
  const activeFollowedFires = useMemo(() => {
    const followedIds = new Set(followedFires.map((fire) => comparableId(fire.id)));
    return sortedFires.filter((fire) => followedIds.has(comparableId(featureId(fire))));
  }, [sortedFires, followedFires]);
  const evacuations = useMemo(() => {
    if (!displayData) return [];
    const priority: Record<string, number> = { order: 4, shelter: 3, warning: 2, advisory: 1, other: 0 };
    return [...displayData.evacuations.features].sort((a, b) => {
      const aClass = textValue(a.properties.evacuationClass) ?? "other";
      const bClass = textValue(b.properties.evacuationClass) ?? "other";
      return (priority[bClass] ?? 0) - (priority[aClass] ?? 0)
        || (numberValue(b.properties.EDIT_DATE) ?? 0) - (numberValue(a.properties.EDIT_DATE) ?? 0);
    });
  }, [displayData]);
  const evacuationOrders = evacuations.filter((feature) => feature.properties.evacuationClass === "order").length;
  const evacuationWarnings = evacuations.filter((feature) => feature.properties.evacuationClass === "warning").length;
  const totalTrackedAcres = sortedFires.reduce((sum, fire) => sum + (numberValue(fire.properties.IncidentSize) ?? 0), 0);
  const perimeterUpdates24h = displayData?.perimeters.features.filter((perimeter) => {
    const updated = numberValue(perimeter.properties.poly_PolygonDateTime ?? perimeter.properties.poly_DateCurrent);
    return updated !== null && displayData.fetchedAt - updated <= 86_400_000;
  }).length ?? 0;
  const metricCards: Record<MetricId, { label: string; value: string; accent?: boolean }> = {
    tracked: { label: "TRACKED FIRES", value: displayData?.fires.features.length.toLocaleString() ?? "—" },
    new: { label: "NEW • 24 HOURS", value: newFires.length.toLocaleString(), accent: true },
    perimeters: { label: "LIVE PERIMETERS", value: displayData?.perimeters.features.length.toLocaleString() ?? "—" },
    evacuations: { label: "EVAC ORDERS / WARNINGS", value: `${evacuationOrders} / ${evacuationWarnings}` },
    hotspots: { label: "VIIRS HOTSPOTS • 24H", value: displayData?.hotspots.features.length.toLocaleString() ?? "—" },
    following: { label: "FOLLOWED FIRES", value: activeFollowedFires.length.toLocaleString() },
    acres: { label: "ACTIVE REPORTED ACRES", value: Math.round(totalTrackedAcres).toLocaleString() },
    updated: { label: "PERIMETERS UPDATED • 24H", value: perimeterUpdates24h.toLocaleString() },
  };
  const unavailableFeeds = data?.feedStatus
    ? Object.entries(data.feedStatus).filter(([, available]) => !available).map(([name]) => ({
      nifcIncidents: "NIFC incidents",
      caPerimeters: "California perimeters",
      caWildfireIntel: "CA Wildfire Intel",
      calOesEvacuations: "CAL OES evacuations",
      viirsHotspots: "NASA FIRMS hotspots",
    }[name] ?? name))
    : [];
  const growth = useMemo(() => {
    if (history.length < 2) return null;
    const last = history[history.length - 1];
    const prev = history[history.length - 2];
    if (last.acres === null || prev.acres === null) return null;
    const lastTime = last.perimeterDate ?? last.capturedAt;
    const prevTime = prev.perimeterDate ?? prev.capturedAt;
    const hours = Math.max((lastTime - prevTime) / 3_600_000, 0.1);
    const deltaAcres = last.acres - prev.acres;
    return {
      deltaAcres,
      hours,
      ratePerHour: deltaAcres / hours,
      containmentDelta: last.contained !== null && prev.contained !== null ? last.contained - prev.contained : null,
      updatedAt: lastTime,
    };
  }, [history]);
  const comparison = useMemo(() => {
    const current = history[historyIndex];
    const previous = history[historyIndex - 1];
    if (!current || !previous) return null;
    const currentTime = current.perimeterDate ?? current.capturedAt;
    const previousTime = previous.perimeterDate ?? previous.capturedAt;
    const deltaAcres = current.acres !== null && previous.acres !== null ? current.acres - previous.acres : null;
    const percentChange = deltaAcres !== null && previous.acres && previous.acres > 0 ? (deltaAcres / previous.acres) * 100 : null;
    return { current, previous, currentTime, previousTime, deltaAcres, percentChange };
  }, [history, historyIndex]);
  const selectedPerimeter = displayData ? perimeterFor(selected, displayData.perimeters) : null;
  const currentFallback: Snapshot[] = selectedPerimeter?.geometry ? [{
    incidentName: textValue(selected?.properties.IncidentName) ?? "Wildfire",
    capturedAt: displayData?.fetchedAt ?? 0,
    perimeterDate: numberValue(selectedPerimeter.properties.poly_PolygonDateTime),
    acres: numberValue(selectedPerimeter.properties.poly_Acres_AutoCalc) ?? numberValue(selectedPerimeter.properties.poly_GISAcres),
    contained: numberValue(selected?.properties.PercentContained),
    state: textValue(selected?.properties.POOState),
    county: textValue(selected?.properties.POOCounty),
    geometry: selectedPerimeter.geometry,
  }] : [];
  const exportFrames = history.length ? history : currentFallback;
  const satelliteImage = satelliteStillUrl(selected);
  const activity = useMemo(() => {
    if (!selected || !displayData) return null;
    const origin = selected.geometry?.type === "Point" ? selected.geometry.coordinates as Position : null;
    let detections = 0;
    let newestHours: number | null = null;
    if (origin) {
      for (const hotspot of displayData.hotspots.features) {
        if (hotspot.geometry?.type !== "Point") continue;
        if (distanceKm(origin, hotspot.geometry.coordinates as Position) > 12) continue;
        detections += 1;
        const hoursOld = numberValue(hotspot.properties.hours_old);
        if (hoursOld !== null) newestHours = newestHours === null ? hoursOld : Math.min(newestHours, hoursOld);
      }
    }
    const zones = displayData.evacuations.features.filter((zone) => {
      if (!zone.geometry) return false;
      if (origin && pointInGeometry(origin, zone.geometry)) return true;
      return selectedPerimeter?.geometry
        ? geometryIntersectsCoverage(selectedPerimeter.geometry, zone.geometry)
        : false;
    });
    const orders = zones.filter((zone) => zone.properties.evacuationClass === "order").length;
    const warnings = zones.filter((zone) => zone.properties.evacuationClass === "warning").length;
    return { detections, newestHours, zones: zones.length, orders, warnings };
  }, [selected, displayData, selectedPerimeter]);
  const intelligenceTimeline = useMemo(() => {
    if (!selected || !displayData) return [];
    const entries: Array<{ time: number; type: "discovery" | "perimeter" | "containment" | "evacuation" | "weather" | "source"; title: string; detail: string }> = [];
    const discovered = discoveryTime(selected);
    if (discovered) entries.push({ time: discovered, type: "discovery", title: "Fire first reported", detail: `${formatAcres(selected.properties.DiscoveryAcres ?? selected.properties.IncidentSize)} • ${locationLabel(selected.properties)}` });
    history.forEach((snapshot, index) => {
      const time = snapshot.perimeterDate ?? snapshot.capturedAt;
      const prior = history[index - 1];
      const delta = prior?.acres !== null && prior?.acres !== undefined && snapshot.acres !== null ? snapshot.acres - prior.acres : null;
      entries.push({
        time,
        type: "perimeter",
        title: index === 0 ? "First perimeter captured" : "Perimeter updated",
        detail: `${formatAcres(snapshot.acres)}${delta !== null ? ` • ${delta >= 0 ? "+" : "−"}${Math.abs(Math.round(delta)).toLocaleString()} acres` : ""}`,
      });
      if (index > 0 && snapshot.contained !== null && prior?.contained !== null && prior?.contained !== undefined && snapshot.contained !== prior.contained) {
        entries.push({ time, type: "containment", title: "Containment changed", detail: `${Math.round(prior.contained)}% → ${Math.round(snapshot.contained)}%` });
      }
    });
    const origin = selected.geometry?.type === "Point" ? selected.geometry.coordinates as Position : null;
    displayData.evacuations.features.forEach((zone) => {
      if (!zone.geometry) return;
      const touches = (origin ? pointInGeometry(origin, zone.geometry) : false)
        || (selectedPerimeter?.geometry ? geometryIntersectsCoverage(selectedPerimeter.geometry, zone.geometry) : false);
      if (!touches) return;
      const time = numberValue(zone.properties.EDIT_DATE ?? zone.properties.EditDate ?? zone.properties.STATEWIDE_LAST_UPDATED) ?? displayData.fetchedAt;
      entries.push({ time, type: "evacuation", title: `${textValue(zone.properties.STATUS) ?? "Evacuation zone"}: ${evacuationLabel(zone)}`, detail: textValue(zone.properties.COUNTY) ?? "California" });
    });
    const sourceUpdated = numberValue(selected.properties.ModifiedOnDateTime_dt);
    if (sourceUpdated) entries.push({ time: sourceUpdated, type: "source", title: "Incident record updated", detail: Array.isArray(selected.properties.sources) ? (selected.properties.sources as string[]).join(" + ") : "NIFC WFIGS" });
    for (const alert of conditions?.alerts ?? []) {
      const time = alert.effective ? Date.parse(alert.effective) : conditions?.updatedAt ?? displayData.fetchedAt;
      if (Number.isFinite(time)) entries.push({ time, type: "weather", title: alert.event, detail: alert.headline ?? `${alert.severity} weather alert` });
    }
    return entries.sort((a, b) => b.time - a.time).slice(0, 32);
  }, [selected, displayData, selectedPerimeter, history, conditions]);
  const selectedId = comparableId(featureId(selected));
  const isFollowingSelected = Boolean(selectedId && followedFires.some((fire) => comparableId(fire.id) === selectedId));
  const shareSummary = selected
    ? [
      `${textValue(selected.properties.IncidentName) ?? "Unnamed fire"} \u2014 ${formatAcres(selected.properties.IncidentSize)}`,
      numberValue(selected.properties.PercentContained) !== null
        ? `${numberValue(selected.properties.PercentContained)}% contained`
        : null,
      growth
        ? `${growth.deltaAcres >= 0 ? "+" : "\u2212"}${Math.abs(Math.round(growth.deltaAcres)).toLocaleString()} acres in ${formatHours(growth.hours)}`
        : null,
    ].filter(Boolean).join(", ") + ` (${locationLabel(selected.properties)}). Updated ${formatDate(data?.fetchedAt, true)}.`
    : "";

  const fitFullCoverage = () => {
    const map = mapRef.current;
    if (!map) return;
    const bounds = dmaFeature?.geometry
      ? geometryBounds(dmaFeature.geometry)
      : displayData ? collectionsBounds([displayData.fires, displayData.perimeters, displayData.evacuations]) : null;
    if (bounds) map.fitBounds(bounds, { padding: 36, duration: 700, maxZoom: 9 });
  };

  const clearSelection = () => {
    setSelected(null);
    setSelectedEvacuation(null);
    updateFireParam(null);
    window.requestAnimationFrame(fitFullCoverage);
  };

  const selectFire = (fire: Feature) => {
    setSelected(fire);
    setSelectedEvacuation(null);
    updateFireParam(comparableId(featureId(fire)));
  };

  const selectEvacuation = (evacuation: Feature) => {
    setSelectedEvacuation(evacuation);
    setSelected(null);
    updateFireParam(null);
    if (evacuation.geometry) {
      mapRef.current?.fitBounds(geometryBounds(evacuation.geometry), { padding: 70, duration: 900, maxZoom: 10 });
    }
  };

  const toggleFollowSelected = async () => {
    if (!selected || !displayData) return;
    const id = comparableId(featureId(selected));
    if (!id) return;
    const existing = followedFires.find((fire) => comparableId(fire.id) === id);
    let next: FollowedFire[];
    if (existing) {
      next = followedFires.filter((fire) => comparableId(fire.id) !== id);
      toast.message(`Stopped following ${textValue(selected.properties.IncidentName) ?? "fire"}`);
    } else {
      const perimeter = perimeterFor(selected, displayData.perimeters);
      next = [...followedFires, {
        id,
        name: textValue(selected.properties.IncidentName) ?? "Unnamed fire",
        acres: numberValue(selected.properties.IncidentSize)
          ?? numberValue(perimeter?.properties.poly_Acres_AutoCalc)
          ?? numberValue(perimeter?.properties.poly_GISAcres),
        contained: numberValue(selected.properties.PercentContained),
        evacuationHash: evacuationHashForFire(selected, perimeter, displayData),
        updatedAt: displayData.fetchedAt,
      }];
      if ("Notification" in window && Notification.permission === "default") await Notification.requestPermission();
      toast.success(`Following ${textValue(selected.properties.IncidentName) ?? "fire"}`, { description: "Growth, containment and evacuation changes will trigger alerts." });
    }
    localStorage.setItem(FOLLOWED_FIRES_KEY, JSON.stringify(next));
    setFollowedFires(next);
  };

  useEffect(() => {
    if (!data || deepLinkAppliedRef.current) return;
    deepLinkAppliedRef.current = true;
    const wanted = comparableId(new URLSearchParams(window.location.search).get("fire"));
    if (!wanted) return;
    const target = data.fires.features.find((fire) => comparableId(featureId(fire)) === wanted);
    if (target) selectFire(target);
  }, [data]);

  const copyToClipboard = async (value: string, which: "link" | "summary") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      window.setTimeout(() => setCopied((current) => (current === which ? null : current)), 2000);
    } catch {
      // Clipboard unavailable (permissions/insecure context); button simply doesn't confirm.
    }
  };

  useEffect(() => {
    if (!displayData || !followedLoadedRef.current) return;
    const stored = loadFollowedFires();
    if (!stored.length) return;
    let changed = false;
    const updated = stored.map((record) => {
      const fire = displayData.fires.features.find((candidate) => comparableId(featureId(candidate)) === comparableId(record.id));
      if (!fire) return record;
      const perimeter = perimeterFor(fire, displayData.perimeters);
      const acres = numberValue(fire.properties.IncidentSize)
        ?? numberValue(perimeter?.properties.poly_Acres_AutoCalc)
        ?? numberValue(perimeter?.properties.poly_GISAcres);
      const contained = numberValue(fire.properties.PercentContained);
      const evacuationHash = evacuationHashForFire(fire, perimeter, displayData);
      const messages: string[] = [];
      if (acres !== null && record.acres !== null && acres - record.acres >= alertPreferences.growthThresholdAcres) {
        messages.push(`grew ${Math.round(acres - record.acres).toLocaleString()} acres`);
      }
      if (contained !== null && record.contained !== null && Math.abs(contained - record.contained) >= alertPreferences.containmentThresholdPoints) {
        messages.push(`containment changed from ${Math.round(record.contained)}% to ${Math.round(contained)}%`);
      }
      if (alertPreferences.evacuationChanges && evacuationHash !== record.evacuationHash) {
        messages.push(evacuationHash ? "evacuation zones changed" : "touching evacuation zones were cleared");
      }
      if (messages.length && displayData.fetchedAt > record.updatedAt) {
        const title = `${record.name} update`;
        const body = messages.join(" • ");
        toast.warning(title, { description: body, duration: 18_000, action: { label: "View", onClick: () => selectFire(fire) } });
        browserNotify(title, body);
      }
      const next = { ...record, name: textValue(fire.properties.IncidentName) ?? record.name, acres, contained, evacuationHash, updatedAt: displayData.fetchedAt };
      if (JSON.stringify(next) !== JSON.stringify(record)) changed = true;
      return next;
    });
    if (changed) {
      localStorage.setItem(FOLLOWED_FIRES_KEY, JSON.stringify(updated));
      setFollowedFires(updated);
    }
  }, [displayData, alertPreferences]);

  useEffect(() => {
    if (!displayData) return;
    const now = Date.now();
    const dmaKey = dmaPreference?.id ?? "all";

    // A feed that was down and came back re-adds fires we may never have seen.
    // Absorb those silently instead of announcing all of California as breaking news.
    const feeds = displayData.feedStatus ?? null;
    const previousFeeds = feedStatusRef.current;
    const feedRecovered = Boolean(feeds && previousFeeds
      && Object.entries(feeds).some(([name, available]) => available && previousFeeds[name] === false));
    feedStatusRef.current = feeds;

    let seen = seenFiresRef.current;
    const coldStart = seen === null;
    if (seen === null) {
      seen = loadSeenFires();
      seenFiresRef.current = seen;
    }
    // True first visit (no stored history): seed silently. A returning visitor
    // gets alerted about genuinely new fires that started since their last check.
    const firstVisit = coldStart && Object.keys(seen).length === 0;
    const dmaChanged = dmaKeyRef.current !== null && dmaKeyRef.current !== dmaKey;
    dmaKeyRef.current = dmaKey;

    const suppress = firstVisit || dmaChanged || feedRecovered;
    const arrivals: Feature[] = [];
    for (const fire of displayData.fires.features) {
      const id = comparableId(featureId(fire));
      if (!id) continue;
      const alreadySeen = seen[id] !== undefined;
      seen[id] = now;
      if (alreadySeen || suppress) continue;
      // Only treat as breaking if the fire itself is recent, not merely new to this feed.
      const discovered = discoveryTime(fire);
      const recent = discovered !== null
        ? now - discovered <= 24 * 3_600_000
        : fire.properties.isNew === true;
      if (recent) arrivals.push(fire);
    }
    for (const [id, lastSeen] of Object.entries(seen)) {
      if (now - lastSeen > 7 * 24 * 3_600_000) delete seen[id];
    }
    try {
      localStorage.setItem(SEEN_FIRES_KEY, JSON.stringify(seen));
    } catch {
      // Storage unavailable (private mode/quota); in-memory tracking still works.
    }
    if (!arrivals.length) return;
    arrivals.sort((a, b) => (discoveryTime(b) ?? 0) - (discoveryTime(a) ?? 0));
    setBreaking((current) => {
      const merged = [...arrivals, ...current];
      const seen = new Set<string>();
      return merged.filter((fire) => {
        const id = comparableId(featureId(fire)) ?? textValue(fire.properties.IncidentName) ?? "";
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      }).slice(0, 8);
    });
    for (const fire of arrivals.slice(0, 4)) {
      const discovered = discoveryTime(fire);
      const alertBody = `${locationLabel(fire.properties)}${discovered ? ` • first reported ${relativeTime(discovered)}` : ""}`;
      toast.warning(`New fire: ${textValue(fire.properties.IncidentName) ?? "Unnamed fire"}`, {
        description: alertBody,
        duration: 15_000,
        action: { label: "View", onClick: () => selectFire(fire) },
      });
      if (alertPreferences.coverageNewFires) browserNotify(`New fire: ${textValue(fire.properties.IncidentName) ?? "Unnamed fire"}`, alertBody);
    }
  }, [displayData, dmaPreference, alertPreferences.coverageNewFires]);

  const exportStill = async () => {
    if (!exportFrames.length) return;
    const canvas = await frameCanvas(exportFrames, Math.min(historyIndex, exportFrames.length - 1));
    downloadBlob(await canvasBlob(canvas), `${safeFileName(exportFrames[0].incidentName)}-growth.png`);
  };

  const exportGif = async () => {
    if (exportFrames.length < 2) return;
    setExporting(true);
    try {
      downloadBlob(await growthGifBlob(exportFrames), `${safeFileName(exportFrames[0].incidentName)}-growth.gif`);
    } finally {
      setExporting(false);
    }
  };

  const exportNewsroomPackage = async () => {
    if (!selected || !displayData || !exportFrames.length) return;
    setNewsroomExporting(true);
    try {
      const baseName = safeFileName(textValue(selected.properties.IncidentName) ?? "wildfire");
      const files: Array<{ name: string; blob: Blob }> = [];
      files.push({ name: "graphics/fire-growth-16x9.png", blob: await canvasBlob(await frameCanvas(exportFrames, Math.min(historyIndex, exportFrames.length - 1))) });
      if (exportFrames.length >= 2) files.push({ name: "graphics/fire-growth.gif", blob: await growthGifBlob(exportFrames) });

      const origin = selected.geometry?.type === "Point" ? selected.geometry.coordinates as Position : null;
      const touchingZones = displayData.evacuations.features.filter((zone) => zone.geometry && (
        (origin ? pointInGeometry(origin, zone.geometry) : false)
        || (selectedPerimeter?.geometry ? geometryIntersectsCoverage(selectedPerimeter.geometry, zone.geometry) : false)
      ));
      const nearbyHotspots = origin ? displayData.hotspots.features.filter((hotspot) => hotspot.geometry?.type === "Point" && distanceKm(origin, hotspot.geometry.coordinates as Position) <= 12) : [];
      const historyGeoJson = {
        type: "FeatureCollection",
        features: exportFrames.map((snapshot, index) => ({
          type: "Feature",
          properties: {
            frame: index + 1,
            incidentName: snapshot.incidentName,
            capturedAt: snapshot.capturedAt,
            perimeterDate: snapshot.perimeterDate,
            acres: snapshot.acres,
            contained: snapshot.contained,
            county: snapshot.county,
            state: snapshot.state,
          },
          geometry: snapshot.geometry,
        })),
      };
      const json = (value: unknown, mime = "application/json") => new Blob([JSON.stringify(value, null, 2)], { type: mime });
      files.push({ name: "data/incident.json", blob: json({ exportedAt: Date.now(), fetchedAt: displayData.fetchedAt, properties: selected.properties, geometry: selected.geometry }) });
      files.push({ name: "data/perimeter-history.geojson", blob: json(historyGeoJson, "application/geo+json") });
      files.push({ name: "data/evacuation-zones.geojson", blob: json({ type: "FeatureCollection", features: touchingZones }, "application/geo+json") });
      files.push({ name: "data/hotspots-12km.geojson", blob: json({ type: "FeatureCollection", features: nearbyHotspots }, "application/geo+json") });
      if (conditions) files.push({ name: "data/weather-air-quality.json", blob: json(conditions) });
      files.push({ name: "sources/source-manifest.json", blob: json({ generatedAt: Date.now(), fireDataUpdatedAt: displayData.fetchedAt, sources: displayData.sources ?? {}, conditions: conditions?.sources ?? {} }) });
      downloadBlob(await createStoredZip(files), `${baseName}-newsroom-package.zip`);
      toast.success("Newsroom package ready", { description: "Graphics, GeoJSON, incident data and source metadata were included. No written summaries were generated." });
    } catch {
      toast.error("Newsroom package could not be created");
    } finally {
      setNewsroomExporting(false);
    }
  };

  const fireList = (items: Feature[]) => (
    <div className="fire-list">
      {items.slice(0, 80).map((fire) => {
        const id = featureId(fire) ?? String(fire.properties.OBJECTID ?? fire.properties.IncidentName);
        const isSelected = comparableId(featureId(selected)) === comparableId(featureId(fire));
        return (
          <button key={id} className={`fire-row ${isSelected ? "selected" : ""}`} onClick={isSelected ? clearSelection : () => selectFire(fire)} aria-pressed={isSelected}>
            <span className={`fire-dot ${fire.properties.isNew === true ? "new" : ""}`} />
            <span className="fire-row-main">
              <strong>{textValue(fire.properties.IncidentName) ?? "Unnamed fire"}</strong>
              <span>
                {locationLabel(fire.properties)}
                {fire.properties.isNew === true && discoveryTime(fire) !== null
                  ? ` • ${relativeTime(discoveryTime(fire) as number)}`
                  : ""}
              </span>
            </span>
            <span className="fire-row-size">
              {numberValue(fire.properties.IncidentSize)?.toLocaleString() ?? "—"}
              <small>acres</small>
            </span>
          </button>
        );
      })}
    </div>
  );

  const evacuationList = (
    <div className="fire-list evacuation-list">
      {evacuations.slice(0, 120).map((evacuation) => {
        const id = evacuationId(evacuation) ?? evacuationLabel(evacuation);
        const statusClass = textValue(evacuation.properties.evacuationClass) ?? "other";
        return (
          <button key={id} className={`fire-row evacuation-row ${evacuationId(selectedEvacuation) === evacuationId(evacuation) ? "selected" : ""}`} onClick={() => evacuationId(selectedEvacuation) === evacuationId(evacuation) ? clearSelection() : selectEvacuation(evacuation)}>
            <span className={`evacuation-dot ${statusClass}`} />
            <span className="fire-row-main">
              <strong>{evacuationLabel(evacuation)}</strong>
              <span>{[textValue(evacuation.properties.STATUS), textValue(evacuation.properties.COUNTY)].filter(Boolean).join(" • ")}</span>
            </span>
            <ShieldAlert size={15} />
          </button>
        );
      })}
    </div>
  );

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div className="brand-mark"><Flame size={19} fill="currentColor" /></div>
        <div>
          <h1>Fire Growth Tracker</h1>
          <p>{dmaPreference ? `${dmaPreference.name} • California coverage` : "California wildfire & evacuation intelligence"}</p>
        </div>
        <div className="topbar-status">
          <span className="live-pill"><i /> LIVE</span>
          <span>{data ? `Updated ${formatDate(data.fetchedAt, true)}` : "Connecting to California feeds"}</span>
          <Button variant="ghost" size="icon" aria-label="Refresh fire data" onClick={() => void loadData()}>
            <RefreshCw size={16} />
          </Button>
          <Button asChild variant="outline" size="sm" className="settings-button">
            <Link href="/settings"><Settings size={15} /> Settings</Link>
          </Button>
        </div>
      </header>

      {metricPreferences.length > 0 && (
        <section className="stat-strip" aria-label="California fire and evacuation summary" style={{ gridTemplateColumns: `repeat(${metricPreferences.length}, minmax(0, 1fr))` }}>
          {metricPreferences.map((id) => (
            <div key={id}><span>{metricCards[id].label}</span><strong className={metricCards[id].accent ? "accent" : ""}>{metricCards[id].value}</strong></div>
          ))}
        </section>
      )}

      {error && <div className="error-banner"><CircleAlert size={17} /> {error}</div>}
      {!error && unavailableFeeds.length > 0 && <div className="feed-warning"><CircleAlert size={15} /> Partial update: {unavailableFeeds.join(", ")} unavailable. Other California feeds remain live.</div>}
      {breaking.length > 0 && (
        <div className="breaking-banner" role="status" aria-live="polite">
          <span className="breaking-tag"><BellRing size={13} /> NEW FIRE{breaking.length > 1 ? "S" : ""}</span>
          <div className="breaking-items">
            {breaking.slice(0, 4).map((fire, index) => {
              const discovered = discoveryTime(fire);
              return (
                <button key={comparableId(featureId(fire)) ?? `breaking-${index}`} onClick={() => selectFire(fire)}>
                  <strong>{textValue(fire.properties.IncidentName) ?? "Unnamed fire"}</strong>
                  <span>{locationLabel(fire.properties)}{discovered !== null ? ` • ${relativeTime(discovered)}` : ""}</span>
                </button>
              );
            })}
            {breaking.length > 4 && <em>+{breaking.length - 4} more in the New 24h tab</em>}
          </div>
          <button className="breaking-dismiss" onClick={() => setBreaking([])}>Dismiss</button>
        </div>
      )}

      <section className="workspace-grid">
        <aside className="incident-panel">
          <Tabs defaultValue="active">
            <TabsList className="incident-tabs">
              <TabsTrigger value="active">Active</TabsTrigger>
              <TabsTrigger value="new">New 24h <b>{newFires.length}</b></TabsTrigger>
              <TabsTrigger value="following">Following <b>{activeFollowedFires.length}</b></TabsTrigger>
              <TabsTrigger value="evacuations">Evacuations <b>{evacuations.length}</b></TabsTrigger>
            </TabsList>
            <TabsContent value="active">{loading ? <div className="loading-list"><LoaderCircle className="spin" /> Loading current incidents…</div> : fireList(sortedFires)}</TabsContent>
            <TabsContent value="new">{newFires.length ? fireList(newFires) : <div className="empty-list">No new California Wildfire Intel starts in the last 24 hours.</div>}</TabsContent>
            <TabsContent value="following">{activeFollowedFires.length ? fireList(activeFollowedFires) : <div className="empty-list">No active followed fires. Select a fire and choose Follow fire.</div>}</TabsContent>
            <TabsContent value="evacuations">{loading ? <div className="loading-list"><LoaderCircle className="spin" /> Loading CAL OES zones…</div> : evacuations.length ? evacuationList : <div className="empty-list">No active CAL OES evacuation zones in this coverage area.</div>}</TabsContent>
          </Tabs>
        </aside>

        <section className="map-panel">
          {!mapReady && <OverviewFallbackMap data={displayData} coverage={dmaFeature} perimetersOn={perimetersOn} evacuationsOn={evacuationsOn} />}
          <div ref={mapContainer} className="map-canvas" aria-label="Interactive wildfire map" />
          {mapError && <div className="map-error"><CircleAlert size={16} /> Map tiles could not load. <button onClick={() => window.location.reload()}>Retry</button></div>}
          <div className="map-tools">
            <Button variant="secondary" size="sm" onClick={clearSelection}>
              <MapPin size={15} /> Entire DMA
            </Button>
            <Button className={perimetersOn ? "active" : ""} variant="secondary" size="sm" onClick={() => setPerimetersOn((value) => !value)}>
              <Layers3 size={15} /> Perimeters
            </Button>
            <Button className={evacuationsOn ? "active" : ""} variant="secondary" size="sm" onClick={() => setEvacuationsOn((value) => !value)}>
              <ShieldAlert size={15} /> Evacuations
            </Button>
            <Button className={hotspotsOn ? "active" : ""} variant="secondary" size="sm" onClick={() => setHotspotsOn((value) => !value)}>
              <Satellite size={15} /> VIIRS hotspots
            </Button>
            <Button className={heatmapOn ? "active" : ""} variant="secondary" size="sm" onClick={() => setHeatmapOn((value) => !value)}>
              <Thermometer size={15} /> Heat map
            </Button>
          </div>
          <div className="map-legend">
            <span><i className="legend-new" /> New start</span>
            <span><i className="legend-fire" /> Active fire</span>
            {perimetersOn && <span><i className="legend-perimeter" /> Reported perimeter</span>}
            <span><i className="legend-hotspot" /> Thermal hotspot</span>
            {heatmapOn && <span><i className="legend-heat" /> Heat intensity</span>}
            {evacuationsOn && <><span><i className="legend-evac-order" /> Evac order</span><span><i className="legend-evac-warning" /> Warning</span><span><i className="legend-shelter" /> Shelter in place</span></>}
          </div>
        </section>

        <aside className="detail-panel">
          {selectedEvacuation ? (
            <>
              <div className={`detail-heading evacuation-detail ${textValue(selectedEvacuation.properties.evacuationClass) ?? "other"}`}>
                <span>CAL OES • ACTIVE EVACUATION ZONE</span>
                <h2>{evacuationLabel(selectedEvacuation)}</h2>
                <p>{[textValue(selectedEvacuation.properties.COUNTY), textValue(selectedEvacuation.properties.CITY)].filter(Boolean).join(" • ") || "California"}</p>
              </div>
              <div className="detail-metrics evacuation-metrics">
                <div><span>Status</span><strong>{textValue(selectedEvacuation.properties.STATUS) ?? "Active"}</strong></div>
                <div><span>Zone ID</span><strong>{textValue(selectedEvacuation.properties.ZONE_ID) ?? "—"}</strong></div>
                <div><span>Event</span><strong>{textValue(selectedEvacuation.properties.EVENT_TYPE) ?? "Not specified"}</strong></div>
                <div><span>Updated</span><strong>{formatDate(selectedEvacuation.properties.EDIT_DATE ?? selectedEvacuation.properties.EditDate, true)}</strong></div>
              </div>
              <section className="evacuation-info-card">
                <div className="section-title"><ShieldAlert size={15} /><span>Official information</span></div>
                <p>{textValue(selectedEvacuation.properties.PUBLIC_INFO) ?? textValue(selectedEvacuation.properties.CRITICAL_INFO) ?? textValue(selectedEvacuation.properties.NOTES) ?? "No additional public information was supplied for this zone."}</p>
                <small>Follow local law-enforcement and emergency-management instructions. CAL OES polygons are statewide operational data.</small>
              </section>
            </>
          ) : !selected ? (
            <div className="detail-empty">
              <MapPin size={27} />
              <h2>Select a fire</h2>
              <p>Choose an incident from the list or map to open its satellite image and growth record.</p>
            </div>
          ) : (
            <>
              <div className="detail-heading">
                <button className="detail-close" onClick={clearSelection} aria-label="Close fire details and show entire DMA"><X size={16} /></button>
                <span>{selected.properties.isNew === true ? `${textValue(selected.properties.reportingStatus) ?? "PRELIMINARY"} • NEW START` : "ACTIVE INCIDENT"}</span>
                <h2>{textValue(selected.properties.IncidentName) ?? "Unnamed fire"}</h2>
                <p>{locationLabel(selected.properties)}</p>
                {numberValue(selected.properties.ModifiedOnDateTime_dt) !== null && (
                  <em className="updated-chip">Source updated {relativeTime(numberValue(selected.properties.ModifiedOnDateTime_dt) as number)}</em>
                )}
              </div>
              <div className="follow-bar">
                <div><strong>{isFollowingSelected ? "Following this fire" : "Follow this fire"}</strong><span>Growth, containment and evacuation-change alerts</span></div>
                <Button variant={isFollowingSelected ? "outline" : "default"} size="sm" onClick={() => void toggleFollowSelected()}>
                  {isFollowingSelected ? <BellOff size={14} /> : <Bell size={14} />} {isFollowingSelected ? "Unfollow" : "Follow"}
                </Button>
              </div>
              <div className="detail-metrics">
                <div><span>Reported size</span><strong>{formatAcres(selected.properties.IncidentSize)}</strong></div>
                <div><span>Containment</span><strong>{numberValue(selected.properties.PercentContained) ?? "—"}%</strong></div>
                <div><span>Discovered</span><strong>{formatDate(selected.properties.FireDiscoveryDateTime, true)}</strong></div>
                <div><span>Latest perimeter</span><strong>{selectedPerimeter ? formatDate(selectedPerimeter.properties.poly_PolygonDateTime, true) : "Not reported"}</strong></div>
              </div>
              <div className="incident-source-note">
                <span>Unified record</span>
                <p>{Array.isArray(selected.properties.sources) ? (selected.properties.sources as string[]).join(" + ") : "NIFC WFIGS"}</p>
                {(numberValue(selected.properties.sourceReports) ?? 1) > 1 && <small>{numberValue(selected.properties.sourceReports)} matching source reports merged</small>}
                {selectedPerimeter && <small>Latest perimeter: {textValue(selectedPerimeter.properties.perimeterSource) ?? "CAL FIRE / FIRIS / NIFC"} • {formatAcres(selectedPerimeter.properties.poly_Acres_AutoCalc)}</small>}
              </div>

              <section className="camera-card">
                <div className="section-title"><Video size={15} /><span>Five closest ALERTCalifornia cameras</span></div>
                {camerasLoading ? <div className="inline-loading"><LoaderCircle className="spin" size={15} /> Finding nearby cameras…</div> : nearbyCameras.length ? (
                  <ol className="camera-list">
                    {nearbyCameras.map((camera) => (
                      <li key={camera.cameraId}>
                        <a href={camera.url} target="_blank" rel="noreferrer">
                          <span><strong>{camera.name}</strong><small>{camera.county ? `${camera.county} • ` : ""}{camera.distanceMiles.toFixed(1)} miles away</small></span>
                          <ExternalLink size={14} />
                        </a>
                      </li>
                    ))}
                  </ol>
                ) : <div className="image-unavailable">Nearby camera links are temporarily unavailable.</div>}
              </section>

              <section className="share-card">
                <div className="section-title"><Link2 size={15} /><span>Share</span></div>
                <p className="share-summary">{shareSummary}</p>
                <div className="export-actions">
                  <Button variant="secondary" onClick={() => void copyToClipboard(window.location.href, "link")}>
                    {copied === "link" ? <Check size={15} /> : <Link2 size={15} />} {copied === "link" ? "Link copied" : "Copy link"}
                  </Button>
                  <Button variant="secondary" onClick={() => void copyToClipboard(shareSummary, "summary")}>
                    {copied === "summary" ? <Check size={15} /> : <Copy size={15} />} {copied === "summary" ? "Copied" : "Copy summary"}
                  </Button>
                </div>
              </section>

              <section className="update-card">
                <div className="section-title">
                  <TrendingUp size={15} />
                  <span>Latest update</span>
                  {growth && <b>{relativeTime(growth.updatedAt)}</b>}
                </div>
                {growth ? (
                  <>
                    <p className={`growth-delta ${growth.deltaAcres >= 0 ? "up" : "down"}`}>
                      {growth.deltaAcres >= 0 ? "+" : "−"}{Math.abs(Math.round(growth.deltaAcres)).toLocaleString()} acres in {formatHours(growth.hours)}
                      <small>
                        ≈ {Math.abs(Math.round(growth.ratePerHour)).toLocaleString()} ac/hr {growth.deltaAcres >= 0 ? "growth" : "reduction"} since previous perimeter
                      </small>
                    </p>
                    {growth.containmentDelta !== null && growth.containmentDelta !== 0 && (
                      <p className="containment-delta">
                        Containment {growth.containmentDelta > 0 ? "up" : "down"} {Math.abs(Math.round(growth.containmentDelta))} pts between perimeters
                      </p>
                    )}
                  </>
                ) : (
                  <p className="growth-delta neutral">
                    {history.length === 1
                      ? "First perimeter captured — change tracking begins with the next published shape."
                      : "No perimeter change record yet for this fire."}
                  </p>
                )}
                <AcresSparkline snapshots={history} />
                <ul className="activity-list">
                  <li>
                    <span>Heat detections • 12 km • 24 h</span>
                    <strong className={activity?.detections ? "hot" : ""}>
                      {activity?.detections
                        ? `${activity.detections}${activity.newestHours !== null ? ` • newest ${formatHours(activity.newestHours)} ago` : ""}`
                        : "None"}
                    </strong>
                  </li>
                  <li>
                    <span>Evac zones touching fire</span>
                    <strong className={activity?.orders ? "hot" : ""}>
                      {activity?.zones
                        ? `${activity.orders} order${activity.orders === 1 ? "" : "s"} • ${activity.warnings} warning${activity.warnings === 1 ? "" : "s"}`
                        : "None reported"}
                    </strong>
                  </li>
                </ul>
              </section>

              <section className="comparison-card">
                <div className="section-title"><Layers3 size={15} /><span>Perimeter change map</span>{comparison && <b>{formatHours(Math.max((comparison.currentTime - comparison.previousTime) / 3_600_000, 0))}</b>}</div>
                {comparison ? (
                  <>
                    <div className="comparison-metrics">
                      <div><i className="compare-swatch previous" /><span>Previous</span><strong>{formatAcres(comparison.previous.acres)}</strong><small>{formatDate(comparison.previousTime, true)}</small></div>
                      <div><i className="compare-swatch current" /><span>Selected</span><strong>{formatAcres(comparison.current.acres)}</strong><small>{formatDate(comparison.currentTime, true)}</small></div>
                    </div>
                    <p className={`comparison-delta ${(comparison.deltaAcres ?? 0) >= 0 ? "up" : "down"}`}>
                      {comparison.deltaAcres !== null ? `${comparison.deltaAcres >= 0 ? "+" : "−"}${Math.abs(Math.round(comparison.deltaAcres)).toLocaleString()} acres` : "Acreage change unavailable"}
                      {comparison.percentChange !== null && <small>{comparison.percentChange >= 0 ? "+" : "−"}{Math.abs(comparison.percentChange).toFixed(1)}%</small>}
                    </p>
                    <p className="comparison-note">On the map, orange outside the dashed blue perimeter is newly mapped; blue outside orange was removed or revised. Perimeter revisions do not always represent fire spread.</p>
                  </>
                ) : <p className="growth-delta neutral">Select any frame after the first to compare it with the immediately preceding perimeter.</p>}
              </section>

              <section className="timeline-card">
                <div className="section-title"><Clock size={15} /><span>Fire intelligence timeline</span><b>{intelligenceTimeline.length} events</b></div>
                {intelligenceTimeline.length ? <ol className="intelligence-timeline">{intelligenceTimeline.map((item, index) => (
                  <li key={`${item.time}-${item.type}-${index}`} className={item.type}>
                    <i />
                    <div><time>{formatDate(item.time, true)}</time><strong>{item.title}</strong><span>{item.detail}</span></div>
                  </li>
                ))}</ol> : <p className="growth-delta neutral">No timeline events are available yet.</p>}
              </section>

              <section className="satellite-card">
                <div className="section-title"><Satellite size={15} /><span>Latest thermal satellite image</span></div>
                {satelliteImage ? (
                  <img src={satelliteImage} alt={`Latest GOES fire-temperature satellite view near ${textValue(selected.properties.IncidentName) ?? "the selected fire"}`} />
                ) : <div className="image-unavailable">Satellite frame unavailable for this location.</div>}
                <p>NASA GIBS • GOES ABI Fire Temperature • latest available frame</p>
              </section>

              <section className="growth-card">
                <div className="section-title"><Play size={15} /><span>Perimeter growth</span><b>{exportFrames.length} frame{exportFrames.length === 1 ? "" : "s"}</b></div>
                {exportFrames.length ? (
                  <>
                    <div className="growth-preview">
                      <GrowthMapPreview snapshots={exportFrames} activeIndex={historyIndex} />
                    </div>
                    <Slider
                      aria-label="Growth frame"
                      min={0}
                      max={Math.max(0, exportFrames.length - 1)}
                      step={1}
                      value={[Math.min(historyIndex, exportFrames.length - 1)]}
                      onValueChange={(value) => setHistoryIndex(value[0] ?? 0)}
                      disabled={exportFrames.length < 2}
                    />
                    {exportFrames.length < 2 && <p className="history-note">The first perimeter is saved. GIF export activates after NIFC publishes another changed shape.</p>}
                    <div className="export-actions">
                      <Button variant="secondary" onClick={() => void exportStill()}><ImageDown size={15} /> PNG \u2022 720p</Button>
                      <Button onClick={() => void exportGif()} disabled={exportFrames.length < 2 || exporting}>
                        {exporting ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />} Growth GIF \u2022 720p
                      </Button>
                    </div>
                    <Button className="newsroom-package-button" variant="outline" onClick={() => void exportNewsroomPackage()} disabled={newsroomExporting}>
                      {newsroomExporting ? <LoaderCircle className="spin" size={15} /> : <Archive size={15} />} Newsroom graphics & data package
                    </Button>
                    <p className="history-note">Includes the 16:9 PNG, growth GIF when available, perimeter history, nearby hotspots, evacuation zones, weather/AQI data and source metadata. No written summaries are generated.</p>
                  </>
                ) : <div className="image-unavailable">NIFC has not published a perimeter for this fire.</div>}
              </section>
            </>
          )}
        </aside>
      </section>
      <footer>
        California-only view. New starts: CA Wildfire Intel. Perimeters: CAL FIRE intelligence, FIRIS and NIFC. Hotspots: NASA FIRMS VIIRS. Evacuations: CAL OES. Operational data may be revised.
      </footer>
      <Toaster position="top-center" />
    </main>
  );
}
