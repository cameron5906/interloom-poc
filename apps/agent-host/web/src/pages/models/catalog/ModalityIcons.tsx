/** Compact glyphs for a model's input modalities. Text is the baseline and is
 * shown only when it is the sole modality; image/video/audio always render. */

interface ModalityIconsProps {
  modalities: string[];
}

export function ModalityIcons({ modalities }: ModalityIconsProps) {
  const set = new Set(modalities.map((m) => m.toLowerCase()));
  const extras = ["image", "video", "audio"].filter((m) => set.has(m));

  if (extras.length === 0) {
    return (
      <span className="il-modalities" aria-label="text only">
        <span className="il-modality" title="Text">
          <TextGlyph />
        </span>
      </span>
    );
  }

  return (
    <span className="il-modalities" aria-label={`modalities: text, ${extras.join(", ")}`}>
      {extras.map((m) => (
        <span key={m} className="il-modality" title={cap(m)}>
          {m === "image" ? <ImageGlyph /> : m === "video" ? <VideoGlyph /> : <AudioGlyph />}
        </span>
      ))}
    </span>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function TextGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function ImageGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2.2" y="3.2" width="11.6" height="9.6" rx="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="5.6" cy="6.4" r="1.1" fill="currentColor" />
      <path d="m3.2 11.4 3-3 2.4 2.2 2.2-1.8 2 1.8" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function VideoGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.8" y="4" width="9" height="8" rx="1.4" stroke="currentColor" strokeWidth="1.3" />
      <path d="m11 7 3.2-2v6L11 9" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" fill="none" />
    </svg>
  );
}

function AudioGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M8 2v12M5 5v6M11 5v6M2.5 7v2M13.5 7v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
