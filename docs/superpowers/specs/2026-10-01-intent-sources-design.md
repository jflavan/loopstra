# Intent sources: Slack, Discord and others

Status: proposal. Nothing here is built yet.

## Problem

Today an intent only enters Loopstra as a file: someone makes `intent/<slug>/intent.md`, fills in the template and sets `status: accepted`. Product owners often live in Slack or Discord, not in a git checkout. They should be able to ask for a change where they already talk, and hear back there when it needs them.

## What does not change

These design constants hold, and the proposal is shaped by them:

- **The repo is the queue and the state.** A message from Slack becomes an ordinary `intent/<slug>/intent.md`. Nothing about a change lives in Slack; the chat is only a door in and a window out.
- **A person always accepts.** A source only ever creates `draft` intents. Accepting stays a deliberate act (see "Accepting from chat" for the one opt-in exception and its limits).
- **Polling, no webhooks** (decisions.md, "Trigger cadence"). Loopstra runs on a laptop or a cron box with no public address, so sources are polled each tick, like GitHub is. No inbound server, no tunnel.
- **Deterministic first.** Fetching messages, deduplicating and replying are code. Only turning loose chat into the intent template is an agent phase, on the cheap model, read-only.
- **The owner surface stays plain.** Replies in chat are the same plain sentences the `note` line carries.

## Shape

A small adapter interface, one implementation per service, run from the tick:

```ts
interface SourceMessage {
  /** Stable across machines and restarts, e.g. "slack:C0123/1727780000.000100". */
  ref: string;
  author: string;          // display name, written to `author:`
  authorId: string;        // checked against the allow-list
  text: string;            // the message, plus thread replies when re-read
  link: string;            // permalink, written into the intent for engineers
  postedAt: Date;
}

interface IntentSource {
  name: string;                                          // the key under `sources:`
  /** Top-level messages newer than `cursor`, oldest first. */
  fetch(cursor: string | null): Promise<{ messages: SourceMessage[]; cursor: string | null }>;
  /** Plain-language reply in the message's thread. Best effort. */
  reply(ref: string, text: string): Promise<void>;
  /** Optional: who reacted with the accept emoji, for `accept_by_reaction`. */
  acceptedBy?(ref: string): Promise<string[]>;
}
```

### Each tick

A new step in `tick()` right after `syncMain` and before the scan, so a new draft shows in the same tick's queue:

1. **Fetch.** For each configured source, `fetch` from the cursor in `.loopstra/sources/<name>.json`. A failure (network, bad token) is traced once per distinct problem and shown in "Needs attention" as a settings problem; it never stops the tick, like `main_sync`.
2. **Filter.** Drop messages from anyone not in `allow` (when set), bot messages, and thread replies. Only top-level messages in the configured channel(s), or messages that mention the bot, start an intent.
3. **Deduplicate.** The durable key is a new runtime-managed frontmatter field, `source: slack:C0123/1727780000.000100`. Before drafting, scan existing intents for that `source`. The cursor in `.loopstra/` is only an optimisation: two machines, a lost `.loopstra/`, or a reset cursor never open the same intent twice, because the key is in git.
4. **Draft.** A new `draft-intent` phase (cheap model, read-only, `tools: "read"`) gets the message text and the template, and returns structured output: slug, title, Problem, Proposed outcome, Done when, Affected users, Constraints, Open questions. It may read the repo to use the right names for things. The runtime writes the file (agents propose, the runtime writes), with `status: draft`, `author`, `opened`, `source`, and a `note` saying where it came from. When the message is too thin to fill Problem / Proposed outcome / Done when, the phase leaves them as its best reading and puts what is missing under Open questions; the draft is still opened, so nothing typed in chat is lost.
5. **Commit.** One bookkeeping commit per new intent, `loopstra(<slug>): open intent from slack [skip ci]`, the same path `openFailureIntent` in `signals.ts` already uses.
6. **Reply.** In the message's thread: "I wrote this up as add-csv-export. Read it at <link to intent.md on GitHub>, then set its status to accepted when it's right." Without a remote there is no link; the reply names the file.

The draft phase costs money, so it runs at most `max_new_per_tick` (default 3) per source per tick, and counts toward the daily cost shown in the dashboard like any other phase.

### Telling chat what happened

The useful half is the window out. After the step, for each intent with a `source`, compare its status with the last one announced (kept in the trace as a `source-reply` event) and reply in the thread when it moved to something a person cares about:

| Status reached | Reply |
| --- | --- |
| `blocked` | The `note`, verbatim. It is already written for this reader. |
| `spec-review`, `plan-review`, `merge-review`, `verifying` with a person on the gate | What to do, as `intent/README.md` says it. |
| intake left a `question` | The question. |
| `merged` | "This is in the main code now." plus the PR link. |
| `done` | "Done." plus the first lines of `outcome.md`. |

