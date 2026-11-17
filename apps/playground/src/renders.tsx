import { useRef } from "react";

/** Shows how many times the enclosing component has rendered. */
export const useRenders = (): number => {
  const renders = useRef(0);
  renders.current++;
  return renders.current;
};

export const Renders = ({ count }: { readonly count: number }) => (
  <span className="renders" title="renders">
    {count}
  </span>
);
