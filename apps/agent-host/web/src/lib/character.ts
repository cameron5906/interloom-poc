/**
 * DiceBear Notionists character rolling + rendering (CONTRACTS §12). Rendered
 * ENTIRELY client-side — no server-side DiceBear anywhere. A small seeded PRNG
 * (xmur3 + mulberry32) drives the initial gendered roll so the same seed +
 * gender always produces the same character, without relying on DiceBear's
 * own internal PRNG (which we deliberately pin to single-value arrays instead).
 */
import { createAvatar } from "@dicebear/core";
import { notionists } from "@dicebear/collection";
import type { AgentGender, AvatarCharacter, NotionistsOptions } from "@interloom/protocol";
import {
  BACKGROUND_PALETTE,
  BEARD_PROBABILITY,
  BODY_ICON_PROBABILITY,
  GESTURE_PROBABILITY,
  GLASSES_PROBABILITY,
  packFor,
} from "./notionists.js";

const RENDER_SIZE = 512;

function xmur3(str: string): () => number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededRandom(seed: string): () => number {
  return mulberry32(xmur3(seed)());
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  const idx = Math.min(Math.floor(rng() * arr.length), arr.length - 1);
  return arr[idx] as T;
}

function chance(rng: () => number, probabilityPct: number): boolean {
  return rng() * 100 < probabilityPct;
}

/**
 * Rolls a fully-pinned character for `seed` + `gender`. Same seed + gender +
 * salt always produces the same result; `salt` is the escape hatch the
 * "Shuffle" action uses to get a different roll within the same pack without
 * changing the agent's name.
 */
export function rollCharacter(seed: string, gender: AgentGender, salt = ""): AvatarCharacter {
  const rng = seededRandom(`${seed}::${gender}::${salt}`);
  const pack = packFor(gender);

  const options: NotionistsOptions = {
    hair: pick(rng, pack.hair),
    brows: pick(rng, pack.brows),
    eyes: pick(rng, pack.eyes),
    lips: pick(rng, pack.lips),
    nose: pick(rng, pack.nose),
    body: pick(rng, pack.body),
  };

  if (pack.beard.length > 0 && chance(rng, BEARD_PROBABILITY[gender])) {
    options.beard = pick(rng, pack.beard);
  }
  if (chance(rng, GLASSES_PROBABILITY)) {
    options.glasses = pick(rng, pack.glasses);
  }
  if (chance(rng, GESTURE_PROBABILITY)) {
    options.gesture = pick(rng, pack.gesture);
  }
  if (chance(rng, BODY_ICON_PROBABILITY)) {
    options.bodyIcon = pick(rng, pack.bodyIcon);
  }

  const backgroundColor = pick(rng, BACKGROUND_PALETTE);

  return { style: "notionists", seed, gender, backgroundColor, options };
}

/** Replaces a single component's value (or clears it for optional pieces). */
export function withOption(
  character: AvatarCharacter,
  key: keyof NotionistsOptions,
  value: string | undefined,
): AvatarCharacter {
  const options = { ...character.options };
  if (value === undefined) {
    delete options[key];
  } else {
    options[key] = value;
  }
  return { ...character, options };
}

export function withBackground(character: AvatarCharacter, backgroundColor: string): AvatarCharacter {
  return { ...character, backgroundColor };
}

export function withGender(character: AvatarCharacter, gender: AgentGender): AvatarCharacter {
  return { ...character, gender };
}

/**
 * Renders the character to an SVG string. Every DiceBear option is pinned to
 * a single-value array (plus probability 100/0 for optional pieces) so the
 * result matches `character` exactly — DiceBear's own internal PRNG never
 * gets a real choice to make.
 *
 * `@dicebear/notionists` isn't a direct dependency (only `@dicebear/core` and
 * `@dicebear/collection` are) so its `Options` type isn't resolvable from
 * here; the object shape below is validated against CONTRACTS §12 above.
 */
export function svgFor(character: AvatarCharacter, size = RENDER_SIZE): string {
  const { options } = character;
  const dicebearOptions = {
    seed: character.seed,
    size,
    backgroundColor: [character.backgroundColor],
    base: ["variant01"],
    brows: [options.brows],
    eyes: [options.eyes],
    lips: [options.lips],
    nose: [options.nose],
    body: [options.body],
    hair: options.hair ? [options.hair] : [],
    beard: options.beard ? [options.beard] : [],
    beardProbability: options.beard ? 100 : 0,
    glasses: options.glasses ? [options.glasses] : [],
    glassesProbability: options.glasses ? 100 : 0,
    gesture: options.gesture ? [options.gesture] : [],
    gestureProbability: options.gesture ? 100 : 0,
    bodyIcon: options.bodyIcon ? [options.bodyIcon] : [],
    bodyIconProbability: options.bodyIcon ? 100 : 0,
  };
  return createAvatar(notionists, dicebearOptions as Parameters<typeof createAvatar>[1]).toString();
}

/** A `data:image/svg+xml` URI for instant, client-side avatar previews. */
export function characterDataUri(character: AvatarCharacter, size = RENDER_SIZE): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svgFor(character, size))}`;
}

/** Rasterizes an SVG string to a square PNG data URL via an offscreen canvas. */
export function renderPng(svg: string, size = RENDER_SIZE): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("canvas unavailable"));
        return;
      }
      ctx.drawImage(img, 0, 0, size, size);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => reject(new Error("could not rasterize character"));
    img.src = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  });
}

/** The best available avatar image for live preview: character > uploaded imageUrl. */
export function draftAvatarImageUrl(avatar: {
  character?: AvatarCharacter;
  imageUrl?: string;
}): string | undefined {
  if (avatar.character) return characterDataUri(avatar.character);
  return avatar.imageUrl;
}

/**
 * True when the draft's character hasn't been rendered/uploaded yet — either
 * it was never uploaded, or it has changed since the last upload. Shared by
 * the upload trigger and the signature-impact check (CONTRACTS §6): a
 * pending re-upload is about to change `avatar.imageUrl` even though the new
 * URL isn't known until the upload completes.
 */
export function avatarUploadPending(
  avatar: { character?: AvatarCharacter; imageUrl?: string },
  lastUploaded?: AvatarCharacter,
): boolean {
  if (!avatar.character) return false;
  return JSON.stringify(avatar.character) !== JSON.stringify(lastUploaded) || !avatar.imageUrl;
}
