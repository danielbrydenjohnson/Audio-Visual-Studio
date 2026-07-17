import type { VisualTemplate } from "@/visuals/shared";
import type { VisualTemplateId } from "@/visuals/types";
import { cubeSwarmTemplate }           from "@/visuals/templates/cubeSwarm";
import { laserLatticeTemplate }        from "@/visuals/templates/laserLattice";
import { wireframeBloomTemplate }      from "@/visuals/templates/wireframeBloom";
import { fibonacciSpiralTemplate }     from "@/visuals/templates/fibonacciSpiral";
import { sacredGeometryBloomTemplate } from "@/visuals/templates/sacredGeometryBloom";
import { reactiveEyeTemplate }         from "@/visuals/templates/reactiveEye";

/** Registry mapping each template id to its implementation. */
const REGISTRY: Record<VisualTemplateId, VisualTemplate> = {
  "cube-swarm":            cubeSwarmTemplate,
  "laser-lattice":         laserLatticeTemplate,
  "wireframe-bloom":       wireframeBloomTemplate,
  "fibonacci-spiral":      fibonacciSpiralTemplate,
  "sacred-geometry-bloom": sacredGeometryBloomTemplate,
  "reactive-eye":          reactiveEyeTemplate,
};

export function getTemplate(id: VisualTemplateId): VisualTemplate {
  return REGISTRY[id] ?? cubeSwarmTemplate;
}
