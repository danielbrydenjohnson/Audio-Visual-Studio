import type { VisualTemplate } from "@/visuals/shared";
import type { VisualTemplateId } from "@/visuals/types";
import { cubeSwarmTemplate } from "@/visuals/templates/cubeSwarm";
import { polyhedronStormTemplate } from "@/visuals/templates/polyhedronStorm";
import { laserLatticeTemplate } from "@/visuals/templates/laserLattice";
import { wireframeBloomTemplate } from "@/visuals/templates/wireframeBloom";
import { fibonacciSpiralTemplate } from "@/visuals/templates/fibonacciSpiral";
import { sacredGeometryBloomTemplate } from "@/visuals/templates/sacredGeometryBloom";
import { lissajousLatticeTemplate } from "@/visuals/templates/lissajousLattice";

/** Registry mapping each template id to its implementation. */
const REGISTRY: Record<VisualTemplateId, VisualTemplate> = {
  "cube-swarm":            cubeSwarmTemplate,
  "polyhedron-storm":      polyhedronStormTemplate,
  "laser-lattice":         laserLatticeTemplate,
  "wireframe-bloom":       wireframeBloomTemplate,
  "fibonacci-spiral":      fibonacciSpiralTemplate,
  "sacred-geometry-bloom": sacredGeometryBloomTemplate,
  "lissajous-lattice":     lissajousLatticeTemplate,
};

export function getTemplate(id: VisualTemplateId): VisualTemplate {
  return REGISTRY[id] ?? cubeSwarmTemplate;
}
