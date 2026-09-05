import { readFile, writeFile } from "node:fs/promises";

const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID;
if (!databaseId || !/^[a-f0-9-]{30,40}$/i.test(databaseId)) {
  throw new Error("CLOUDFLARE_D1_DATABASE_ID ausente ou inválido.");
}

const templateUrl = new URL("../wrangler.template.jsonc", import.meta.url);
const outputUrl = new URL("../wrangler.generated.jsonc", import.meta.url);
const template = await readFile(templateUrl, "utf8");
await writeFile(outputUrl, template.replace("__D1_DATABASE_ID__", databaseId));
