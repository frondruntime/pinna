import { docsCollection } from "@frondruntime/site-kit/collection";

/** The docs pages, copied from `docs/public` by `bun run sync`. */
export const collections = { docs: docsCollection() };
