// Builds the SET part of an UPDATE from the fields that were sent. Column names come only from
// the columns map, never from the request. Values start at $2, because $1 is the row id.
function buildAssignments(fields, columns) {
  const assignments = [];
  const values = [];
  for (const [field, column] of Object.entries(columns)) {
    if (fields[field] !== undefined) {
      values.push(fields[field]);
      assignments.push(`${column} = $${values.length + 1}`);
    }
  }
  return { assignments: assignments.join(", "), values };
}

module.exports = buildAssignments;
