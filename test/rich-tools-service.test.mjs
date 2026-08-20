import test from "node:test";
import assert from "node:assert/strict";
import { RichToolsService } from "../src/rich-tools-service.mjs";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const VISIBLE_ID = "22222222-2222-4222-8222-222222222222";
const HIDDEN_ID = "33333333-3333-4333-8333-333333333333";

function makeTool(id, hidden) {
  return {
    id,
    name: hidden ? "Ferramenta oculta autorizada" : "Ferramenta visível",
    category: "Teste",
    base_url: `https://${id.slice(0, 8)}.example.test/`,
    login_url: `https://${id.slice(0, 8)}.example.test/login`,
    is_active: true,
    is_hidden: hidden,
    is_in_maintenance: false
  };
}

function harness() {
  const api = {
    async listTools() {
      return [makeTool(VISIBLE_ID, false), makeTool(HIDDEN_ID, true)];
    },
    async poll() {
      return {
        maintenance_tools: [],
        visible_tool_ids: [VISIBLE_ID, HIDDEN_ID]
      };
    }
  };
  const auth = {
    getStatus() {
      return { authenticated: true, user: { id: USER_ID, email: "usuario@example.test" } };
    },
    async withAccessToken(operation) {
      return operation("token-ficticio");
    }
  };
  const browserManager = {
    async close() {},
    async closeAccountContext() {}
  };

  return new RichToolsService({
    api,
    auth,
    browserManager,
    deviceId: "hwid-ficticio",
    appVersion: "1.0.0"
  });
}

test("inclui ferramenta de catálogo oculta quando o backend já autorizou seu id", async () => {
  const service = harness();
  const result = await service.listTools();

  assert.equal(result.tools.length, 2);
  assert.equal(result.authorizedToolCount, 2);
  assert.equal(result.hiddenAuthorizedCount, 1);
  assert.equal(result.tools.find((tool) => tool.id === HIDDEN_ID)?.canOpen, true);

  const hiddenTool = await service.requireTool(HIDDEN_ID);
  assert.equal(hiddenTool.id, HIDDEN_ID);
  assert.equal(hiddenTool.isHidden, false);
});
