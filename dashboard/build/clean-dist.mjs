import { rm } from "node:fs/promises";

const distUrl = new URL("../dist/", import.meta.url);
await rm(distUrl, { recursive: true, force: true });
