// The site's docs print the regions of this file (docs/public/react/hooks.md), so
// `bun run typecheck` compiles what the pages show.
import { Box, Computed, Realm } from "@frondruntime/pinna";
import { RealmProvider, useRealm, useSelect, useValue, useValues } from "@frondruntime/pinna-react";
import { memo, useDeferredValue, useState } from "react";

// #region setup
const realm = Realm.make();
const $first = Box.make(realm, "Ada");
const $last = Box.make(realm, "Lovelace");
const $starred = Box.make<ReadonlyArray<string>>(realm, []);
const $query = Box.make(realm, "");
const names: ReadonlyArray<string> = ["Ada", "Grace", "Barbara"];
// #endregion

// #region useValue
const FirstName = memo(function FirstName() {
  const first = useValue($first);
  return <span>{first}</span>;
});
// #endregion

// #region useValues
function FullName() {
  const [first, last] = useValues([$first, $last]);
  return (
    <span>
      {first} {last}
    </span>
  );
}
// #endregion

// #region useSelect
function Star({ id }: { readonly id: string }) {
  const starred = useSelect((read) => read($starred).includes(id));
  return <span>{starred ? "★" : "☆"}</span>;
}
// #endregion

// #region local
function Draft() {
  const local = useRealm();
  const [$text] = useState(() => Box.make(local, ""));
  const text = useValue($text);
  const onChange = (value: string) => {
    Realm.update(local, (_read, write) => {
      write($text, value);
    });
  };
  return <input value={text} onChange={(event) => onChange(event.target.value)} />;
}
// #endregion

// #region handler
function SaveButton() {
  // A handler reads without subscribing; the component does not rerender for it.
  const onClick = () => {
    const first = Realm.untracked(realm, (read) => read($first));
    console.log("saving", first);
  };
  return (
    <button type="button" onClick={onClick}>
      Save
    </button>
  );
}
// #endregion

// #region deferred
// Under `memo`, the results skip the urgent render, which still passes them the old `query`.
const Results = memo(function Results({ query }: { readonly query: string }) {
  const found = names.filter((name) => name.includes(query));
  return (
    <ul>
      {found.map((name) => (
        <li key={name}>{name}</li>
      ))}
    </ul>
  );
});

function Search() {
  const query = useValue($query);
  const deferred = useDeferredValue(query);
  const onChange = (value: string) => {
    Realm.update(realm, (_read, write) => {
      write($query, value);
    });
  };
  return (
    <>
      <input value={query} onChange={(event) => onChange(event.target.value)} />
      <Results query={deferred} />
    </>
  );
}
// #endregion

// #region status
const $saving = Box.make(realm, false);

// Reads $saving alone: a change of status rerenders this line, not the list.
const SavingStatus = memo(function SavingStatus() {
  const saving = useValue($saving);
  return <p>{saving ? "Saving…" : "Saved"}</p>;
});

const NameList = memo(function NameList({ names }: { readonly names: ReadonlyArray<string> }) {
  return (
    <ul>
      {names.map((name) => (
        <li key={name}>{name}</li>
      ))}
    </ul>
  );
});

// `names` is made once, in module code, so NameList gets the same array on
// every render and `memo` skips it. `names.filter(...)` here would hand it a
// new array each time.
function Panel() {
  return (
    <>
      <SavingStatus />
      <NameList names={names} />
    </>
  );
}
// #endregion

// #region display
interface Quote {
  readonly symbol: string;
  readonly price: number;
  readonly receivedAt: number;
}

const $quote = Box.make<Quote>(realm, { symbol: "ACME", price: 10, receivedAt: 0 });

// What the card shows. Each recompute builds a new object, so `equals`
// compares the shown fields: a tick that changes only `receivedAt` keeps the
// previous object, and the card does not rerender.
const $quoteCard = Computed.make(
  realm,
  (read) => {
    const quote = read($quote);
    return { symbol: quote.symbol, price: quote.price.toFixed(2) };
  },
  { equals: (previous, next) => previous.symbol === next.symbol && previous.price === next.price },
);

const QuoteCard = memo(function QuoteCard() {
  const card = useValue($quoteCard);
  return (
    <p>
      {card.symbol} {card.price}
    </p>
  );
});
// #endregion

// #region provider
function App() {
  return (
    <RealmProvider realm={realm}>
      <FullName />
      <Star id="pinna" />
      <Draft />
      <SaveButton />
    </RealmProvider>
  );
}

// #endregion

export {
  $quote,
  $quoteCard,
  $saving,
  App,
  FirstName,
  NameList,
  names,
  Panel,
  QuoteCard,
  realm,
  Search,
};
