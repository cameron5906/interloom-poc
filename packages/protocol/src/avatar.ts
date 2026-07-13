import { z } from "zod";

/**
 * Gender pick driving the DiceBear Notionists gender pack (CONTRACTS §12).
 * "other" unlocks every variant across both packs. Reused wherever an agent's
 * gender rides the wire (manifest, marketplace listing, member, host agent).
 */
export const AgentGender = z.enum(["male", "female", "other"]);
export type AgentGender = z.infer<typeof AgentGender>;

/**
 * DiceBear Notionists component picks (CONTRACTS §12). Values are DiceBear
 * variant names (`variantXX`, plus `hat` for hair and
 * `electric|saturn|galaxy` for bodyIcon). Variant-name validity against the
 * gender packs is a UI concern, not enforced on the wire. An absent optional
 * means the piece is omitted (probability 0).
 */
export const NotionistsOptions = z.object({
  hair: z.string().optional(),
  beard: z.string().optional(),
  brows: z.string(),
  eyes: z.string(),
  lips: z.string(),
  nose: z.string(),
  body: z.string(),
  bodyIcon: z.string().optional(),
  gesture: z.string().optional(),
  glasses: z.string().optional(),
});
export type NotionistsOptions = z.infer<typeof NotionistsOptions>;

/**
 * A fully-pinned DiceBear Notionists character (CONTRACTS §12). Rendered
 * entirely client-side in the host portal; the network only ever sees the
 * rasterized PNG upload (§4 Assets), never this structured form directly —
 * it travels host-side (drafts) and can be persisted alongside a `HostAgent`.
 */
export const AvatarCharacter = z.object({
  style: z.literal("notionists"),
  seed: z.string(),
  gender: AgentGender,
  /** Hex, no leading '#'. */
  backgroundColor: z.string(),
  options: NotionistsOptions,
});
export type AvatarCharacter = z.infer<typeof AvatarCharacter>;