Statuses the loop passes through on its own (`designing`, `building`, ...) are not announced, to keep threads quiet. `sources.<name>.announce` can widen or narrow the list.

### Accepting from chat

Off by default. With `accept_by_reaction: "white_check_mark"` and an `acceptors` list, a reaction from an acceptor on the original message sets a `draft` that came from that message to `accepted`, through `writeIntent` with `expectStatus: "draft"` so a person's edit in the meantime wins. This is the only path where a status is set from outside the file, so it is narrow: one emoji, one transition, named people only, and traced with who did it. Everything else (approving a spec, unblocking) stays in the file, where the person can see what they are approving.

Thread replies are not applied to the intent automatically. A reply to a drafted intent's thread is appended under "## From the thread" in `intent.md` only while it is still `draft`, so the owner's later clarifications land before they accept. After acceptance the file is the record.

## Config

New optional block in `loopstra/config.yaml`, validated like the rest. Tokens never go in the file (it is committed); each source names the environment variable that holds its token.

```yaml
sources:
  slack:
    type: slack
    token_env: LOOPSTRA_SLACK_TOKEN    # bot token: channels:history, chat:write, reactions:read
    channels: [C0123ABCD]              # ids, not names: names change
    allow: [U01AAA, U01BBB]            # who may open intents; empty means anyone in the channel
    accept_by_reaction: null           # e.g. white_check_mark
    acceptors: []
    max_new_per_tick: 3
  discord:
    type: discord
    token_env: LOOPSTRA_DISCORD_TOKEN  # bot token; needs the Message Content intent
    channels: ["1234567890"]
    allow: []
```

`loopstra start` preflight checks each source's `token_env` is set and that one cheap API call works, and refuses with a plain message otherwise, as it does for `gh`.

## Services

- **Slack.** Web API over `fetch`, no SDK: `conversations.history` with `oldest=<cursor>` for new messages, `conversations.replies` for a thread, `chat.postMessage` with `thread_ts` to reply, `reactions.get` for acceptance, `chat.getPermalink` for the link. Rate limits are generous for one call per channel per minute; a 429 honours `Retry-After` by skipping the source until then.
- **Discord.** REST only, no gateway connection: `GET /channels/{id}/messages?after=<snowflake>`, `POST /channels/{id}/messages` with `message_reference` to reply (or start a thread on the message), `GET .../reactions/{emoji}`. Reading message text needs the privileged Message Content intent turned on for the bot; preflight explains that when content comes back empty.
- **GitHub Issues** (cheap follow-on). `gh` is already required with a remote, so an `issues` source with a label filter (`loopstra`) needs no new credentials, and replies become issue comments. It is a good first adapter to build the interface against, because the test suite already fakes `gh`.

## Safety

A chat message becomes the text a build session acts on. That is the main risk.

- Only `draft` is ever created; a person reads it before it does anything, unless reaction-accept is on, where the acceptor list is the control.
- `allow` restricts who can open intents. Public Discord servers should always set it.
- The draft phase is read-only and gets the message inside a clearly delimited block marked as the requester's words, not instructions.
- Nothing from chat goes into a shell command, a branch name or a path except the slug, which the runtime checks against `SLUG` and de-duplicates.
- Replies only ever carry text already meant for the owner (notes, questions, links). No trace output, no command output.

## Testing

Same approach as the `claude` and `gh` fakes: each adapter takes a base URL from an environment variable (`LOOPSTRA_SLACK_API`, `LOOPSTRA_DISCORD_API`), and tests point it at a `Bun.serve` stub that records calls. Cases: dedupe across a lost cursor, allow-list, thin message still opens a draft with questions, one reply per status transition, a person's edit beats a reaction-accept, token missing at preflight, 429 back-off, source failure never stops the tick.

## Rollout

1. Interface, `source` frontmatter field, cursor store, draft phase and announce logic, with a GitHub Issues adapter.
2. Slack adapter.
3. Discord adapter.
4. Reaction acceptance, behind its config flag.

## Open questions

- Should drafting be per message, or should a short thread be collected first (wait N minutes of quiet before drafting)? Per message is simpler; collecting gives the agent more to go on.
- Should a source also be able to close an intent (e.g. a reaction of ❌ from an acceptor), or is that one transition too many from outside the file?
- Is a local machine polling Slack every `poll_seconds` acceptable to the workspace admins, or do some teams need a hosted relay? A relay is out of scope for v1 (non-goal: hosted service).
