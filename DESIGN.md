# Video Combinator — Design Direction

## Product Identity
- **Product Name:** Video Combinator
- **Product Type:** Local Desktop & High-Speed Batch Video Generation Engine
- **Target Audience:** Digital Marketers, Video Editors, and Performance Media Buyers generating bulk portrait (9:16) video variations (Hook + Body + CTA)
- **Mood / Character:** Studio Workstation (Video Lab) — Professional, focused, high-precision engineering tool with tactile feedback and zero fluff.

## Dials
- **ENERGY:** 2 (Focused, responsive, clean studio interface)
- **RHYTHM:** 2 (Clear visual hierarchy: Top Command Bar -> Telemetry & Action Strip -> 3-Stage Pipeline Columns -> Feedback / Modal layers)
- **MOTION:** 1 (Subtle functional micro-transitions ≤ 150ms, strictly disables with `prefers-reduced-motion: reduce`)

## Color Palette (WCAG AA Compliant)
- **Base Background:** `#0e0f12` (Deep Charcoal Studio Canvas)
- **Surface / Card Background:** `#16171c` (Elevated Panel)
- **Surface Hover / Active:** `#1e2026`
- **Border Neutral:** `#2a2b33` (Subtle boundary)
- **Border Highlight / Focus:** `#f59e0b` (Studio Amber focus ring, 2px solid with 2px offset)
- **Text Primary:** `#f3f4f6` (Contrast ratio > 12:1 against dark surface)
- **Text Secondary / Muted:** `#9ca3af` (Contrast ratio > 5.5:1 against surface, exceeds 4.5:1 WCAG AA)
- **Brand Accent:** `#f59e0b` (Studio Amber)
- **Status Success (Ready / Done):** `#10b981` (Emerald)
- **Status Warning (Queued / Normalizing):** `#f59e0b` (Amber)
- **Status Danger (Error / Stop):** `#ef4444` (Coral Red)

## Typography & Micro-affordances
- **Typeface:** System Sans (`system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`)
- **Metrics & Numbers:** Tabular figures (`font-variant-numeric: tabular-nums`) for alignment of frame counts, durations, and percentages.
- **Aspect Ratio:** Explicit `aspect-ratio: 9 / 16` for video thumbnails to prevent Cumulative Layout Shift (CLS).
- **Interactive Targets:** Minimum 44×44px tap targets for mobile/touch accessibility.
- **Copywriting:** No em dash (`—`) characters; clear, human, direct Indonesian terminology.
