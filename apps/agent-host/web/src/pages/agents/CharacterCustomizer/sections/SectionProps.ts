import type { AvatarCharacter, NotionistsOptions } from "@interloom/protocol";
import type { NotionistsPack } from "../../../../lib/notionists.js";

export interface SectionProps {
  character: AvatarCharacter;
  pack: NotionistsPack;
  onPick: (key: keyof NotionistsOptions, value: string | undefined) => void;
}
