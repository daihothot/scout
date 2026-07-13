function addIssue(issues, code, path, message) {
  issues.push({ code, path, message });
}

module.exports = { addIssue };
