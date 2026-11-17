import type { APIRoute } from "astro";
import { renderLlmsIndex, textResponse } from "../lib/llms";

export const prerender = true;

export const GET: APIRoute = async () => textResponse(await renderLlmsIndex());
