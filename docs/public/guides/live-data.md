---
title: Live data
description: Read when state comes from a socket or a server. Open a socket while a value is observed and reconnect after a drop, write each message in one update, refetch without losing row identity, and run the same feed as an Effect stream.
---

## Example

A quote feed keeps one row per symbol, written from a WebSocket. The server
sends a snapshot of every quote when the socket opens, then one change per
message. Without Effect, the boundary checks each message by hand: the parser
builds new objects with the fields a quote has, and returns `undefined` for
anything else.

<!-- region liveData.ts#message -->

The model opens the socket while something observes it. A row read through
`row(key)` tracks that key alone and never reads `keys`, so a hook on `keys`
would miss a reader of one row. A private atom stands for the socket instead,
and `$status`, `$symbols`, and the computed values of `quote(symbol)` read
it. The first observer of any of them runs `connect`; the last one leaving
runs its cleanup, which closes the socket and cancels a pending reconnect.

<!-- region liveData.ts#feed -->

Anything that observes one of them opens the socket: a watch, an
autorun, `observe`, or a mounted `useValue(feed.$symbols)`.

<!-- region liveData.ts#observe -->

A request is the same shape without a socket. An `AbortController` cancels a
request a newer one replaces, and `reconcile` keeps each unchanged row's
instance, so a refetch that changed nothing notifies nobody. The parser
reuses `isRecord` and `isPrice` from the first sample, and throws, so a body
that does not fit ends in `"failed"`.

<!-- region liveData.ts#fetch -->

## Rules

- Write each message in one update. An update is atomic, so a reader sees a
  snapshot whole or not at all; a write per row would show readers every
  row in between.
- Write a snapshot through `write.replaceAll` on a collection with `equals`.
  A row equal to the one held keeps its instance and notifies nobody, so a
  reconnect that sends the same quotes reruns no row's reader.
- Reject a snapshot that repeats a key at the boundary. `write.replaceAll`
  throws on a repeated key and writes nothing.
- Await the request, then write its result in an update of its own: an
  update is synchronous ([Updates](../state/updates.md)).
- Check that a request was not aborted before writing its result or its
  failure. A newer request aborts the older one, and an aborted `fetch`
  rejects; without the check, the older request's failure overwrites the
  newer one's `"loading"`.
- A hook may write, in an update; `connect` writes `"connecting"` from it.
  The cleanup writes nothing, so rows and status stay as last written while
  nothing observes the feed, and the next snapshot replaces the rows.
- Keep a connection's state inside the call that opens it, and detach the
  socket's `onclose` before closing it. A socket from an earlier observation
  then schedules no reconnect.
- A message the boundary drops goes to the host's `reportError`, which is
  also where a realm made without `onError` reports. A realm made with
  `onError` does not see it.

## Answers

| Call | Answers |
| --- | --- |
| `onObserved($atom, start)` | Runs `start` on the first observer of the atom, through any computed value that reads it, and its cleanup after the last. |

The writes to a collection are on [Collections](../state/collections.md),
and `reconcile` on [Updates](../state/updates.md).

## With Effect

The same feed as an Effect program. `Schema.fromJsonString` parses and
checks a message in one step, and fails with a `SchemaError` for anything
that does not fit.

<!-- region liveDataEffect.ts#schema -->

The board checks the watchlist on every write: people type it, and it is
saved with the board. The quotes are a plain collection and the status a
plain box, written by the feed alone from messages the decode checked.

<!-- region liveDataEffect.ts#board -->

`Stream.callback` turns the socket's callbacks into a stream. The socket
opens in `Effect.acquireRelease`, so closing the stream's scope closes it,
and a drop fails the stream with `SocketClosed`.

<!-- region liveDataEffect.ts#socket -->

`changes` streams the watchlist. `Stream.switchMap` interrupts the socket of
the previous list, which closes it, and opens one for the new list.
`Stream.retry` reopens the socket after a drop on the schedule; the schedule
resets once a message passes through. Each message is decoded, then written
in one update; a message that fails either step is logged and dropped.

<!-- region liveDataEffect.ts#program -->

A layer provides the realm. The socket is open while the fiber runs, not
while something observes the board, and interrupting the fiber closes it.

<!-- region liveDataEffect.ts#run -->

- Decode once, at the boundary. The decode checked every quote, so the rows
  go into a plain `collection` that checks nothing again. A
  `CollectionField` checks each row it writes on every write; for quotes
  written many times a second, that is the same check repeated.
- Use a `CollectionField` or a `BoxField` for state that changes rarely or
  that untrusted code writes: the watchlist, a form, a list a person edits.
  The check runs where the bad value comes in.
- Never loosen a field's schema to make a hot feed fast: every other writer
  of that field then writes unchecked. Move the hot rows to a plain
  collection and keep the check at the decode.
- Wrap the write in `Effect.try`. A write that throws inside `Effect.sync` is
  a defect, and a defect in `Stream.runForEach` ends the program, socket and
  all. `Effect.try` turns it into an error the program logs; the update has
  already undone the write.
- Write each status change in the stage that knows it: `Stream.onStart` for
  `"connecting"`, the socket's `onopen` for `"open"`, and `Stream.tapError`,
  before `Stream.retry`, for `"closed"`. Without the `Stream.tapError`, the
  status stays `"open"` through every reconnect wait.

### Owners

The feed above is owned by its fiber: the socket stays open with nothing
observing the quotes, and only interrupting the fiber stops the feed. A
change of watchlist or a dropped connection closes one socket and opens the
next, as the sample shows. A `fromStream` value is
owned by observation instead: its stream runs from the first observer to
the last, so the socket opens when a component, a watch, or a test holds the value
observed, and closes when the last observer leaves.

- A fiber owns a feed whose data is kept whether shown or not, such as the
  quotes of the board, which several screens and watches read from one
  collection.
- Observation owns one value that a screen shows, such as a rate in a
  header. The stream costs nothing while nothing observes the value, and
  the value resets to `initial` when the last observer leaves, so a stale
  rate never shows as current.

A command, such as an order placed from the board, is owned by neither: it
runs in the application's scope until it ends. [Programs](../effect/programs.md#lifetimes)
shows each owner and the services a `fromStream` stream runs with.

## See also

- [Lifecycles](../state/lifecycles.md): `onObserved`, atoms, and `observe`.
- [Collections](../state/collections.md): `keys`, `row(key)`, and `equals`.
- [Updates](../state/updates.md): what an update undoes when it throws.
- [Programs](../effect/programs.md): `changes`, `watchScoped`, and `fromStream`.
- [Classes](../effect/classes.md): `SchemaModel`, `BoxField`, and `decode`.
- [Collection fields](../effect/collections.md): a collection that checks each row.
- [Hooks](../react/hooks.md): `useValue` and a list that rerenders one row.
