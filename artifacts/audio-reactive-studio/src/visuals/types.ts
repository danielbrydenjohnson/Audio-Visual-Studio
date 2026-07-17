/**
 * Visual template identity + metadata.
 *
 * A "template" is a fully distinct 3D audio-reactive look. They all share the
 * same renderer, canvas, camera, animation loop and audio pipeline (see
 * Visualizer.tsx), but each supplies its own scene contents (instanced meshes,
 * line segments, points or wireframe groups), movement and per-band reactions.
 */
export type VisualTemplateId =
  | "cube-swarm"
  | "laser-lattice"
  | "wireframe-bloom"
  | "fibonacci-spiral"
  | "sacred-geometry-bloom";

export interface VisualTemplateMeta {
  id:          VisualTemplateId;
  name:        string;
  description: string;
}

/** Central template metadata — the single source of truth for the selector. */
export const VISUAL_TEMPLATES: readonly VisualTemplateMeta[] = [
  {
    id:          "cube-swarm",
    name:        "Cube Swarm",
    description: "Reactive cubes drifting and tumbling through space.",
  },
  {
    id:          "laser-lattice",
    name:        "Laser Lattice",
    description: "Reactive line structures cutting through a deep spatial grid.",
  },
  {
    id:          "wireframe-bloom",
    name:        "Wireframe Bloom",
    description: "Layered wireframe geometry unfolding and pulsing through space.",
  },
  {
    id:          "fibonacci-spiral",
    name:        "Fibonacci Spiral",
    description: "A golden-angle spiral of reactive geometric elements.",
  },
  {
    id:          "sacred-geometry-bloom",
    name:        "Sacred Geometry Bloom",
    description: "Layered radial geometry built from circles, polygons, and luminous intersections.",
  },
] as const;

export const DEFAULT_TEMPLATE_ID: VisualTemplateId = "cube-swarm";

export function getTemplateMeta(id: VisualTemplateId): VisualTemplateMeta {
  return VISUAL_TEMPLATES.find(t => t.id === id) ?? VISUAL_TEMPLATES[0];
}
