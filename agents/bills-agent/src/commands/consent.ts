/**
 * `npm run consent`: starts the hosted consent for a new mandate with the
 * test key, waits for the consumer's signature, stores the mandate locally
 * and credits the sandbox account. Module `embedded-consent`.
 */
import { resolve } from "node:path";
import { stderr } from "node:process";
import { createCodeSparClient, loadMandate } from "@codespar/agent-core";
import { runEmbeddedConsent } from "../modules/embedded-consent.js";
import { AGENT_DIR, MANDATE_PATH, readDotEnv } from "../setup.js";

readDotEnv();
const say = (l: string) => stderr.write(l + "\n");
const api = createCodeSparClient({ apiKey: process.env["CODESPAR_API_KEY"], baseUrl: process.env["CODESPAR_API_URL"], projectId: process.env["CODESPAR_PROJECT_ID"] });
const example = loadMandate(resolve(AGENT_DIR, "mandate.example.json"));
const mandate = await runEmbeddedConsent({ api, example, mandatePath: MANDATE_PATH, say });
say(`mandato ${mandate.id} salvo em .codespar/mandate.json`);
