import { HodProService } from "./hodpro-service.mjs";

function publicTool(tool) {
  return {
    id: tool.id,
    name: tool.name,
    category: tool.category,
    hostname: tool.hostname,
    iconUrl: tool.iconUrl,
    isActive: tool.isActive,
    inMaintenance: tool.inMaintenance,
    canOpen: tool.canOpen
  };
}

/**
 * Mantém a autorização do gateway como fonte de verdade (`visible_tool_ids`),
 * mas não usa `is_hidden` como uma segunda barreira local. Assim, ferramentas
 * de catálogo ocultas que já foram explicitamente liberadas pelo backend
 * também aparecem no painel e podem ser abertas.
 */
export class RichToolsService extends HodProService {
  async listTools() {
    const result = await super.listTools();
    const authorizedTools = [...this.tools.values()];
    const hiddenAuthorizedCount = authorizedTools.filter((tool) => tool.isHidden).length;

    for (const tool of authorizedTools) {
      tool.isHidden = false;
      tool.canOpen = Boolean(
        (tool.baseUrl || tool.loginUrl) &&
        tool.isActive &&
        !tool.inMaintenance &&
        !this.currentAccessState.blocked
      );
    }

    return {
      ...result,
      tools: authorizedTools.map(publicTool),
      authorizedToolCount: authorizedTools.length,
      hiddenAuthorizedCount
    };
  }

  async requireTool(toolId, options = {}) {
    if (options?.fresh === true || !this.tools.has(String(toolId))) {
      await this.listTools();
    }
    return super.requireTool(toolId, { fresh: false });
  }
}
