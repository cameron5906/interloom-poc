# Interloom — Design Notes for the PoC Web Surfaces

Source of truth: `design/Cohort.dc.html` (open in a browser and click around). Recreate the language, not the markup. Applies to the web client (D) and, softened, to the host portal (A) and marketplace (B).

## Tokens

**Color**
- Page background: `#fbfbf9` · sidebar/rails: `#f4f3ef` · cards: `#fff`
- Borders: `#e7e5dd` (strong) / `#eeece4` (soft) / `#f0eee6` (hairline)
- Text: `#1c1b18` (primary) / `#57554c` (secondary) / `#8f8c82` (muted) / `#a5a299` (faint)
- Accent (brand): `#6a5acd`, hover `#5a49bd`, tint `#efeafc`, gradient `linear-gradient(135deg,#8b76ee,#6a5acd)`
- Success: `#3f9e69` / deep `#2f6b47` / tint `#e7f2ea` · Warning: `#d69a2e` / `#b58a2e` / tint `#faf1dc`
- Danger: `#cf5b52` / deep `#b8443b` / tint `#faeae8` · Active/teal: `#3a9d95` / tint `#e5f2f0`

**Type**
- UI + body: Geist (400/500/600/700). Data, IDs, timestamps, badges: Geist Mono.
- Scale: 11px meta · 12.5–13.5px body · 14–15px titles · headers 600 weight. Message text 13.5px, sender names 600.

**Shape & depth**
- Radii: 7–8px buttons/inputs · 10–12px cards · 20px pills. Shadows minimal (`0 1px 2px rgba(0,0,0,.03)` card, `0 2px 8px rgba(0,0,0,.06)` hover). Depth comes from borders + tinted fills, not shadow.

## Layout — Slack pane model (required behavior)

1. **Left sidebar (264px, `#f4f3ef`):** workspace switcher, primary nav, CHANNELS section, DIRECT MESSAGES section, current-user footer. Active location gets `#eceae3` row highlight.
2. **Center pane = current location.** Channels AND DMs are locations selected from the sidebar (a DM opens in the center, full width — never a side rail). 56px header with title + members + actions; messages in a centered ~820px column; composer at bottom.
3. **Right detail pane (~376px, white, border-left):** contextual detail — thread, run timeline, agent profile. One at a time; **persists across location switches until explicitly closed** (Slack thread-pane behavior). Openers: thread indicators, run cards, agent names.

## Component patterns to reuse

- **AGENT badge:** Geist Mono 8–9px uppercase, `#6a5acd` on `#efeafc`, 4px radius — next to agent names everywhere.
- **Agent avatars are rounded-squares** (7–11px radius, gradient fills); **human avatars are circles** (soft pastel fills + initials). Presence dot bottom-right (green online / amber away).
- **Run card:** white card, header row (icon chip + title + status pill + step count), progress row of step labels joined by colored connector lines. Status pills: Geist Mono 10px in tinted capsules, pulsing dot when live.
- **Thread indicator:** ghost row under a message — stacked mini avatars, "N replies" in accent, last-activity time; hover reveals border.
- **System/event rows** (CI, GitHub, joins): `#f7f6f2` capsule rows with a dark mono icon chip — visually distinct from human/agent messages.
- **Typing indicator:** three bouncing dots in a `#f7f6f2` bubble.
- **Telemetry (host portal):** dark mono-font panels for logs (`#1c1b18` bg, `#e8e6df` text), stat tiles with 600-weight numbers + muted mono labels, thin progress bars in tinted tracks.

## Interaction defaults
- Hovers: background tint shifts (`#eceae3` on rails, border `#cfc9dd` on cards) — no color inversions.
- Buttons: primary = `#1c1b18` fill white text (hover `#333029`); secondary = white + `#e0ddd4` border; accent actions use `#6a5acd` sparingly.
- Links `#6a5acd` → `#5a49bd`, no underline.
- Focus: keep a visible 2px accent outline for keyboard nav.
