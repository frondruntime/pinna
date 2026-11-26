---
title: Live data
description: Read when state comes from a socket or a server. Open a socket while a value is observed and reconnect after a drop, write each message in one update, refetch without losing row identity, and run the same feed as an Effect stream.
---

## Example

A quote feed keeps one row per symbol, written from a WebSocket. The server
sends a snapshot of every quote when the socket opens, then one change per
message. The parser checks each message by hand, builds new objects with
the fields a quote has, and returns `undefined` for anything else.

<!-- region liveData.ts#message -->

The socket is open while something observes the feed. A private atom stands
for the socket, and `$status`, `$symbols`, and each `quote(symbol)` read it,
so the first observer of any of them runs `connect`, and the last one
leaving runs its cleanup, which closes the socket and cancels a pending
reconnect. A hook on `keys` would miss a reader of one row: `row(key)` never
reads `keys`.

<!-- region liveData.ts#feed -->

A watch, an autorun, `Source.observe`, or a mounted `useValue(feed.$symbols)` opens
the socket.

<!-- region liveData.ts#observe -->

A request is the same shape without a socket. An `AbortController` cancels
the request a newer one replaces, and `Collection.reconcile` keeps each unchanged row's
instance, so a refetch that changed nothing notifies nobody. The parser
reuses `isRecord` and `isPrice` from the first sample and throws on a body
that does not fit, and the status ends in `"failed"`.

<!-- region liveData.ts#fetch -->

## Rules

- Write each message in one update. A reader then sees a snapshot whole or
  not at all; a write per row would show every row in between.
- Write a snapshot through `write.replaceAll` on a collection with `equals`.
  An unchanged row keeps its instance, so a reconnect that sends the same
  quotes reruns no reader. `write.replaceAll` throws on a repeated key and
  writes nothing, so reject one at the boundary.
- Await a request, then write its result in an update of its own: an update
  is synchronous ([Updates](../state/updates.md)).
- Check that a request was not aborted before writing its result or its
  failure. An aborted `fetch` rejects, and without the check the older
  request's failure overwrites the newer one's `"loading"`.
- The hook writes `"connecting"`, in an update. The cleanup writes nothing,
  so rows and status stay as last written while nothing observes the feed,
  and the next snapshot replaces the rows.
- Keep a connection's state inside the call that opens it, and detach the
  socket's `onclose` before closing it, so a socket from an earlier
  observation schedules no reconnect.
- A message the parser drops goes to the host's `reportError`, where a realm
  made without `onError` also reports. A realm made with `onError` does not
  see it.

`Source.onObserved` and atoms are on [Lifecycles](../state/lifecycles.md), the
writes to a collection on [Collections](../state/collections.md), and
`Collection.reconcile` on [Updates](../state/updates.md).

## With Effect

The same feed as an Effect program. `Schema.fromJsonString` parses and
checks a message in one step, and fails with a `SchemaError` for anything
that does not fit.

<!-- region liveDataEffect.ts#schema -->

The watchlist is a `Model.boxField`, checked on every write: people type it, and
it is saved with the board. The quotes are a plain collection and the status
a plain box, written only from messages the decode checked, so nothing checks
them twice ([Plain or schema boxes](../start/index.md#plain-or-schema-boxes)).
Loosening a field's schema to make the feed fast would leave every other
writer of that field unchecked; the hot rows go in a plain collection
instead.

<!-- region liveDataEffect.ts#board -->

`Stream.callback` turns the socket's callbacks into a stream. The socket
opens in `Effect.acquireRelease`, so closing the stream's scope closes it,
and a drop fails the stream with `SocketClosed`.

<!-- region liveDataEffect.ts#socket -->

`Program.changes` streams the watchlist, and `Stream.switchMap` closes the socket
of the previous list and opens one for the new list. `Stream.retry` reopens
the socket after a drop, and its schedule resets once a message passes
through. Each message is decoded, then written in one update; a message
that fails either step is logged and dropped.

<!-- region liveDataEffect.ts#program -->

A layer provides the realm. The fiber owns the feed: the socket is open
while the fiber runs, whether or not anything observes the board, and
interrupting the fiber closes it. A value that should run only while a
screen shows it is owned by observation instead, through `Program.fromStream`
([Programs](../effect/programs.md#lifetimes)).

<!-- region liveDataEffect.ts#run -->

- Wrap the write in `Effect.try`. A throw inside `Effect.sync` is a defect,
  and a defect in `Stream.runForEach` ends the program, socket and all.
  `Effect.try` makes it an error the program logs; the update has already
  undone the write.
- Write each status in the stage that knows it: `Stream.onStart` for
  `"connecting"`, the socket's `onopen` for `"open"`, and `Stream.tapError`,
  before `Stream.retry`, for `"closed"`. Without `Stream.tapError`, the
  status stays `"open"` through every reconnect wait.

## See also

- [Lifecycles](../state/lifecycles.md): `Source.onObserved`, atoms, and `Source.observe`.
- [Collections](../state/collections.md): `keys`, `row(key)`, and `equals`.
- [Updates](../state/updates.md): what an update undoes when it throws.
- [Programs](../effect/programs.md): `Program.changes`, `Program.watchScoped`, `Program.fromStream`, and who owns a feed.
- [Classes](../effect/classes.md): `Model.Schema`, `Model.boxField`, and `Model.decode`.
- [Hooks](../react/hooks.md): `useValue` and a list that rerenders one row.
