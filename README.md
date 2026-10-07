# Draft Tracker

An MTG Arena draft companion for macOS and Windows. It watches Arena's log
while you draft, remembers every card you were shown at every pick, and saves
the finished draft — deck and all — so you can go back through it later.

- **Live** — the pack you are looking at right now, updating as Arena writes it.
- **The wheel** — picks 9 and later show the pack you *opened*, with the cards
  other players took greyed out. That window is the only place in a draft where
  you can see what the rest of the table is doing.
- **History** — step back through earlier picks mid-draft, or replay a draft
  from months ago one pick at a time.
- **Saved** — every finished draft is written to disk and listed in History,
  including the 40-card deck you submitted.

## Running it

```sh
make run            # pnpm install, build, launch
```

or, by hand:

```sh
pnpm install
pnpm build
pnpm start          # launches the Electron app
```

`pnpm start` runs the built app. For UI work there is a browser mode that needs
neither Arena nor Electron:

```sh
make dev            # http://localhost:5183, driven by a bundled sample draft
```

Run `make help` for the rest (tests, typecheck, icons, fixture, screenshots).

Only one copy of the app can run at a time — a second launch focuses the
existing window instead of starting a rival tracker on the same log.

## How it works

Arena writes a plain-text log at
`~/Library/Logs/Wizards Of The Coast/MTGA/Player.log` (macOS) or
`%USERPROFILE%\AppData\LocalLow\Wizards Of The Coast\MTGA\Player.log`
(Windows). Two lines in it carry everything this app needs:

```
[UnityCrossThreadLogger]Draft.Notify {"draftId":"…","SelfPick":1,"SelfPack":1,"PackCards":"106394,106418,…"}
[UnityCrossThreadLogger]==> EventPlayerDraftMakePick {"id":"…","request":"{\"DraftId\":\"…\",\"GrpIds\":[106333],\"Pack\":1,\"Pick\":1}"}
```

`Draft.Notify` is the pack as it was handed to you — the *cards seen*.
`EventPlayerDraftMakePick` is the card you took. Correlating them by
`draftId` + `(pack, pick)` gives a complete record of the draft.

The log is replayed from the beginning on every launch. That is what makes
recovery work: start the app halfway through pack 2 and everything up to that
point is rebuilt before the live tail takes over. It also means every mutation
has to be idempotent, and there are tests that assert exactly that.

Drafts end on `DraftCompleteDraft` (or a `DeckSelect` course, or — as a net for
formats that emit neither — a one-card final pack). The submitted deck arrives
separately in `EventSetDeckV3`, sometimes minutes later, and is attached to the
already-saved draft.

## Reading the wheel

At an eight-player table your first pick comes back to you as pick nine: you
opened it with 14 cards, and eight picks later six remain. So picks 9+ are the
only ones where the app can say *who took what* rather than just what is left.
It shows the original pack, greys out everything that left it, and marks the
one card that was yours rather than calling it an opponent's.

The table size is detected from the packs themselves, not assumed to be eight —
a draft can be six- or ten-player and Arena's log never says which. Detection
matters more than it sounds: because every pack loses exactly one card per
pick, the *size* difference between any two picks is always their distance, so
sizes carry no information at all. Only the subset test does, and that gets
ambiguous once a pack is down to a card or two — in a real draft the final pick
had three earlier picks whose cards happened to contain it. Pooling the
evidence across the whole pack separates the true offset (18/18 pairs on the
captured log) from the coincidences (≤13%).

Pack cards are sorted rarest first, basic lands last, so a pack is worth
scanning; Arena's own order is kept within each rarity.

## Card data

Card ids in the log are Arena `grpId`s, which have to be turned into names and
art. Two sources are layered, because neither is sufficient alone:

1. **Arena's own card database** — MTGA ships `Raw_CardDatabase_*.mtga`, which
   is a plain SQLite file, read directly with Node's `node:sqlite`. It takes
   about 70 ms, needs no network, and is current on the day a set releases.
   It has no art and no mana costs.
2. **Scryfall bulk data** — a one-time ~79 MB download, run in the background
   on first launch, cached and re-read instantly afterwards. It supplies mana
   costs and card images.

