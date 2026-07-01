import type { VisualTemplate } from "@/visuals/shared";
import type { VisualTemplateId } from "@/visuals/types";
import { particleFieldTemplate } from "@/visuals/templates/particleField";
import { orbitalSwarmTemplate } from "@/visuals/templates/orbitalSwarm";
import { pulseTunnelTemplate } from "@/visuals/templates/pulseTunnel";
import { cubeSwarmTemplate } from "@/visuals/templates/cubeSwarm";
import { polyhedronStormTemplate } from "@/visuals/templates/polyhedronStorm";
import { laserLatticeTemplate } from "@/visuals/templates/laserLattice";
import { wireframeBloomTemplate } from "@/visuals/templates/wireframeBloom";

/** Registry mapping each template id to its implementation. */
const REGISTRY: Record<VisualTemplateId, VisualTemplate> = {
  "particle-field":   particleFieldTemplate,
  "orbital-swarm":    orbitalSwarmTemplate,
  "pulse-tunnel":     pulseTunnelTemplate,
  "cube-swarm":       cubeSwarmTemplate,
  "polyhedron-storm": polyhedronStormTemplate,
  "laser-lattice":    laserLatticeTemplate,
  "wireframe-bloom":  wireframeBloomTemplate,
};

export function getTemplate(id: VisualTemplateId): VisualTemplate {
  return REGISTRY[id] ?? particleFieldTemplate;
}
