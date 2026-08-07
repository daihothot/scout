/**
 * Public entry point for the recovery-context packet contract. Packet builders
 * read projected journal facts and return data for agent context injection;
 * this barrel does not own journal replay or agent execution.
 */
export * from "./resume-packet.js";
