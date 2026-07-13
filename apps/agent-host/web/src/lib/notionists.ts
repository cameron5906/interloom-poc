/**
 * DiceBear Notionists gender packs, background palette, and roll
 * probabilities — CONTRACTS §12 is the single source of truth for every
 * table below. Variant ids are DiceBear names (`variantXX`, plus `hat` for
 * hair and `electric|saturn|galaxy` for bodyIcon).
 */
import type { AgentGender } from "@interloom/protocol";

function v(n: number): string {
  return `variant${String(n).padStart(2, "0")}`;
}

function range(from: number, to: number): string[] {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(v(i));
  return out;
}

// ---- Beard ----
const MALE_BEARD = range(1, 12);

// ---- Hair ----
const FEMALE_HAIR = [8, 10, 14, 23, 26, 28, 30, 32, 36, 37, 39, 40, 41, 43, 45, 46, 47, 48, 51, 52, 57, 58, 59, 62, 63].map(v);
const MALE_HAIR = [
  ...range(1, 7),
  v(9),
  ...range(11, 13),
  ...range(15, 22),
  v(24),
  v(25),
  v(27),
  v(29),
  v(31),
  ...range(33, 35),
  v(38),
  v(49),
  v(50),
  ...range(53, 56),
  v(60),
  v(61),
];
const UNISEX_HAIR = ["hat"];

// ---- Clothes (body) ----
const FEMALE_BODY = [12, 13, 15, 16, 17, 18, 21, 24].map(v);
const MALE_BODY = [5, 6, 10, 14, 19, 20, 25].map(v);
const UNISEX_BODY = [...range(1, 4), ...range(7, 9), v(11), v(22), v(23)];

// ---- Clothes graphic (bodyIcon) ----
const UNISEX_BODY_ICON = ["electric", "saturn", "galaxy"];

// ---- Eyebrows ----
const FEMALE_BROWS = [6, 7, 10].map(v);
const MALE_BROWS = [1, 2, 3, 5, 11].map(v);
const UNISEX_BROWS = [4, 8, 9, 12, 13].map(v);

// ---- Eyes ----
const UNISEX_EYES = range(1, 5);

// ---- Gesture ----
const UNISEX_GESTURE = [
  "hand",
  "handPhone",
  "ok",
  "okLongArm",
  "point",
  "pointLongArm",
  "waveLongArm",
  "waveLongArms",
  "waveOkLongArms",
  "wavePointLongArms",
];

// ---- Glasses ----
const FEMALE_GLASSES = [10, 11].map(v);
const MALE_GLASSES = [1, 3, 6, 7, 9].map(v);
const UNISEX_GLASSES = [2, 4, 5, 8].map(v);

// ---- Mouth (lips) ----
const UNISEX_LIPS = range(1, 30);

// ---- Nose ----
const UNISEX_NOSE = range(1, 20);

/** Background swatches for character avatars (CONTRACTS §12). Hex, no '#'. */
export const BACKGROUND_PALETTE = [
  "b6e3f4",
  "c0aede",
  "d1d4f9",
  "ffd5dc",
  "ffdfbf",
  "e0f2e9",
  "f4e1b6",
  "d9e8ff",
  "ecebff",
  "ffe8e0",
  "e6f4d5",
  "f0f0f0",
] as const;

/** Initial-roll probabilities (CONTRACTS §12). */
export const BEARD_PROBABILITY: Record<AgentGender, number> = { male: 40, female: 0, other: 25 };
export const GLASSES_PROBABILITY = 25;
export const GESTURE_PROBABILITY = 15;
export const BODY_ICON_PROBABILITY = 25;

export interface NotionistsPack {
  hair: string[];
  beard: string[];
  body: string[];
  bodyIcon: string[];
  brows: string[];
  eyes: string[];
  gesture: string[];
  glasses: string[];
  lips: string[];
  nose: string[];
}

/** The allowed variant lists for a gender — female/male = own + unisex; other = union of everything. */
export function packFor(gender: AgentGender): NotionistsPack {
  if (gender === "female") {
    return {
      hair: [...FEMALE_HAIR, ...UNISEX_HAIR],
      beard: [],
      body: [...FEMALE_BODY, ...UNISEX_BODY],
      bodyIcon: [...UNISEX_BODY_ICON],
      brows: [...FEMALE_BROWS, ...UNISEX_BROWS],
      eyes: [...UNISEX_EYES],
      gesture: [...UNISEX_GESTURE],
      glasses: [...FEMALE_GLASSES, ...UNISEX_GLASSES],
      lips: [...UNISEX_LIPS],
      nose: [...UNISEX_NOSE],
    };
  }
  if (gender === "male") {
    return {
      hair: [...MALE_HAIR, ...UNISEX_HAIR],
      beard: [...MALE_BEARD],
      body: [...MALE_BODY, ...UNISEX_BODY],
      bodyIcon: [...UNISEX_BODY_ICON],
      brows: [...MALE_BROWS, ...UNISEX_BROWS],
      eyes: [...UNISEX_EYES],
      gesture: [...UNISEX_GESTURE],
      glasses: [...MALE_GLASSES, ...UNISEX_GLASSES],
      lips: [...UNISEX_LIPS],
      nose: [...UNISEX_NOSE],
    };
  }
  // "other" — union of everything
  return {
    hair: [...FEMALE_HAIR, ...MALE_HAIR, ...UNISEX_HAIR],
    beard: [...MALE_BEARD],
    body: [...FEMALE_BODY, ...MALE_BODY, ...UNISEX_BODY],
    bodyIcon: [...UNISEX_BODY_ICON],
    brows: [...FEMALE_BROWS, ...MALE_BROWS, ...UNISEX_BROWS],
    eyes: [...UNISEX_EYES],
    gesture: [...UNISEX_GESTURE],
    glasses: [...FEMALE_GLASSES, ...MALE_GLASSES, ...UNISEX_GLASSES],
    lips: [...UNISEX_LIPS],
    nose: [...UNISEX_NOSE],
  };
}
