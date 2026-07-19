# Eris — Design Notes for the Web Surfaces

One design language across every surface: the workspace web client, the Agent Host
portal, and the marketplace. Warm, tactile, mobile-first. Tokens live in
`packages/ui/src/tokens.css`; every surface consumes them — never hardcode a color.

**Mobile posture, per surface.** The workspace client is **mobile-first**: its
screens are designed at 390px before they are widened to desktop, and mobile and
desktop ship together in the same change. The Agent Host portal and marketplace
are **desktop-first with full mobile support**: every page stays usable at 390px.
Everywhere: the single breakpoint is **768px** (`<768px` = mobile), no horizontal
scroll, touch targets ≥44px, `env(safe-area-inset-*)` respected.

## Tokens

**Color — warm cream & ink**
- Page background: `#f6ede0` · rails/sidebars: `#f1e6d4` · cards: `#fff`
  (warm card `#fffdf9`) · active row: peach `#f6dfc8` · system capsules: `#f4ead9`
- Borders: `#e6d8c2` (strong) / `#eee1cd` (soft) / `#f2e8d8` (hairline) /
  `#e2d4bd` (inputs)
- Text (warm brown ink): `#37291a` primary / `#6b5b48` secondary / `#9a8a75` muted /
  `#b3a58f` faint / `#f3ece1` on-dark

**Accent — rust**
- `#c0662b`, hover `#a85420`, tint `#f8e5d0`, deep `#8a431a`,
  gradient `linear-gradient(135deg,#d98544,#c0662b)`
- Accent is the ONLY saturated call-to-action color: primary buttons, active nav,
  links, unread badges, live/syncing states.

**Agents are sage green; humans are warm peach**
- Agent family: `#5d7a4e` / tint `#e7f0dc` / deep `#42582f` — AGENT badges, agent
  avatars (rounded-square), agent message bubbles (`#f2f8ea` fill, `#dfebd0` border)
- Human avatars: circles with pastel fills (default peach `#f2be93`) + initials

**Status**
- Success `#4e8a5a` / `#38663f` / tint `#e4efdd` · Warning `#cf8a2e` / `#a86e20` /
  tint `#f9ecd2` · Danger `#c14e3d` / `#9c3a2b` / tint `#f8e3dc`
- Presence: online `#4e8a5a` · away `#cf8a2e` · offline `#b3a58f`

**Type — Figtree**
- UI + body + display: Figtree (400/500/600/700/800). Data, IDs, timestamps,
  logs, badges: Geist Mono.
- Display headings ("Chats", "Members", page titles): Figtree **800**,
  letter-spacing `-0.03em`, sized generously (24–28px mobile page titles).
- Scale: 11px meta · 12.5–13.5px body · 14–15px titles. Message text 13.5px.

**Shape & depth — big radii, soft warm shadows**
- Radii: 10px inputs/small · 16px cards · 22px feature cards/sheets · 999px pills.
- Shadows: card `0 1px 2px rgba(66,45,15,.04)` · hover `0 4px 14px rgba(66,45,15,.08)`
  · floating elements (bottom bar) `0 10px 30px rgba(66,45,15,.16)`.
- Depth from tinted fills + borders first; shadow only for floating chrome.

## Layout

**Desktop (≥768px) — Slack pane model (unchanged behavior)**
1. Left sidebar (264px, `#f1e6d4`): nav, CHANNELS, DIRECT MESSAGES, user footer.
   Active row = peach `#f6dfc8` fill with rust text.
2. Center pane = current location (channel or DM, full width), 56px header,
   ~820px message column, composer at bottom.
3. Right detail pane (~376px, white, border-left), persists across location
   switches until closed.

**Mobile (<768px) — list-then-detail + bottom tab bar**
- Primary sections are tabs on a floating bottom pill bar (`MobileTabBar` in
  `packages/ui`): white pill, centered, safe-area aware. Active tab is an
  accent-filled pill showing icon + label; inactive tabs are icon-only. The label
  reveal and pill fill are ANIMATED (320ms `cubic-bezier(.3,.7,.25,1)` width/opacity
  slide; honors `prefers-reduced-motion`). Keep this buttery — it is the signature
  interaction of the redesign.
- Lists (chats, members, models…) are full-screen pages with big display headings.
- Opening an item pushes a full-screen detail (back chevron in a compact header);
  the bottom bar hides inside conversation/detail views.
- Right-pane content becomes a full-screen sheet; modals become bottom sheets
  (full-width, rounded top corners).

## Component patterns

- **AGENT badge:** Geist Mono 8–9px uppercase, `#42582f` on `#e7f0dc`, 4px radius.
- **Approval card ("needs your OK"):** white card, shield icon + mono kicker,
  plain-language summary, rust primary "Approve" + ghost "Not now". Always the
  same shape in chat and in the portal.
- **Run/status pills:** Geist Mono 10px in tinted capsules; pulsing dot when live.
- **System/event rows:** `#f4ead9` capsules with a dark mono icon chip.
- **Telemetry (host portal):** dark log panels (`#37291a` bg, `#f3ece1` mono text),
  stat tiles with 700-weight numbers; tiles wrap 2-up on mobile.
- Tables and wide code/log blocks always sit in their own `overflow-x:auto` wrapper.
- **Models marketplace (host portal):** the rig comes first — a stat-tile "rig strip"
  (GPU/VRAM, RAM, active model + loaded ctx) anchors the page so every fit badge reads
  against it. Curated catalog cards lead; Hugging Face search is a secondary tab.
  Fit language is honest and warm: "Fits fully on your GPU" / "Runs with system-RAM
  assist (slower)" / "CPU-friendly" / "Not practical on this rig" — never a bare boolean.
  Capability chips: solid for native levels, dashed for runtime-sensitive/prompted
  (mirrors the estimated-capability convention). GGUF source trust badges use Geist Mono
  (OFFICIAL / VERIFIED / COMMUNITY / DISCOVERY). Context is always presented as two
  numbers — the advertised ceiling and the honest local starting point — never one.
- **Model detail sheet (workspace):** same sections, display-only (no fit math off the
  operator's box); reachable from any model chip; RightPane pattern (desktop side panel,
  mobile full-screen sheet).

## Interaction defaults

- Hovers: tint shifts (`#f6dfc8` rows, border `#d9c5a6` on cards) — no inversions.
- Buttons: primary = rust fill white text; secondary = white + `#e2d4bd` border.
- Links `#c0662b` → `#a85420`, no underline.
- Focus: visible 2px accent outline for keyboard nav.
- Motion: 150–200ms color/opacity, 300–350ms layout/reveal, one easing family
  (`cubic-bezier(.3,.7,.25,1)`); never animate on `prefers-reduced-motion`.

## PWA

Both the workspace client and the Agent Host portal are installable PWAs
(`vite-plugin-pwa`): standalone display, theme/background `#f6ede0`, 192/512 +
maskable icons, apple-touch-icon. Service workers never intercept `/api`, `/ws`,
or runtime config scripts.
