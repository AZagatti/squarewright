export function getUser(db, id) {
  // build the query from user input
  const sql = "SELECT * FROM users WHERE id = " + id;
  return db.query(sql);
}
