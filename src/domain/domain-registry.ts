import {
  isScoutDomainId,
  type ScoutDomain,
  type ScoutDomainId,
} from "./types.js";

/** Holds every Scout Domain installed in one Run, in registration order. */
export class DomainRegistry {
  private readonly domains = new Map<ScoutDomainId, ScoutDomain>();

  register<TDomain extends ScoutDomain>(domain: TDomain): TDomain {
    const description = domain.description;
    if (
      !description
      || !isScoutDomainId(description.id)
      || typeof description.name !== "string"
      || description.name.trim().length === 0
    ) {
      throw new Error("Cannot register a Scout Domain without a valid description.");
    }
    if (this.domains.has(description.id)) {
      throw new Error(`Scout Domain ${description.id} is already registered.`);
    }
    this.domains.set(description.id, domain);
    return domain;
  }

  get(id: ScoutDomainId): ScoutDomain {
    const domain = this.domains.get(id);
    if (!domain) throw new Error(`Scout Domain ${id} is not registered.`);
    return domain;
  }

  list(): ScoutDomain[] {
    return [...this.domains.values()];
  }

  unregister(domain: ScoutDomain): void {
    const id = domain.description.id;
    if (this.domains.get(id) !== domain) {
      throw new Error(`Cannot unregister inactive Scout Domain ${id}.`);
    }
    this.domains.delete(id);
  }
}
