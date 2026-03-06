const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./database/senorito.db', (err) => {
  if (err) return console.error('Open DB error:', err.message);
  console.log('DB opened');
});

db.serialize(() => {
  db.run('PRAGMA wal_checkpoint(TRUNCATE);', (err) => {
    if (err) console.error('Checkpoint error:', err.message);
    else console.log('WAL checkpoint done');
  });
});

db.close((err) => {
  if (err) console.error('Close DB error:', err.message);
  else console.log('DB closed');
});