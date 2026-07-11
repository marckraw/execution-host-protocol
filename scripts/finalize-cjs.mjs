import { writeFile } from "node:fs/promises";

const dist = new URL("../dist/", import.meta.url);

await writeFile(new URL("cjs/package.json", dist), '{"type":"commonjs"}\n');
await writeFile(
  new URL("index.cjs", dist),
  "module.exports = require('./cjs/index.js')\n",
);
