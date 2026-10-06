import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { lagApi } from "./api.js";
import { kjorOppgave, lagWorker } from "./worker.js";
import { settLokalOppgavekjorer } from "./tjenester.js";

// Samme bilde kjører både API og worker; ROLLE (satt av Terraform) bestemmer hvilken.
const app = config.rolle === "worker" ? lagWorker() : lagApi();

// Lokalt finnes ingen Cloud Tasks; da sendes fakturaen med en gang.
if (!config.tasksKo && !config.produksjon) settLokalOppgavekjorer(kjorOppgave);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(JSON.stringify({ severity: "INFO", message: `faktura-${config.rolle} lytter på ${info.port}` }));
});
