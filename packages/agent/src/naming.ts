/**
 * Pure, Node-safe derivations from an agent's export name to the identifiers its
 * generated workflow uses. Like `@velajs/workflow`'s naming helpers, these are
 * plain string functions with no runtime imports, so codegen and the config layer
 * reproduce the exact names the runtime resolves — one derivation, shared
 * everywhere. `support` → `SupportAgentWorkflow` / `AGENT_SUPPORT` / `agent-support`.
 */

/** Split a camelCase export name at each lower/digit → upper boundary (zero-width). */
const camelSegments = (exportName: string): string[] => exportName.split(/(?<=[a-z0-9])(?=[A-Z])/);

/**
 * The generated workflow class name for an agent export: `support` →
 * `SupportAgentWorkflow`, `customerSupport` → `CustomerSupportAgentWorkflow`. Only
 * the first character is upcased; the camelCase interior is preserved.
 */
export const agentClassName = (exportName: string): string => {
  const pascal = exportName.replace(/^[a-z]/, (head) => head.toUpperCase());
  return `${pascal}AgentWorkflow`;
};

/**
 * The workflow binding name for an agent export: `support` → `AGENT_SUPPORT`,
 * `customerSupport` → `AGENT_CUSTOMER_SUPPORT`. `agentAsTool` looks the child
 * binding up under this name on `env`.
 */
export const agentBindingName = (exportName: string): string => {
  const screamingSnake = camelSegments(exportName)
    .map((segment) => segment.toUpperCase())
    .join('_');
  return `AGENT_${screamingSnake}`;
};

/**
 * The stable deployed workflow name for an agent export: `support` →
 * `agent-support`, `customerSupport` → `agent-customer-support`. Used as the
 * `defineWorkflow` name whenever the agent sets no explicit `name`.
 */
export const agentDefaultName = (exportName: string): string =>
  `agent-${camelSegments(exportName)
    .map((segment) => segment.toLowerCase())
    .join('-')}`;
