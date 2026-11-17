// Stand-ins for an application's own components, so a landing sample shows what Pinna adds and
// not markup: the hero draws its todos as an SVG frond, not as a list (todo.tsx).
import type { ReactNode } from "react";

function ListItem({
  children,
  onPress,
}: {
  readonly children: ReactNode;
  readonly onPress: () => void;
}) {
  return (
    <li>
      <button type="button" onClick={onPress}>
        {children}
      </button>
    </li>
  );
}

export { ListItem };
