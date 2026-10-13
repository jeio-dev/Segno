# Events are versioned and never rewritten

Every Event carries `type`, `v` (its schema version), `seq` (a gap-free sequence) and `ts`. Events and Verdicts are kept forever, so the reducer must handle every historical version of every Event type. Changing an Event's shape means adding a new version, never migrating old rows.