The two are matched by **`arena_id`, and failing that by set code plus
collector number**. That second key matters: Scryfall publishes a set at
prerelease but doesn't attach Arena ids until days later, so during exactly the
window people are drafting a new set, every lookup by grpId misses even though
Scryfall has the card and its art. The Arena database carries the set and
collector number right next to every grpId, so the fallback costs nothing. It
is not only new sets either — on this machine it resolves cards across FRA,
MH3, OM1, FIN, FIC and TDM.

Printings without an `arena_id` are indexed by that second key, **scoped to the
keys Arena's own database references**. Unscoped the index is ~118,000 entries
and a 42 MB cache; scoped it is ~3,600 and the cache stays at ~7 MB. The cache
records a fingerprint of the key set it was built for, so it rebuilds itself
when Arena's card pool changes.

So the app is fully usable within a second of launch, and quietly gains art as
the download completes. Cards with no art yet render as typographic cards
rather than blanks.

## Where things are saved

| What | Where |
| --- | --- |
| Drafts | `~/Library/Application Support/Draft Tracker/drafts/<draftId>.json` |
| Draft in progress | `…/drafts/in-progress.json` (cleared once the draft ends) |
| Card cache | `…/card-data/cards.json` |

One JSON file per draft, written via temp-file-and-rename. Writes are also
serialized, because a draft finishing fires several saves at once. The files
are plain JSON and readable — "Show file" in History opens one in Finder.

## Layout

```
packages/core     shared types and pure draft helpers
packages/arena    log tailer, line assembler, draft parser, draft state machine
packages/cards    MTGA's SQLite card database + the Scryfall bulk download
apps/desktop      Electron main process, preload bridge, draft storage
apps/web          React UI (also runs standalone in a browser)
```

The dependency direction is one-way: `core` ← `arena`/`cards` ← `desktop`, and
the UI talks to the main process only through the `DraftTrackerBridge` interface
in `packages/core/src/bridge.ts`, which main, preload and renderer all import.

## Keyboard

| Key | |
| --- | --- |
| `←` / `→` | previous / next pick |
| `↑` / `↓` | previous / next pack |
| `End` | jump back to the live pick |

The pick rail marks wheel picks with a ↩, and each pack shows how many picks
have been made out of it.

Navigating away from the newest pick stops auto-follow; "Jump to latest"
resumes it.

## Development

```sh
make check          # typecheck + tests
make build
```

Useful scripts:

```sh
# Screenshot the UI in Electron (writes .screenshots/)
make screenshots

# Regenerate the browser-mode sample draft from a real captured log
make fixture

# Redraw the app icons
make icons
```

## Packaging

```sh
pnpm --filter @drafttracker/desktop package:mac
pnpm --filter @drafttracker/desktop package:win
```

## License

Copyright © 2026 minimaple.

Draft Tracker is free software: you can redistribute it and/or modify it under
the terms of the GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version. See [LICENSE](LICENSE) for the full text.

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE.

Draft Tracker is unofficial Fan Content permitted under the Fan Content Policy.
Not approved or endorsed by Wizards of the Coast. Portions of the materials used
are property of Wizards of the Coast. ©Wizards of the Coast LLC. Magic: The
Gathering and MTG Arena are trademarks of Wizards of the Coast LLC.

Card data is fetched at runtime from [Scryfall](https://scryfall.com) and from
the copy of the card database that MTG Arena installs locally; none of it is
bundled except a small sample used by the browser-mode dev fixture.

## Notes and limitations

- Windows card-database discovery is best-effort; the app falls back to
  Scryfall-only, and then to raw grpIds, rather than failing.
- Picks made before the app was first launched are only visible if Arena's log
  still contains them. Arena truncates the log on launch, so a draft from a
  previous Arena session can't be recovered — but once this app has seen a
  draft, it keeps it forever.
- Arena's log format is not a public API. The parser is written to tolerate
  missing fields and field-name variants (`SelfPick` vs `Pick`, singular
  `Course` vs `Courses`, and so on), and never throws on a bad line.
