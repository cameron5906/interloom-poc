import { useState } from "react";
import { Button } from "@interloom/ui";
import type { AvatarCharacter, NotionistsOptions } from "@interloom/protocol";
import { packFor } from "../../../lib/notionists.js";
import { rollCharacter, characterDataUri, withOption, withBackground } from "../../../lib/character.js";
import { HairSection } from "./sections/HairSection.js";
import { FaceSection } from "./sections/FaceSection.js";
import { StyleSection } from "./sections/StyleSection.js";
import { ClothesSection } from "./sections/ClothesSection.js";
import { BackgroundSection } from "./sections/BackgroundSection.js";
import "./characterCustomizer.css";

const SECTIONS = ["Hair", "Face", "Style", "Clothes", "Background"] as const;
type SectionName = (typeof SECTIONS)[number];

interface CharacterCustomizerProps {
  character: AvatarCharacter;
  /** Called with the next character and whether it now counts as user-overridden (CONTRACTS §12). */
  onChange: (character: AvatarCharacter, overridden: boolean) => void;
}

/**
 * Paced character customizer (CONTRACTS §12): a live preview + shuffle over
 * sectioned pickers (not one giant grid). Gender lives in the editor as a
 * first-class identity control — a character always exists by the time this
 * opens. Every change is emitted immediately via `onChange`; the parent
 * (AgentEditor) owns whether the roll stays reactive to name changes.
 */
export function CharacterCustomizer({ character, onChange }: CharacterCustomizerProps) {
  const [activeSection, setActiveSection] = useState<SectionName>("Hair");

  const handleShuffle = () => {
    onChange(rollCharacter(character.seed, character.gender, crypto.randomUUID()), false);
  };

  const handlePick = (key: keyof NotionistsOptions, value: string | undefined) => {
    onChange(withOption(character, key, value), true);
  };

  const handleBackground = (hex: string) => {
    onChange(withBackground(character, hex), true);
  };

  return (
    <div className="il-charcust">
      <div className="il-charcust__preview-row">
        <img
          className="il-charcust__preview"
          src={characterDataUri(character, 256)}
          alt="Character preview"
          width={200}
          height={200}
        />
        <Button variant="secondary" size="sm" onClick={handleShuffle}>
          🎲 Shuffle
        </Button>
      </div>

      <div className="il-tabs il-charcust__tabs" role="tablist" aria-label="Character sections">
        {SECTIONS.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={activeSection === s}
            className={`il-tab${activeSection === s ? " il-tab--active" : ""}`}
            onClick={() => setActiveSection(s)}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="il-charcust__section" role="tabpanel">
        {activeSection === "Hair" ? (
          <HairSection character={character} pack={packFor(character.gender)} onPick={handlePick} />
        ) : activeSection === "Face" ? (
          <FaceSection character={character} pack={packFor(character.gender)} onPick={handlePick} />
        ) : activeSection === "Style" ? (
          <StyleSection character={character} pack={packFor(character.gender)} onPick={handlePick} />
        ) : activeSection === "Clothes" ? (
          <ClothesSection character={character} pack={packFor(character.gender)} onPick={handlePick} />
        ) : (
          <BackgroundSection character={character} onPick={handleBackground} />
        )}
      </div>
    </div>
  );
}
