// Resolves a related image for every soundboard / library sound, once, at
// build time — so the app never depends on rate-limited lookups at runtime.
//
//   wiki:  lead image of the subject's Wikipedia article (REST page summary)
//   mal:   anime character portrait (AniList)
//   icon:  official brand mark (Simple Icons, CC0), written as a local SVG tile
//   keep:  the sound's current image is already the subject — keep it
//   none:  subject unknown — the app draws a clean name tile instead of stock art
//
// Usage: node tools/sound-art/resolve.mjs   (writes tools/sound-art/resolved.json
//        and assets/sound-art/*.svg)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const require = createRequire(import.meta.url);
const SOURCES = JSON.parse(fs.readFileSync(path.join(root, 'tools/sound-art/sources.json'), 'utf8'));
const outJson = path.join(root, 'tools/sound-art/resolved.json');
const artDir = path.join(root, 'assets/sound-art');
fs.mkdirSync(artDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { 'User-Agent': 'BeatriceVoiceChanger/2.2 (https://github.com/satiricalguru/Beatrice-voicechanger-mac)' };

async function wiki(title) {
  const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, { headers: UA });
  if (!res.ok) throw new Error(`wiki ${res.status} ${title}`);
  const d = await res.json();
  const src = d.originalimage?.source || d.thumbnail?.source;
  if (!src) throw new Error(`wiki no image ${title}`);
  // Prefer a ~500px thumbnail (a size Wikimedia serves): light enough for a soundboard tile.
  const thumb = d.thumbnail?.source ? d.thumbnail.source.replace(/\/(\d+)px-/, '/500px-') : src;
  return { url: d.originalimage && d.originalimage.width <= 500 ? d.originalimage.source : thumb, from: `Wikipedia: ${d.title}` };
}

async function mal(name) {
  // AniList (MyAnimeList's Jikan API is unreachable from some networks).
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { ...UA, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: 'query($s:String){Character(search:$s){name{full} image{large}}}', variables: { s: name } }),
    });
    if (res.status === 429) { await sleep(2000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`anilist ${res.status} ${name}`);
    const c = (await res.json()).data?.Character;
    if (!c?.image?.large) throw new Error(`anilist none ${name}`);
    return { url: c.image.large, from: `AniList: ${c.name.full}` };
  }
  throw new Error(`anilist rate-limited ${name}`);
}

function icon(slug) {
  const si = require(path.join(root, '..', 'website', 'node_modules', 'simple-icons'));
  const key = 'si' + slug[0].toUpperCase() + slug.slice(1);
  const ic = si[key];
  if (!ic) throw new Error(`icon missing ${slug}`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160"><rect width="160" height="160" fill="#${ic.hex}"/>` +
    `<g transform="translate(44 44) scale(3)" fill="#fff"><path d="${ic.path}"/></g></svg>`;
  const file = `${slug}.svg`;
  fs.writeFileSync(path.join(artDir, file), svg);
  return { file: `assets/sound-art/${file}`, from: `Simple Icons: ${ic.title}` };
}

const out = {};
for (const [id, spec] of Object.entries(SOURCES)) {
  const [kind, value] = spec.split(':').map((s, i) => (i === 0 ? s : spec.slice(spec.indexOf(':') + 1)));
  try {
    if (kind === 'wiki') out[id] = await wiki(value);
    else if (kind === 'mal') { out[id] = await mal(value); await sleep(700); }
    else if (kind === 'icon') out[id] = icon(value);
    else if (kind === 'keep') out[id] = { keep: true };
    else out[id] = { none: true };
    console.log(id.padEnd(30), out[id].from || kind);
  } catch (e) {
    out[id] = { none: true, error: String(e.message || e) };
    console.log(id.padEnd(30), 'FAILED', e.message);
  }
  await sleep(120);
}
fs.writeFileSync(outJson, JSON.stringify(out, null, 2) + '\n');
console.log('wrote', outJson);
