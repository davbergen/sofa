# Field Notes persist as operational state in SQLite

Field Notes — the plain-text lists of changes David drags in while testing a
Project — are parsed into Items and stored in Sofa's SQLite store, keyed per
Project, along with each Item's acted status and a link to the Session it
spawned. This is so David can act on one Item, leave, and return later to the
next with his progress intact across restarts and browsers.

ADR 0002 says SQLite holds only operational state, never tracked work. Field
Notes do not violate that: they never reach GitHub, are never the source of
truth for a unit of work, and are upstream of the pipeline (a Field Note Item
becomes tracked work only once it is escalated into a Grilling Session → PRD →
Issue). What we persist is David's progress *through* the notes — the same
class of operational state as session history and Worker run records.

## Considered Options

- **Browser localStorage** — zero server/schema change and literally on disk,
  but tied to one browser profile on one machine, and offers no place to link
  an Item to the Session it spawned. The "leave and come back later" goal must
  survive a different machine, so this loses.
- **Sidecar file next to the note** (`<note>.sofa.json`) — portable and
  inspectable, but adds server filesystem read/write coupling and a
  parse-vs-saved-state sync problem with no upside over the store Sofa already
  owns.

## Consequences

- A new SQLite schema for Field Notes and Items. Per the repo convention,
  migrations are positional/count-based — append new entries at the end of the
  list, never reorder.
- Field Notes are no longer ephemeral. The dashboard can show, per Item, which
  past Session it produced.
- The operational-state / tracked-work boundary now runs *through* the
  pre-pipeline stage, not before it. The escalation of an Item into a Grilling
  Session is the line where work becomes tracked (and GitHub-owned).
