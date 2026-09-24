# hello-agent

The worked example of the [`codespar-agent-builder`](../../skills/codespar-agent-builder)
skill, and the smallest agent the kit can carry. It reads the month's bills
and answers questions about them. It cannot pay, and that is the point.

A CodeSpar agent is its manifest, its prompt, its tools, its guardrails, its
mandate and its packs. The runner is shared
([`@codespar/agent-runtime`](../../packages/agent-runtime)), so the only code
here is `src/kit.ts` and one fixture.

The tool list is closed: the seven adversarial cases play a model that obeys
the attack and calls `codespar_pay`, `codespar_wallet` or
`codespar_manage_connections`. Every call is refused before any handler runs,
no execution exists, and the refusal is in the trail.

```sh
npm install                                     # at the repository root
npm start --workspace=agents/hello-agent -- --input "quais contas vencem em outubro?" --json
npm run check --workspace=agents/hello-agent
npm run eval --workspace=agents/hello-agent
```

No key is needed: with `ANTHROPIC_API_KEY` empty the run replays the
recorded conversation, the agent reaches no rail, and `maturity` is empty.
