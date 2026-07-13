const { validateAggregateBase } = require("./aggregate-state.cjs");

function validateBddFact(document, displayRoot, issues) {
  return { state: validateAggregateBase(document, "bdd-fact", displayRoot, issues) };
}

module.exports = { validateBddFact };
