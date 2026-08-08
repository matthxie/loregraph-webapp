/**
 * Gate for developer-only UI (the per-card inspection panel, the episode graph preview).
 *
 * On web there is no packaged build to opt in, so this is just the dev server. Keep features
 * gated on `DEV_TOOLS && …` so a stray persisted flag can't surface dev UI in production.
 */
import type { AppSettingsData } from "../shared/api";

export const DEV_TOOLS: boolean = import.meta.env.DEV;

/** The dev panel under each board card: extracted entities, concepts, and its subgraph. */
export function cardDevViews(settings: Pick<AppSettingsData, "devCardView"> | null): boolean {
  return DEV_TOOLS && Boolean(settings?.devCardView);
}
