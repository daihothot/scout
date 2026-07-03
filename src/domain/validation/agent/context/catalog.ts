import {
  context,
  createContextCatalog,
  type ContextCatalogRegistry,
  type DefinedContextCatalog,
} from "../../../../core/context/index.js";

const validationAgentContextCatalog = {
  input: {
    stateSnapshot: context<string>(),
    bddFact: context<string>(),
    evidence: context<string>(),
  },
} as const;

const validationAgentContextRegistry = createContextCatalog("validation");
validationAgentContextRegistry.add(validationAgentContextCatalog);

export type ValidationAgentContextCatalogShape = typeof validationAgentContextCatalog;
export const ValidationAgentContexts = validationAgentContextRegistry as ContextCatalogRegistry<"validation">
  & DefinedContextCatalog<ValidationAgentContextCatalogShape>;
