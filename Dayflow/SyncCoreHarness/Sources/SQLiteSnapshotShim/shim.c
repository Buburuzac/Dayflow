// Inert stand-ins for the SQLite snapshot API, which Ubuntu's libsqlite3 is built without but
// GRDB references (DatabaseSnapshotPool / WALSnapshot). The sync core never uses snapshots.
// Linux only; elsewhere this file is empty.
#include "shim.h"

#if defined(__linux__)
int sqlite3_snapshot_get(void *db, const char *schema, void **out) { (void)db; (void)schema; if (out) *out = 0; return 1; }
int sqlite3_snapshot_open(void *db, const char *schema, void *snapshot) { (void)db; (void)schema; (void)snapshot; return 1; }
void sqlite3_snapshot_free(void *snapshot) { (void)snapshot; }
int sqlite3_snapshot_cmp(void *a, void *b) { (void)a; (void)b; return 0; }
#endif

int dayflow_sqlite_snapshot_shim(void) { return 0; }
