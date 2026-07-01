/**
 * Visual template identity + metadata.
 *
 * A "template" is a fully distinct 3D audio-reactive look. They all share the
 * same renderer, canvas, camera, animation loop and audio pipeline (see
 * Visualizer.tsx), but each supplies its own scene contents (points, instanced
 * meshes, line segments or wireframe groups), movement and per-band reactions.
 */
export type VisualTemplateId =
  | "particle-field"
  | "orbital-swarm"
  | "pulse-tunnel"
  | "cube-swarm"
  | "polyhedron-storm"
  | "laser-lattice"
  | "wireframe-bloom";

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
  {
    id:          "cube-swarm",
    name:        "Cube Swarm",
    description: "Thousands of reactive cubes drifting and tumbling through space.",
  },
  {
    id:          "polyhedron-storm",
    name:        "Polyhedron Storm",
    description: "Angular geometric forms moving through turbulent 3D currents.",
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
] as const;

export const DEFAULT_TEMPLATE_ID: VisualTemplateId = "particle-field";

export function getTemplateMeta(id: VisualTemplateId): VisualTemplateMeta {
  return VISUAL_TEMPLATES.find(t => t.id === id) ?? VISUAL_TEMPLATES[0];
}
