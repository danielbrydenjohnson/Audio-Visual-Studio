import type { VisualTemplate } from "@/visuals/shared";
import type { VisualTemplateId } from "@/visuals/types";
import { particleFieldTemplate } from "@/visuals/templates/particleField";
import { orbitalSwarmTemplate } from "@/visuals/templates/orbitalSwarm";
import { pulseTunnelTemplate } from "@/visuals/templates/pulseTunnel";

/** Registry mapping each template id to its implementation. */
const REGISTRY: Record<VisualTemplateId, VisualTemplate> = {
  "particle-field": particleFieldTemplate,
  "orbital-swarm":  orbitalSwarmTemplate,
  "pulse-tunnel":   pulseTunnelTemplate,
};

export function getTemplate(id: VisualTemplateId): VisualTemplate {
  return REGISTRY[id] ?? particleFieldTemplate;
}
