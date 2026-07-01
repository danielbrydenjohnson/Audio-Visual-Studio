/**
 * Visual template identity + metadata.
 *
 * A "template" is a fully distinct 3D audio-reactive look. They all share the
 * same renderer, camera, animation loop and audio pipeline (see Visualizer.tsx),
 * but each supplies its own particle initialization, BufferGeometry attributes,
 * shader behaviour, movement and per-band reactions.
 */
export type VisualTemplateId = "particle-field" | "orbital-swarm" | "pulse-tunnel";

export interface VisualTemplateMeta {
  id:          VisualTemplateId;
  name:        string;
  description: string;
}

/** Central template metadata — the single source of truth for the selector. */
export const VISUAL_TEMPLATES: readonly VisualTemplateMeta[] = [
  {
    id:          "particle-field",
    name:        "Particle Field",
    description: "Free-floating particles moving through open 3D space.",
  },
  {
    id:          "orbital-swarm",
    name:        "Orbital Swarm",
    description: "Independent particle clusters orbiting moving attractors.",
  },
  {
    id:          "pulse-tunnel",
    name:        "Pulse Tunnel",
    description: "A deep reactive particle tunnel moving toward the camera.",
  },
] as const;

export const DEFAULT_TEMPLATE_ID: VisualTemplateId = "particle-field";

export function getTemplateMeta(id: VisualTemplateId): VisualTemplateMeta {
  return VISUAL_TEMPLATES.find(t => t.id === id) ?? VISUAL_TEMPLATES[0];
}
