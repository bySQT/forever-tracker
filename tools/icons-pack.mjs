// Monthly refresh of the icon data pack in the public release repository (ADR-017).
// Runs as a GitHub Action with the Blizzard API client in the repository secrets
// BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET; same pack format as `pnpm icons:pack` (Rust).
// Writes data/icons.json and raises the icons version in data/manifest.json.
// Usage: node tools/icons-pack.mjs [data folder]   (default: ./data)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://eu.api.blizzard.com";
const ITEM_NAMESPACES = ["static-classic1x-eu", "static-classic-eu"];
const CLASS_NAMESPACES = ["static-classic1x-eu", "static-classic-eu", "static-eu"];
const PAGE_SIZE = 1000;
const CLASSES = {
  WARRIOR: 1,
  PALADIN: 2,
  HUNTER: 3,
  ROGUE: 4,
  PRIEST: 5,
  SHAMAN: 7,
  MAGE: 8,
  WARLOCK: 9,
  DRUID: 11,
};
const SKILL_LINES = [171, 164, 333, 202, 165, 197, 182, 186, 393, 185, 356, 129];

/** Icon URL from a media document: the asset with key "icon". */
export function iconAsset(media) {
  const asset = (media?.assets ?? []).find((a) => a?.key === "icon");
  return typeof asset?.value === "string" ? asset.value : undefined;
}

/** "https://…/icons/56/inv_x.jpg" -> ["https://…/icons/56/", "inv_x"] */
export function splitIconUrl(url) {
  const match = /^(https:\/\/.+\/)([^/]+)\.jpg$/.exec(url);
  return match ? [match[1], match[2]] : undefined;
}

/** The pack: items sharing the most common base are stored as short names. */
export function buildPack(version, items, classes, professions) {
  const counts = new Map();
  for (const [, url] of items) {
    const split = splitIconUrl(url);
    if (split) counts.set(split[0], (counts.get(split[0]) ?? 0) + 1);
  }
  const base = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  const itemMap = {};
  for (const [id, url] of [...items].sort((a, b) => a[0] - b[0])) {
    const split = splitIconUrl(url);
    itemMap[String(id)] = split && split[0] === base ? split[1] : url;
  }
  const sorted = (entries) =>
    Object.fromEntries([...entries].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  // Keys in the same order as the Rust tool writes them, so refreshes give small diffs.
  return {
    base,
    classes: sorted(classes),
    description:
      "Icon names of items, classes and professions from the official Blizzard Game Data API. Pictures are loaded from Blizzard's render server, not shipped.",
    items: itemMap,
    professions: sorted(professions.map(([id, url]) => [String(id), url])),
    source: "https://develop.battle.net/documentation/world-of-warcraft-classic/game-data-apis",
    status: "bestaetigt",
    version,
  };
}

export function today(date = new Date()) {
  return date.toISOString().slice(0, 10).replaceAll("-", ".");
}

async function token(id, secret) {
  const response = await fetch("https://oauth.battle.net/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!response.ok) throw new Error(`Blizzard login failed: HTTP ${response.status}`);
  return (await response.json()).access_token;
}

async function getJson(url, bearer) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Blizzard API: HTTP ${response.status} for ${url}`);
  return response.json();
}

/** The media search returns at most 1000 results per query: ask in ID ranges. */
async function items(bearer) {
  for (const namespace of ITEM_NAMESPACES) {
    const all = new Map();
    let start = 0;
    for (;;) {
      const url = `${API}/data/wow/search/media?namespace=${namespace}&tags=item&id=%5B${start},%5D&orderby=id&_pageSize=${PAGE_SIZE}&_page=1`;
      const doc = await getJson(url, bearer);
      const results = doc?.results ?? [];
      for (const r of results) {
        const icon = iconAsset(r?.data);
        if (Number.isInteger(r?.data?.id) && icon) all.set(r.data.id, icon);
      }
      const ids = results.map((r) => r?.data?.id).filter(Number.isInteger);
      console.log(`${namespace}: from ID ${start}: ${results.length} results`);
      if (results.length < PAGE_SIZE || ids.length === 0) break;
      start = Math.max(...ids) + 1;
    }
    if (all.size > 0) return [...all];
  }
  return [];
}

async function firstIcon(bearer, path, namespaces) {
  for (const namespace of namespaces) {
    const icon = iconAsset(
      await getJson(`${API}/data/wow/media/${path}?namespace=${namespace}`, bearer),
    );
    if (icon) return icon;
  }
  return undefined;
}

async function main() {
  const id = process.env.BLIZZARD_CLIENT_ID;
  const secret = process.env.BLIZZARD_CLIENT_SECRET;
  if (!id || !secret) throw new Error("BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET are not set.");
  const dataDir = resolve(process.argv[2] ?? "data");
  const bearer = await token(id, secret);
  const itemList = await items(bearer);
  // Never replace a good pack with an empty one (e.g. a temporary API problem).
  if (itemList.length < 1000)
    throw new Error(`Only ${itemList.length} item icons – pack not written.`);
  const classes = [];
  for (const [file, classId] of Object.entries(CLASSES)) {
    const icon = await firstIcon(bearer, `playable-class/${classId}`, CLASS_NAMESPACES);
    if (icon) classes.push([file, icon]);
  }
  const professions = [];
  for (const skillLine of SKILL_LINES) {
    const icon = await firstIcon(bearer, `profession/${skillLine}`, ["static-eu"]);
    if (icon) professions.push([skillLine, icon]);
  }
  const version = today();
  const pack = buildPack(version, itemList, classes, professions);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "icons.json"), JSON.stringify(pack, null, 2) + "\n");
  const manifestPath = join(dataDir, "manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  manifest.packs = { ...manifest.packs, icons: { version } };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `icons ${version}: ${itemList.length} items, ${classes.length} classes, ${professions.length} professions`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
