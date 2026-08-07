/**
 * Public environment capabilities shared by startup and resume stages. The
 * stages retain lifecycle ordering and persistence policy; this boundary
 * exposes only environment inspection, preparation, validation, and assembly.
 */
export * from "./role-builder.js";
export * from "./role-runner.js";
export * from "./planner.js";
export * from "./snapshot-loader.js";
export * from "./metadata.js";
export * from "./runtime-builder.js";
export * from "./types.js";
